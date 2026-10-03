/**
 * Terrain shielding: how much a ridge between the stage and a receptor takes off the level.
 *
 * The ground profile along the straight line from stage to receptor is treated as a single
 * knife edge at its most obstructing point. Sound reaching the receptor has to bend over that
 * edge, travelling a longer path than the direct line; the extra length is the path difference
 * δ. Maekawa's empirical curve turns δ into an attenuation through the Fresnel number N = 2δ/λ.
 *
 * Because N scales with frequency, the same ridge that kills 15–20 dB of the A‑weighted mix
 * takes only a few dB off a 63 Hz kick. That asymmetry is the whole point: a hill hides the
 * music and leaves the thump.
 *
 * Limits: one edge only (no multiple diffraction), no ground reflection, no vegetation, and the
 * profile is only as good as the DEM behind it. See the README's Terrain section.
 */

import type { Levels } from './acoustics';
import { destination, distanceBearing, type LatLon } from './geo';

/** A point on the ground profile between two places, before its elevation is known. */
export interface ProfileSample extends LatLon {
  /** Distance from the first sample, metres. */
  distanceM: number;
}

/** A profile sample with its ground elevation filled in. */
export interface ProfilePoint extends ProfileSample {
  /** Ground elevation above sea level, metres. */
  elevationM: number;
}

/** The elevation API takes 100 coordinates per call, so one profile is one call. */
export const MAX_PROFILE_POINTS = 100;

/** Default heights above ground: a stack at 2 m, a first‑floor window at 4 m. */
export const DEFAULT_SOURCE_HEIGHT_M = 2;
export const DEFAULT_RECEIVER_HEIGHT_M = 4;

/** Band centres the two shielding figures are evaluated at. */
export const A_BAND_HZ = 1000;
export const BASS_BAND_HZ = 63;

/** ISO 9613‑2 caps a single diffracting edge at 20 dB. */
export const BARRIER_MAX_DB = 20;

/** No terrain effect. Shared so callers can compare against it cheaply. */
export const NO_SHIELDING: Levels = Object.freeze({ la: 0, lc: 0 });

/**
 * Points along the geodesic from `from` to `to`, both ends included.
 * The step grows when the line is long enough that `stepM` would need more than 100 points.
 */
export function sampleProfile(from: LatLon, to: LatLon, stepM = 30): ProfileSample[] {
  const { distance, bearing } = distanceBearing(from, to);
  const start: ProfileSample = { lat: from.lat, lon: from.lon, distanceM: 0 };
  if (!(distance > 0)) return [start];
  const segments = Math.max(1, Math.min(Math.ceil(distance / stepM), MAX_PROFILE_POINTS - 1));
  const step = distance / segments;
  const out: ProfileSample[] = [start];
  for (let i = 1; i < segments; i++) {
    const p = destination(from, bearing, i * step);
    out.push({ lat: p.lat, lon: p.lon, distanceM: i * step });
  }
  out.push({ lat: to.lat, lon: to.lon, distanceM: distance });
  return out;
}

export interface PathDifference {
  /**
   * Maximum path difference δ (m) over the profile. Positive when something blocks the line of
   * sight, negative when the line is clear (Maekawa's sign convention), −Infinity when the
   * profile has no intermediate ground to get in the way.
   */
  deltaM: number;
  /** Index of the profile point that produced δ, or −1 when there is none. */
  index: number;
}

/**
 * The most obstructing point of a profile, as a path difference.
 *
 * The source sits `sourceHeightM` above the ground at the first point and the receiver
 * `receiverHeightM` above the ground at the last. For every point in between, δ is the
 * diffracted path (source → crest → receiver) minus the direct source → receiver line, in 3D.
 */
export function barrierPathDifference(
  profile: ProfilePoint[],
  sourceHeightM = DEFAULT_SOURCE_HEIGHT_M,
  receiverHeightM = DEFAULT_RECEIVER_HEIGHT_M,
): PathDifference {
  const clear: PathDifference = { deltaM: Number.NEGATIVE_INFINITY, index: -1 };
  if (profile.length < 3) return clear;
  const first = profile[0];
  const last = profile[profile.length - 1];
  const span = last.distanceM - first.distanceM;
  if (!(span > 0)) return clear;

  const zSource = first.elevationM + sourceHeightM;
  const zReceiver = last.elevationM + receiverHeightM;
  const direct = Math.hypot(span, zReceiver - zSource);

  let deltaM = Number.NEGATIVE_INFINITY;
  let index = -1;
  for (let i = 1; i < profile.length - 1; i++) {
    const x = profile[i].distanceM - first.distanceM;
    const z = profile[i].elevationM;
    const a = Math.hypot(x, z - zSource);
    const b = Math.hypot(span - x, zReceiver - z);
    // The detour is always longer than the direct line, so the magnitude is positive; the sign
    // says whether the point pokes above the line of sight or sits below it.
    const sightline = zSource + ((zReceiver - zSource) * x) / span;
    const delta = (a + b - direct) * (z >= sightline ? 1 : -1);
    if (delta > deltaM) {
      deltaM = delta;
      index = i;
    }
  }
  return { deltaM, index };
}

/**
 * Maekawa's single‑edge diffraction attenuation, dB, for a path difference at one frequency.
 * N = 2δ/λ; below N = −0.2 the edge does nothing, and N = 0 (grazing) already costs 4.8 dB.
 */
export function maekawaAttenuation(deltaM: number, frequencyHz: number, c = 343): number {
  if (Number.isNaN(deltaM)) return 0;
  const n = (2 * deltaM * frequencyHz) / c;
  if (n < -0.2) return 0;
  // 3 + 20N goes non‑positive just below N = −0.1, where the curve has already reached 0 dB.
  return Math.min(BARRIER_MAX_DB, 10 * Math.log10(Math.max(3 + 20 * n, 1)));
}

export interface ShieldingAnalysis extends Levels, PathDifference {}

/**
 * Path difference plus the attenuation it causes in each band.
 *
 * A clear line of sight is worth nothing: Maekawa's curve only reaches 0 dB at N = −0.2, so
 * applying it verbatim would charge flat ground ~4.5 dB in the bass, where the wavelength is
 * long enough that a few centimetres of clearance still count as grazing. There is no edge
 * there to diffract over, so δ ≤ 0 means no shielding at all.
 */
export function analyseProfile(
  profile: ProfilePoint[],
  sourceHeightM = DEFAULT_SOURCE_HEIGHT_M,
  receiverHeightM = DEFAULT_RECEIVER_HEIGHT_M,
): ShieldingAnalysis {
  const pd = barrierPathDifference(profile, sourceHeightM, receiverHeightM);
  const blocked = pd.deltaM > 0;
  return {
    deltaM: pd.deltaM,
    index: pd.index,
    la: blocked ? maekawaAttenuation(pd.deltaM, A_BAND_HZ) : 0,
    lc: blocked ? maekawaAttenuation(pd.deltaM, BASS_BAND_HZ) : 0,
  };
}

/** dB to subtract from each band because of the terrain along this profile. */
export function shieldingFor(
  profile: ProfilePoint[],
  sourceHeightM = DEFAULT_SOURCE_HEIGHT_M,
  receiverHeightM = DEFAULT_RECEIVER_HEIGHT_M,
): Levels {
  const { la, lc } = analyseProfile(profile, sourceHeightM, receiverHeightM);
  return { la, lc };
}
