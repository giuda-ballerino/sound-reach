import { levelAt, reachDistance, type Band, type RigParams } from './acoustics';
import { destination, type LatLon } from './geo';

/** What the coloured zones on the map mean. */
export type ZoneMode = 'legal' | 'audibility' | 'rings';

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

/** Trace the closed ring where the level equals `db`, as lat/lon points around the stage. */
export function contourRing(stage: LatLon, p: RigParams, db: number, band: Band = 'la'): LatLon[] {
  const ring: LatLon[] = [];
  for (let b = 0; b < 360; b += STEP_DEG) {
    const d = reachDistance(p, db, b, band);
    ring.push(destination(stage, b, d));
  }
  return ring;
}

/** Per‑band polygons: outer ring at `lower`, hole at `upper` (none for the innermost band). */
export function bandPolygons(stage: LatLon, p: RigParams, bands: ZoneBand[], band: Band = 'la') {
  return bands.map((zb) => {
    const outer = contourRing(stage, p, zb.lower, band);
    const hole = Number.isFinite(zb.upper) ? contourRing(stage, p, zb.upper, band) : null;
    return { band: zb, outer, hole };
  });
}

/** Largest reach among the rings drawn, used to fit the map. */
export function maxReach(p: RigParams, levels: number[], band: Band = 'la'): number {
  let max = 0;
  const lowest = Math.min(...levels);
  for (let b = 0; b < 360; b += 15) max = Math.max(max, reachDistance(p, lowest, b, band));
  return max;
}

export { levelAt };
