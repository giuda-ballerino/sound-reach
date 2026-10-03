/**
 * Glue between the elevation source and the terrain model: the impure half that fetches,
 * caches and debounces, so `terrain.ts` can stay pure and `main.ts` can stay DOM wiring.
 *
 * Two jobs:
 *  - receptors, automatically: one profile per receptor, recomputed as they are dragged;
 *  - zone contours, on request: a 36 × 60 polar grid around the stage, turned into a
 *    shielding-vs-(bearing, distance) lookup the contour tracer can bisect against.
 */

import type { Levels } from './acoustics';
import type { ElevationSource, FetchProgress } from './elevationSource';
import { destination, type LatLon } from './geo';
import {
  NO_SHIELDING,
  analyseProfile,
  sampleProfile,
  shieldingFor,
  type ProfilePoint,
  type ProfileSample,
  type ShieldingAnalysis,
} from './terrain';
import type { ShieldingAt } from './zones';

/** Spacing along a receptor profile. 30 m is finer than the DEM, which costs nothing. */
export const PROFILE_STEP_M = 30;

/** The zone grid: every 10° of bearing, 50 m steps out to 3 km. */
export const ZONE_BEARING_STEP_DEG = 10;
export const ZONE_BEARINGS = 360 / ZONE_BEARING_STEP_DEG;
export const ZONE_STEP_M = 50;
export const ZONE_RAY_POINTS = 60;
export const ZONE_RANGE_M = ZONE_STEP_M * ZONE_RAY_POINTS;

/** How long dragging has to pause before the profiles behind it are fetched. */
export const DEBOUNCE_MS = 300;

/** Receptor results kept around; enough for a long dragging session, bounded all the same. */
const RECEPTOR_CACHE_LIMIT = 600;
const ZONE_CACHE_LIMIT = 8;

export type TerrainStatus = 'pending' | 'ready' | 'failed';

export interface ReceptorTerrain {
  status: TerrainStatus;
  /** dB to subtract per band. Zeros unless `status` is 'ready'. */
  shielding: Levels;
  analysis: ShieldingAnalysis | null;
  profile: ProfilePoint[] | null;
}

const PENDING: ReceptorTerrain = Object.freeze({
  status: 'pending',
  shielding: NO_SHIELDING,
  analysis: null,
  profile: null,
});
const FAILED: ReceptorTerrain = Object.freeze({
  status: 'failed',
  shielding: NO_SHIELDING,
  analysis: null,
  profile: null,
});

interface PendingProfile {
  samples: ProfileSample[];
  sourceHeightM: number;
  receiverHeightM: number;
}

/** Stage positions this close together share a zone grid: 1e‑4° is about 10 m. */
function stageKey(stage: LatLon, sourceHeightM: number, receiverHeightM: number): string {
  return `${stage.lat.toFixed(4)},${stage.lon.toFixed(4)}|${sourceHeightM}|${receiverHeightM}`;
}

function receptorKey(stage: LatLon, point: LatLon, sourceHeightM: number, receiverHeightM: number): string {
  return `${stage.lat.toFixed(5)},${stage.lon.toFixed(5)}>${point.lat.toFixed(5)},${point.lon.toFixed(
    5,
  )}|${sourceHeightM}|${receiverHeightM}`;
}

function evict<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function lerp(a: Levels, b: Levels, f: number): Levels {
  return { la: a.la + (b.la - a.la) * f, lc: a.lc + (b.lc - a.lc) * f };
}

/** Shielding along one bearing at an arbitrary distance, between the 50 m samples. */
function alongRay(row: Levels[], distanceM: number): Levels {
  if (!(distanceM > 0)) return NO_SHIELDING;
  const t = distanceM / ZONE_STEP_M;
  const j = Math.floor(t);
  // Past the end of the grid the last ridge is assumed to keep shielding: once you are behind
  // a hill you stay behind it.
  if (j >= row.length) return row[row.length - 1];
  return lerp(j === 0 ? NO_SHIELDING : row[j - 1], row[j], t - j);
}

/** Bilinear lookup over the polar grid: nearest two bearings, nearest two distances. */
export function gridShielding(table: Levels[][]): ShieldingAt {
  return (bearingDeg, distanceM) => {
    const b = ((((bearingDeg % 360) + 360) % 360) / ZONE_BEARING_STEP_DEG) % table.length;
    const i0 = Math.floor(b);
    const i1 = (i0 + 1) % table.length;
    return lerp(alongRay(table[i0], distanceM), alongRay(table[i1], distanceM), b - i0);
  };
}

export class TerrainService {
  private readonly receptors = new Map<string, ReceptorTerrain>();
  private readonly wanted = new Map<string, PendingProfile>();
  private readonly zones = new Map<string, ShieldingAt>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly elevation: ElevationSource,
    /** Called once after a batch of profiles resolves, so the app can re‑render. */
    private readonly onUpdate: () => void,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  /**
   * Terrain shielding between the stage and one receptor, as far as it is known right now.
   * A miss schedules a fetch and returns 'pending'; `onUpdate` fires when it lands.
   */
  receptorTerrain(stage: LatLon, point: LatLon, sourceHeightM: number, receiverHeightM: number): ReceptorTerrain {
    const key = receptorKey(stage, point, sourceHeightM, receiverHeightM);
    const hit = this.receptors.get(key);
    if (hit) return hit;

    const samples = sampleProfile(stage, point, PROFILE_STEP_M);
    const elevations = this.elevation.cached(samples);
    if (elevations) {
      const ready = this.resolve(key, samples, elevations, sourceHeightM, receiverHeightM);
      return ready;
    }

    if (!this.wanted.has(key)) this.wanted.set(key, { samples, sourceHeightM, receiverHeightM });
    this.schedule();
    return PENDING;
  }

  /** The zone grid for this stage if it has already been built, otherwise null. */
  zoneShielding(stage: LatLon, sourceHeightM: number, receiverHeightM: number): ShieldingAt | null {
    return this.zones.get(stageKey(stage, sourceHeightM, receiverHeightM)) ?? null;
  }

  /**
   * Build (or reuse) the zone grid around a stage. Rejects with `ElevationError` if the API is
   * unreachable; the caller keeps the flat contours in that case.
   */
  async buildZoneShielding(
    stage: LatLon,
    sourceHeightM: number,
    receiverHeightM: number,
    onProgress?: FetchProgress,
  ): Promise<ShieldingAt> {
    const key = stageKey(stage, sourceHeightM, receiverHeightM);
    const hit = this.zones.get(key);
    if (hit) return hit;

    const rays: ProfileSample[][] = [];
    const points: LatLon[] = [stage];
    for (let i = 0; i < ZONE_BEARINGS; i++) {
      const bearing = i * ZONE_BEARING_STEP_DEG;
      const ray: ProfileSample[] = [];
      for (let j = 1; j <= ZONE_RAY_POINTS; j++) {
        const distanceM = j * ZONE_STEP_M;
        const p = destination(stage, bearing, distanceM);
        ray.push({ lat: p.lat, lon: p.lon, distanceM });
        points.push(p);
      }
      rays.push(ray);
    }

    const elevations = await this.elevation.elevations(points, onProgress);
    let read = 1;
    const table: Levels[][] = rays.map((ray) => {
      // Each ray is walked outwards, and the shielding at a distance is the Maekawa value for
      // the profile truncated there: the ridge you have passed keeps shielding you.
      const profile: ProfilePoint[] = [{ lat: stage.lat, lon: stage.lon, distanceM: 0, elevationM: elevations[0] }];
      return ray.map((sample) => {
        profile.push({ ...sample, elevationM: elevations[read++] });
        return shieldingFor(profile, sourceHeightM, receiverHeightM);
      });
    });

    const at = gridShielding(table);
    this.zones.set(key, at);
    evict(this.zones, ZONE_CACHE_LIMIT);
    return at;
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    const batch = [...this.wanted];
    if (!batch.length) return;
    this.wanted.clear();

    // One call for every profile at once, so the 100‑point batching is shared between them.
    const points = batch.flatMap(([, want]) => want.samples);
    try {
      await this.elevation.elevations(points);
    } catch {
      for (const [key] of batch) this.receptors.set(key, FAILED);
      evict(this.receptors, RECEPTOR_CACHE_LIMIT);
      this.onUpdate();
      return;
    }

    for (const [key, want] of batch) {
      const elevations = this.elevation.cached(want.samples);
      if (elevations) this.resolve(key, want.samples, elevations, want.sourceHeightM, want.receiverHeightM);
      else this.receptors.set(key, FAILED);
    }
    evict(this.receptors, RECEPTOR_CACHE_LIMIT);
    this.onUpdate();
  }

  private resolve(
    key: string,
    samples: ProfileSample[],
    elevations: number[],
    sourceHeightM: number,
    receiverHeightM: number,
  ): ReceptorTerrain {
    const profile: ProfilePoint[] = samples.map((s, i) => ({ ...s, elevationM: elevations[i] }));
    const analysis = analyseProfile(profile, sourceHeightM, receiverHeightM);
    const result: ReceptorTerrain = {
      status: 'ready',
      shielding: { la: analysis.la, lc: analysis.lc },
      analysis,
      profile,
    };
    this.receptors.set(key, result);
    evict(this.receptors, RECEPTOR_CACHE_LIMIT);
    return result;
  }
}
