import { REF_DISTANCE, levelAt, reachDistance, type Band, type Levels, type RigParams } from './acoustics';
import { destination, type LatLon } from './geo';
import { NO_SHIELDING } from './terrain';

/** What the coloured zones on the map mean. */
export type ZoneMode = 'legal' | 'audibility' | 'rings';

/**
 * Terrain shielding (dB to subtract per band) at a point given by its bearing from the stage
 * and its distance along that bearing. The default returns zeros, i.e. flat ground.
 */
export type ShieldingAt = (bearingDeg: number, distanceM: number) => Levels;

export const flatGround: ShieldingAt = () => NO_SHIELDING;

export interface ZoneBand {
  /** Levels (dB) this band spans: everything ≥ lower and < upper. `upper` = Infinity for the innermost. */
  lower: number;
  upper: number;
  label: string;
  /** CSS colour token name, resolved by the renderer. */
  tone: 'critical' | 'serious' | 'warning' | 'fine' | 'faint';
}

export function legalBands(limitDb: number): ZoneBand[] {
  return [
    { lower: limitDb, upper: Infinity, label: `over the limit (≥ ${limitDb} dB(A))`, tone: 'critical' },
    { lower: limitDb - 5, upper: limitDb, label: `within 5 dB of the limit`, tone: 'warning' },
    { lower: limitDb - 10, upper: limitDb - 5, label: `5–10 dB under the limit`, tone: 'fine' },
  ];
}

export const AUDIBILITY_BANDS: ZoneBand[] = [
  { lower: 80, upper: Infinity, label: 'loud, you raise your voice (≥ 80 dB(A))', tone: 'critical' },
  { lower: 60, upper: 80, label: 'intrusive, like a nearby party (60–80)', tone: 'serious' },
  { lower: 45, upper: 60, label: 'clearly audible, bass thumps (45–60)', tone: 'warning' },
  { lower: 35, upper: 45, label: 'faint on a still night (35–45)', tone: 'faint' },
];

/** Plain contour levels for the "rings" mode. */
export const RING_LEVELS = [90, 80, 70, 60, 50, 45];

/** Bearings sampled when tracing a contour. 3° is smooth enough and cheap. */
const STEP_DEG = 3;

/**
 * Distance along a bearing at which the level falls to `targetDb`, with terrain in the way.
 *
 * This mirrors `acoustics.reachDistance`, which cannot take the terrain term itself: shielding
 * depends on the distance the bisection is still searching for. With `flatGround` the two agree
 * exactly, since subtracting zero changes nothing.
 */
export function shieldedReach(
  p: RigParams,
  targetDb: number,
  bearingDeg: number | undefined,
  band: Band = 'la',
  shieldingAt: ShieldingAt = flatGround,
  maxDistance = 50_000,
): number {
  if (shieldingAt === flatGround) return reachDistance(p, targetDb, bearingDeg, band, maxDistance);
  const f = (d: number) => levelAt(p, d, bearingDeg, shieldingAt(bearingDeg ?? p.aimDeg, d))[band] - targetDb;
  let lo = REF_DISTANCE;
  let hi = maxDistance;
  if (f(lo) <= 0) return lo;
  if (f(hi) > 0) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/** Trace the closed ring where the level equals `db`, as lat/lon points around the stage. */
export function contourRing(
  stage: LatLon,
  p: RigParams,
  db: number,
  band: Band = 'la',
  shieldingAt: ShieldingAt = flatGround,
): LatLon[] {
  const ring: LatLon[] = [];
  for (let b = 0; b < 360; b += STEP_DEG) {
    const d = shieldedReach(p, db, b, band, shieldingAt);
    ring.push(destination(stage, b, d));
  }
  return ring;
}

/** Per‑band polygons: outer ring at `lower`, hole at `upper` (none for the innermost band). */
export function bandPolygons(
  stage: LatLon,
  p: RigParams,
  bands: ZoneBand[],
  band: Band = 'la',
  shieldingAt: ShieldingAt = flatGround,
) {
  return bands.map((zb) => {
    const outer = contourRing(stage, p, zb.lower, band, shieldingAt);
    const hole = Number.isFinite(zb.upper) ? contourRing(stage, p, zb.upper, band, shieldingAt) : null;
    return { band: zb, outer, hole };
  });
}

/** Largest reach among the rings drawn, used to fit the map. */
export function maxReach(
  p: RigParams,
  levels: number[],
  band: Band = 'la',
  shieldingAt: ShieldingAt = flatGround,
): number {
  let max = 0;
  const lowest = Math.min(...levels);
  for (let b = 0; b < 360; b += 15) max = Math.max(max, shieldedReach(p, lowest, b, band, shieldingAt));
  return max;
}

export { levelAt };
