/**
 * Named weather conditions.
 *
 * Three of them, because a single number for "the weather" is the wrong shape for the decision
 * this tool exists to support. A site is not safe because it is quiet on a typical night; it is
 * safe because it is acceptable on the night everything lines up against you. So the model
 * always carries a worst case alongside whatever is selected.
 */

import type { OmnidirectionalWind, WindState } from './wind';

export type ConditionPreset = 'typical' | 'worst' | 'favourable' | 'custom';

export interface Conditions extends WindState {
  preset: ConditionPreset;
  temperatureC: number;
  /** Relative humidity, 0–100. */
  humidityPct: number;
  /** Soft ground (fields, scrub) between stage and receptor. */
  groundSoft: boolean;
}

export const CONDITION_PRESETS: Record<Exclude<ConditionPreset, 'custom'>, Readonly<Conditions>> = Object.freeze({
  /** A neutral September night in Sicily: damp, still, nothing special happening. */
  typical: Object.freeze({
    preset: 'typical',
    temperatureC: 18,
    humidityPct: 75,
    windSpeedMs: 0,
    windFromDeg: 0,
    inversion: false,
    groundSoft: true,
  }),

  /**
   * The ISO 9613-2 convention for a permit forecast: not a night that will happen, but the
   * envelope every direction would see if it got the worst of what is physically available.
   * Downwind towards every receptor at once is impossible in reality — the standard asks for it
   * anyway, because a derogation has to hold for whichever house the wind picks tonight. Damp,
   * cool air to keep the high end alive, an inversion, and hard ground that reflects rather
   * than absorbs. Wind is set to 5 m/s so the speed factor saturates at 1.
   */
  worst: Object.freeze({
    preset: 'worst',
    temperatureC: 15,
    humidityPct: 90,
    windSpeedMs: 5,
    windFromDeg: 0,
    inversion: true,
    groundSoft: false,
    omnidirectionalWind: 'downwind' as OmnidirectionalWind,
  }),

  /** The other end of the envelope: dry, warm, a real breeze blowing the sound away. */
  favourable: Object.freeze({
    preset: 'favourable',
    temperatureC: 25,
    humidityPct: 35,
    windSpeedMs: 5,
    windFromDeg: 0,
    inversion: false,
    groundSoft: true,
    omnidirectionalWind: 'upwind' as OmnidirectionalWind,
  }),
});

export const CONDITION_LABELS: Record<ConditionPreset, string> = {
  typical: 'Typical',
  worst: 'Worst (ISO)',
  favourable: 'Favourable',
  custom: 'Custom',
};

export const CONDITION_BLURBS: Record<ConditionPreset, string> = {
  typical: 'A neutral night: 18 °C, 75 % humidity, no wind, no inversion, soft ground.',
  worst: 'Permit convention, not a forecast: downwind towards every house at once, inversion, hard ground, 15 °C and 90 % humidity.',
  favourable: 'The quiet end of the envelope: 25 °C, 35 % humidity, 5 m/s blowing the sound away.',
  custom: 'Your own temperature, humidity, wind and ground.',
};

/** The condition every scenario is also evaluated against, whatever is selected. */
export const WORST_CASE: Readonly<Conditions> = CONDITION_PRESETS.worst;

export function defaultConditions(): Conditions {
  return { ...CONDITION_PRESETS.typical };
}

/** The preset's own values, or the ones already held for 'custom'. */
export function applyPreset(preset: ConditionPreset, current: Conditions): Conditions {
  if (preset === 'custom') return { ...current, preset: 'custom', omnidirectionalWind: undefined };
  return { ...CONDITION_PRESETS[preset] };
}
