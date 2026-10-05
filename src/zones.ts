import { REF_DISTANCE, levelAt, type Band, type Levels, type RigParams } from './acoustics';
import type { Conditions } from './conditions';
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
 * Step used to hunt for the contour. Matches the zone grid's own spacing (`ZONE_STEP_M`), so
 * the march cannot stride over a ridge the shielding data can actually resolve.
 */
export const REACH_STEP_M = 50;

/** Halvings inside the bracketing step; 40 puts the answer far below a millimetre. */
const BISECT_STEPS = 40;

/**
 * Distance along a bearing at which the level first falls to `targetDb`, terrain included.
 *
 * `acoustics.reachDistance` cannot take the terrain term itself, because shielding depends on
 * the very distance being searched for. It also assumes the level only ever falls, which stops
 * being true once terrain is in play: the level collapses behind a ridge and recovers on the
 * far side, so there can be several crossings. A bisection over the whole range would happily
 * converge on a later one and draw the contour kilometres past the point where the level
 * genuinely first drops below the limit — the optimistic direction, and the wrong one.
 *
 * So march outwards in fixed steps, stop at the first step that crosses, and bisect inside it.
 * With `flatGround` the level is monotonic and this agrees with `reachDistance` to well under
 * a millimetre.
 */
export function shieldedReach(
  p: RigParams,
  c: Conditions,
  targetDb: number,
  bearingDeg: number | undefined,
  band: Band = 'la',
  shieldingAt: ShieldingAt = flatGround,
  maxDistance = 50_000,
): number {
  // Shielding is indexed by bearing, so an on-axis query still has to name one.
  const lookupBearing = bearingDeg ?? p.aimDeg;
  const f = (d: number) => levelAt(p, c, d, bearingDeg, shieldingAt(lookupBearing, d))[band] - targetDb;

  let lo = REF_DISTANCE;
  if (f(lo) <= 0) return lo;

  let hi = maxDistance;
  for (let d = lo + REACH_STEP_M; ; d += REACH_STEP_M) {
    const at = Math.min(d, maxDistance);
    if (f(at) <= 0) {
      hi = at;
      break;
    }
    if (at >= maxDistance) return maxDistance;
    lo = at;
  }

  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Trace the closed ring where the level equals `db`, as lat/lon points around the stage. */
export function contourRing(
  stage: LatLon,
  p: RigParams,
  c: Conditions,
  db: number,
  band: Band = 'la',
  shieldingAt: ShieldingAt = flatGround,
): LatLon[] {
  const ring: LatLon[] = [];
  for (let b = 0; b < 360; b += STEP_DEG) {
    const d = shieldedReach(p, c, db, b, band, shieldingAt);
    ring.push(destination(stage, b, d));
  }
  return ring;
}

/** Per‑band polygons: outer ring at `lower`, hole at `upper` (none for the innermost band). */
export function bandPolygons(
  stage: LatLon,
  p: RigParams,
  c: Conditions,
  bands: ZoneBand[],
  band: Band = 'la',
  shieldingAt: ShieldingAt = flatGround,
) {
  // Adjacent bands share a threshold — one band's hole is the next band's outer ring — so
  // tracing by level rather than by band saves about half the work. Rings are read, never
  // mutated, so sharing the arrays is safe.
  const traced = new Map<number, LatLon[]>();
  const ring = (db: number): LatLon[] => {
    let r = traced.get(db);
    if (!r) {
      r = contourRing(stage, p, c, db, band, shieldingAt);
      traced.set(db, r);
    }
    return r;
  };
  return bands.map((zb) => ({
    band: zb,
    outer: ring(zb.lower),
    hole: Number.isFinite(zb.upper) ? ring(zb.upper) : null,
  }));
}

/** Largest reach among the rings drawn, used to fit the map. */
export function maxReach(
  p: RigParams,
  c: Conditions,
  levels: number[],
  band: Band = 'la',
  shieldingAt: ShieldingAt = flatGround,
): number {
  let max = 0;
  const lowest = Math.min(...levels);
  for (let b = 0; b < 360; b += 15) max = Math.max(max, shieldedReach(p, c, lowest, b, band, shieldingAt));
  return max;
}

export { levelAt };
