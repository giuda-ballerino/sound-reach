/**
 * Simplified outdoor propagation model for a PA system.
 *
 * Reference: the level at 10 m in front of the stacks. From there:
 *  - spherical spreading, −20·log10(d/10) (−6 dB per doubling)
 *  - air absorption, linear per 100 m (A‑weighted mix vs. bass band)
 *  - ground attenuation over soft terrain beyond 200 m
 *  - a favourable‑propagation term (still night, downwind, inversion)
 *  - horizontal directivity of horn‑loaded tops; subs omni or cardioid
 *  - optional terrain shielding, supplied per band by the caller (see `terrain.ts`)
 *
 * All numbers are estimates (±5 dB). Reflections and buildings are not modelled.
 */

export type SubMode = 'omni' | 'cardioid';

export interface RigParams {
  /** dB(A) at 10 m on axis when the rig is driven to its maximum. */
  maxLevelAt10m: number;
  /** Volume as a percentage of the maximum, 10–100. */
  volumePct: number;
  /** How much louder the bass band is than the A‑weighted figure (dB(C) − dB(A)). */
  bassExcess: number;
  /** Bearing the stacks face, degrees clockwise from north. */
  aimDeg: number;
  /** Treat the tops as directional horns (true) or as an omnidirectional source. */
  directional: boolean;
  subs: SubMode;
  /** Favourable propagation: still night air, downwind, temperature inversion. */
  night: boolean;
  /** Soft ground (fields, scrub) between stage and receptor. */
  softGround: boolean;
}

export const DEFAULT_RIG: RigParams = {
  maxLevelAt10m: 112,
  volumePct: 70,
  bassExcess: 15,
  aimDeg: 180,
  directional: true,
  subs: 'omni',
  night: true,
  softGround: true,
};

/** Air absorption, dB per 100 m. A‑weighted music mix is dominated by 1–4 kHz. */
const ABSORPTION_A_PER_100M = 0.8;
const ABSORPTION_BASS_PER_100M = 0.05;

/** Reference distance in metres for the source level. */
export const REF_DISTANCE = 10;

/** Volume percentage → source level. Each halving of the percentage is −10 dB (≈ half as loud). */
export function sourceLevel(p: RigParams): number {
  const pct = Math.min(100, Math.max(1, p.volumePct));
  return p.maxLevelAt10m + 10 * Math.log2(pct / 100);
}

/** Smallest angle between a bearing and the stack aim, 0..180. */
export function offAxisAngle(bearingDeg: number, aimDeg: number): number {
  // Normalise the difference into [-180, 180) and take its magnitude.
  const wrapped = ((((bearingDeg - aimDeg) % 360) + 540) % 360) - 180;
  return Math.abs(wrapped);
}

/** Horizontal directivity of horn‑loaded tops, dB relative to on‑axis. */
export function topsDirectivity(offAxisDeg: number): number {
  const a = Math.min(Math.abs(offAxisDeg), 180);
  if (a <= 30) return 0;
  if (a <= 90) return (-6 * (a - 30)) / 60;
  return -6 - (6 * (a - 90)) / 90;
}

/** Directivity of the sub array. Omni by default; cardioid gives −10 dB behind. */
export function subsDirectivity(offAxisDeg: number, mode: SubMode): number {
  if (mode === 'omni') return 0;
  const a = Math.min(Math.abs(offAxisDeg), 180);
  return a <= 60 ? 0 : (-10 * (a - 60)) / 120;
}

export interface Levels {
  /** A‑weighted level, what the legal limits are measured in. */
  la: number;
  /** Bass band level, roughly dB(C), what neighbours notice at night. */
  lc: number;
}

/**
 * Predicted level at a distance (m) along a bearing (deg from north).
 * Pass `bearingDeg = undefined` for the on‑axis value.
 * `shielding` is dB to subtract per band for terrain in the way; see `terrain.ts`.
 */
export function levelAt(p: RigParams, distanceM: number, bearingDeg?: number, shielding?: Levels): Levels {
  const d = Math.max(distanceM, REF_DISTANCE);
  const l10 = sourceLevel(p);
  const spread = -20 * Math.log10(d / REF_DISTANCE);
  const ground = p.softGround && d > 200 ? -2 * Math.min(1, (d - 200) / 400) : 0;
  const night = p.night && d > 50 ? 5 * Math.min(1, (d - 50) / 250) : 0;
  const off = bearingDeg === undefined ? 0 : offAxisAngle(bearingDeg, p.aimDeg);
  const dirTops = p.directional ? topsDirectivity(off) : 0;
  const dirSubs = p.directional ? subsDirectivity(off, p.subs) : 0;
  const la =
    l10 + spread - (ABSORPTION_A_PER_100M * (d - REF_DISTANCE)) / 100 + ground + night + dirTops - (shielding?.la ?? 0);
  const lc =
    l10 +
    p.bassExcess +
    spread -
    (ABSORPTION_BASS_PER_100M * (d - REF_DISTANCE)) / 100 +
    ground * 0.5 +
    night +
    dirSubs -
    (shielding?.lc ?? 0);
  return { la, lc };
}

export type Band = 'la' | 'lc';

/**
 * Distance (m) along a bearing at which the level falls to `targetDb`.
 * Returns REF_DISTANCE when the target is never exceeded, and `maxDistance` when never reached.
 */
export function reachDistance(
  p: RigParams,
  targetDb: number,
  bearingDeg: number | undefined,
  band: Band = 'la',
  maxDistance = 50_000,
): number {
  const f = (d: number) => levelAt(p, d, bearingDeg)[band] - targetDb;
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

/** A plain‑language description of an A‑weighted level, for the readouts. */
export function describeLevel(la: number): string {
  if (la >= 100) return 'front of a dance floor';
  if (la >= 90) return 'loud bar';
  if (la >= 80) return 'busy road at the kerb';
  if (la >= 70) return 'you raise your voice';
  if (la >= 60) return 'normal conversation';
  if (la >= 50) return 'quiet room, clearly audible';
  if (la >= 40) return 'audible on a still night';
  return 'below rural night background';
}
