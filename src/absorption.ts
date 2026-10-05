/**
 * Atmospheric absorption after ISO 9613-1.
 *
 * Air swallows high frequencies and almost ignores low ones, and how much it swallows depends
 * sharply on humidity: a dry warm afternoon and a damp cool night are several dB per kilometre
 * apart at 2 kHz. The old model used two fixed constants for this. This computes the real
 * coefficient per octave band and collapses it back to the two numbers the propagation model
 * wants, so changing the weather actually changes the answer.
 *
 * The formulation is the standard one: molar concentration of water vapour from the saturation
 * vapour pressure, oxygen and nitrogen relaxation frequencies, and the classical plus
 * rotational plus vibrational terms. Validated against the published tables in `absorption.test.ts`.
 */

/** Reference air temperature, 20 °C in kelvin. */
const T_REF = 293.15;
/** Triple-point isotherm, kelvin. */
const T_TRIPLE = 273.16;
/** Reference ambient pressure, kPa. */
export const P_REF = 101.325;

/** Nepers to decibels. */
const NP_TO_DB = 8.686;

/**
 * Pure-tone atmospheric attenuation coefficient, dB per metre.
 *
 * @param frequencyHz        pure-tone frequency
 * @param temperatureC       air temperature
 * @param relativeHumidityPct relative humidity, 0–100
 * @param pressureKPa        ambient pressure
 */
export function absorptionCoefficient(
  frequencyHz: number,
  temperatureC: number,
  relativeHumidityPct: number,
  pressureKPa = P_REF,
): number {
  const t = temperatureC + 273.15;
  const pa = pressureKPa / P_REF;
  const tr = t / T_REF;
  const f = frequencyHz;

  // Saturation vapour pressure as a fraction of the reference pressure (ISO 9613-1 Annex B),
  // then the molar concentration of water vapour as a percentage.
  const psat = 10 ** (-6.8346 * (T_TRIPLE / t) ** 1.261 + 4.6151);
  const h = (relativeHumidityPct * psat) / pa;

  // Relaxation frequencies of oxygen and nitrogen. Both move with humidity, which is why the
  // absorption curve changes shape and not just height as the air dries out.
  const frO = pa * (24 + 4.04e4 * h * ((0.02 + h) / (0.391 + h)));
  const frN = pa * tr ** -0.5 * (9 + 280 * h * Math.exp(-4.17 * (tr ** (-1 / 3) - 1)));

  const classical = (1.84e-11 * tr ** 0.5) / pa;
  const oxygen = 0.01275 * Math.exp(-2239.1 / t) * (frO + (f * f) / frO) ** -1;
  const nitrogen = 0.1068 * Math.exp(-3352.0 / t) * (frN + (f * f) / frN) ** -1;

  return NP_TO_DB * f * f * (classical + tr ** -2.5 * (oxygen + nitrogen));
}

/** Convenience: the same coefficient in the dB/km the published tables use. */
export function absorptionPerKm(
  frequencyHz: number,
  temperatureC: number,
  relativeHumidityPct: number,
  pressureKPa = P_REF,
): number {
  return absorptionCoefficient(frequencyHz, temperatureC, relativeHumidityPct, pressureKPa) * 1000;
}

/** A-weighting at a frequency, dB, from the IEC 61672 pole-zero expression. */
export function aWeighting(frequencyHz: number): number {
  const f2 = frequencyHz * frequencyHz;
  const numerator = 12194 ** 2 * f2 * f2;
  const denominator =
    (f2 + 20.6 ** 2) *
    Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) *
    (f2 + 12194 ** 2);
  return 20 * Math.log10(numerator / denominator) + 2.0;
}

export interface SpectrumBand {
  /** Octave band centre frequency. */
  frequencyHz: number;
  /** Unweighted band level at the source, dB relative to the 1 kHz band. */
  relativeDb: number;
}

/**
 * Octave-band spectrum of a dance-music PA at the stacks, relative to the 1 kHz band.
 *
 * Heavy sub and low mids, a broad presence region, and a roll-off above 4 kHz — the shape a
 * four-way horn-loaded rig puts out on electronic music. It only has to be right in its
 * proportions: absolute level comes from `maxLevelAt10m`, and all this spectrum decides is how
 * fast the A-weighted total loses ground to the air as distance grows.
 *
 * The weights are tuned so that at 20 °C / 70 % RH the broadband A-weighted figure lands on
 * 0.8 dB per 100 m, the constant the model used before the weather was modelled at all.
 */
export const MUSIC_SPECTRUM: readonly SpectrumBand[] = Object.freeze([
  { frequencyHz: 63, relativeDb: 10 },
  { frequencyHz: 125, relativeDb: 7 },
  { frequencyHz: 250, relativeDb: 4 },
  { frequencyHz: 500, relativeDb: 1 },
  { frequencyHz: 1000, relativeDb: 0 },
  { frequencyHz: 2000, relativeDb: 0 },
  { frequencyHz: 4000, relativeDb: 0 },
  { frequencyHz: 8000, relativeDb: -4 },
]);

/** The band the bass figure is taken from: what a neighbour feels rather than hears. */
export const BASS_BAND_HZ = 63;

/**
 * Distance the broadband figure is fitted at. Absorption is not linear in dB once a spectrum is
 * involved — the bright bands die first and the mix dulls — so the per-100 m number has to be a
 * fit at a representative distance rather than a true constant. 500 m is where the houses are.
 */
export const FIT_DISTANCE_M = 500;
const FIT_REFERENCE_M = 10;
const FIT_SPAN_M = FIT_DISTANCE_M - FIT_REFERENCE_M;

export interface BroadbandCoefficients {
  /** Effective A-weighted absorption, dB per 100 m. */
  laPer100m: number;
  /** Bass-band absorption, dB per 100 m. */
  lcPer100m: number;
}

const sumDb = (levels: number[]): number => 10 * Math.log10(levels.reduce((n, l) => n + 10 ** (l / 10), 0));

/** One-entry-per-condition memo: `levelAt` calls this inside contour bisections. */
const cache = new Map<number, BroadbandCoefficients>();

/**
 * The two per-100 m figures the propagation model uses, for one set of conditions.
 *
 * The A-weighted number is the dB(A) the mix loses to the air between 10 m and 500 m, divided
 * by 4.9. The bass number is the plain 63 Hz coefficient, which is so small that the spectrum
 * makes no difference to it.
 */
export function broadbandCoefficients(temperatureC: number, relativeHumidityPct: number): BroadbandCoefficients {
  const key = Math.round(temperatureC * 10) * 100_000 + Math.round(relativeHumidityPct * 10);
  const hit = cache.get(key);
  if (hit) return hit;

  const near: number[] = [];
  const far: number[] = [];
  for (const band of MUSIC_SPECTRUM) {
    const weighted = band.relativeDb + aWeighting(band.frequencyHz);
    const lost = absorptionCoefficient(band.frequencyHz, temperatureC, relativeHumidityPct) * FIT_SPAN_M;
    near.push(weighted);
    far.push(weighted - lost);
  }

  const result: BroadbandCoefficients = {
    laPer100m: ((sumDb(near) - sumDb(far)) / FIT_SPAN_M) * 100,
    lcPer100m: absorptionCoefficient(BASS_BAND_HZ, temperatureC, relativeHumidityPct) * 100,
  };
  cache.set(key, result);
  return result;
}
