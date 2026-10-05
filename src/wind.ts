/**
 * Refraction by wind and temperature structure, as a single correction in dB.
 *
 * Sound does not travel in straight lines through moving air. Wind speed rises with height, so
 * downwind the ray paths bend back towards the ground and the level at distance goes up; upwind
 * they bend away and leave an acoustic shadow that can be worth 10–15 dB. A night-time
 * temperature inversion does the same thing as downwind, in every direction at once — which is
 * exactly why complaints arrive at two in the morning and not at two in the afternoon.
 *
 * This is the engineering approximation, not a ray tracer: an angular weighting between the
 * propagation direction and the wind, a speed factor, and distance ramps fitted to the sort of
 * numbers ISO 9613-2 and the ground-effect literature use. It replaces the model's old flat
 * "+5 dB at night" term, which is now just the inversion part of this.
 */

import { angleBetweenBearings } from './geo';

export type OmnidirectionalWind = 'downwind' | 'upwind';

export interface WindState {
  /** Wind speed at 10 m height, m/s. */
  windSpeedMs: number;
  /** Direction the wind blows FROM, degrees clockwise from north — the meteorological convention. */
  windFromDeg: number;
  /** Night-time temperature inversion: downwind-like bending in every direction. */
  inversion: boolean;
  /**
   * Pretend every bearing is downwind (or upwind) of the stage. Physically impossible, which is
   * the point: it is the enveloping convention a permit forecast is built on.
   */
  omnidirectionalWind?: OmnidirectionalWind;
}

/** Fully downwind out to this angle, then tapering. */
const DOWNWIND_FULL_DEG = 45;
/** No wind effect either way at right angles to the wind. */
const CROSSWIND_DEG = 90;
/** Fully upwind beyond this angle. */
const UPWIND_FULL_DEG = 135;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * How downwind a direction is, 0–1. θ is the angle between the way the sound travels and the
 * way the wind blows, so θ = 0 is straight downwind.
 */
export function downwindFactor(thetaDeg: number): number {
  const a = Math.abs(thetaDeg);
  if (a <= DOWNWIND_FULL_DEG) return 1;
  if (a >= CROSSWIND_DEG) return 0;
  return (CROSSWIND_DEG - a) / (CROSSWIND_DEG - DOWNWIND_FULL_DEG);
}

/** How upwind a direction is, 0–1. θ = 180 is straight into the wind. */
export function upwindFactor(thetaDeg: number): number {
  const a = Math.abs(thetaDeg);
  if (a >= UPWIND_FULL_DEG) return 1;
  if (a <= CROSSWIND_DEG) return 0;
  return (a - CROSSWIND_DEG) / (UPWIND_FULL_DEG - CROSSWIND_DEG);
}

/**
 * How much the wind is worth, 0–1. Below 1 m/s the air is effectively still and refraction is
 * dominated by whatever the temperature profile is doing; by 5 m/s the effect has saturated.
 */
export function speedFactor(windSpeedMs: number): number {
  return clamp01((windSpeedMs - 1) / 4);
}

/** Downwind gain with distance, dB. Nothing close in, +5 by 500 m, +7 by a kilometre. */
export function downwindBonus(distanceM: number): number {
  if (distanceM <= 100) return 0;
  if (distanceM <= 500) return (5 * (distanceM - 100)) / 400;
  if (distanceM <= 1000) return 5 + (2 * (distanceM - 500)) / 500;
  return 7;
}

/**
 * Upwind shadow, dB (negative). The shadow zone starts closer and bites harder the stronger the
 * wind: from 600 m in a light breeze down to 300 m at 5 m/s, reaching −10 to −15 dB 400 m later.
 */
export function upwindPenalty(distanceM: number, windSpeedMs: number): number {
  const s = speedFactor(windSpeedMs);
  const shadowStart = 600 - 300 * s;
  const full = -(10 + 5 * s);
  if (distanceM <= shadowStart) return 0;
  if (distanceM >= shadowStart + 400) return full;
  return (full * (distanceM - shadowStart)) / 400;
}

/** Temperature-inversion gain with distance, dB: the model's old night term, unchanged. */
export function inversionTerm(distanceM: number): number {
  if (distanceM <= 50) return 0;
  return 5 * Math.min(1, (distanceM - 50) / 250);
}

/**
 * Total propagation correction in dB for one receptor direction.
 *
 * Inversion and downwind are combined with `max`, not a sum: both are the same physical
 * mechanism — rays bent back down — and stacking them would double-count. The upwind shadow is
 * added on top, halved when an inversion is working against it.
 */
export function propagationCorrection(distanceM: number, propagationBearingDeg: number, w: WindState): number {
  const theta =
    w.omnidirectionalWind === 'downwind'
      ? 0
      : w.omnidirectionalWind === 'upwind'
        ? 180
        : angleBetweenBearings(propagationBearingDeg, w.windFromDeg + 180);

  const s = speedFactor(w.windSpeedMs);
  const inversion = w.inversion ? inversionTerm(distanceM) : 0;
  const downwind = s * downwindFactor(theta) * downwindBonus(distanceM);
  const shadow = s * upwindFactor(theta) * upwindPenalty(distanceM, w.windSpeedMs) * (w.inversion ? 0.5 : 1);

  return Math.max(inversion, downwind) + shadow;
}
