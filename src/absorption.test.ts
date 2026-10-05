import { describe, expect, it } from 'vitest';
import {
  MUSIC_SPECTRUM,
  P_REF,
  aWeighting,
  absorptionCoefficient,
  absorptionPerKm,
  broadbandCoefficients,
} from './absorption';

const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const;

/** Published ISO 9613-2 Table 2 coefficients, dB/km, at 101.325 kPa. */
const PUBLISHED: Record<string, Record<number, number>> = {
  // The row most often reproduced, and the one quoted in the brief for this feature.
  '10C/70%': { 63: 0.1, 125: 0.4, 250: 1.0, 500: 1.9, 1000: 3.7, 2000: 9.7, 4000: 32.8, 8000: 117 },
  '20C/70%': { 63: 0.1, 125: 0.3, 250: 1.1, 500: 2.8, 1000: 5.0, 2000: 9.0, 4000: 22.9, 8000: 76.6 },
};

/** Within 10 %, or within 0.1 dB/km where the value is too small for a ratio to mean anything. */
function closeEnough(got: number, want: number): boolean {
  return Math.abs(got - want) <= Math.max(0.1, want * 0.1);
}

describe('absorptionCoefficient', () => {
  for (const [label, table] of Object.entries(PUBLISHED)) {
    const [t, rh] = label.match(/(-?\d+)C\/(\d+)%/)!.slice(1).map(Number);
    it(`matches the published table at ${label}`, () => {
      for (const f of BANDS) {
        const got = absorptionPerKm(f, t, rh);
        expect(closeEnough(got, table[f]), `${f} Hz: got ${got.toFixed(2)}, want ${table[f]}`).toBe(true);
      }
    });
  }

  it('absorbs far more at 2 kHz in dry air than in damp air', () => {
    const damp = absorptionPerKm(2000, 20, 70);
    const dry = absorptionPerKm(2000, 20, 30);
    expect(dry).toBeGreaterThan(damp * 1.4);
    expect(damp).toBeCloseTo(9.0, 0);
    expect(dry).toBeCloseTo(14.1, 0);
  });

  it('leaves 63 Hz alone in any damp air', () => {
    for (const t of [0, 10, 18, 25, 35]) {
      for (const rh of [50, 70, 90, 100]) {
        expect(absorptionPerKm(63, t, rh)).toBeLessThan(0.2);
      }
    }
  });

  it('still barely touches 63 Hz when the air dries out', () => {
    // The coefficient peaks around 30 % RH rather than falling monotonically, and it creeps a
    // little over 0.2 dB/km there. Even at 10 % it is under half a dB across a whole kilometre,
    // against 6 dB lost to spreading every time the distance doubles. Bass does not care.
    for (const t of [0, 10, 18, 25, 35]) {
      expect(absorptionPerKm(63, t, 30)).toBeLessThan(0.25);
    }
    expect(absorptionPerKm(63, 20, 10)).toBeLessThan(0.5);
  });

  it('rises steeply with frequency', () => {
    let previous = 0;
    for (const f of BANDS) {
      const now = absorptionPerKm(f, 20, 70);
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
  });

  it('scales with ambient pressure', () => {
    // Thinner air at altitude absorbs more; the default is sea level.
    expect(absorptionCoefficient(2000, 20, 70, 80)).toBeGreaterThan(absorptionCoefficient(2000, 20, 70, P_REF));
  });

  it('is zero at zero frequency and never negative', () => {
    expect(absorptionCoefficient(0, 20, 70)).toBe(0);
    for (const f of BANDS) expect(absorptionCoefficient(f, 5, 95)).toBeGreaterThan(0);
  });
});

describe('aWeighting', () => {
  it('is the standard curve', () => {
    expect(aWeighting(1000)).toBeCloseTo(0, 2);
    expect(aWeighting(63)).toBeCloseTo(-26.2, 1);
    expect(aWeighting(125)).toBeCloseTo(-16.2, 1);
    expect(aWeighting(500)).toBeCloseTo(-3.2, 1);
    expect(aWeighting(2000)).toBeCloseTo(1.2, 1);
    expect(aWeighting(8000)).toBeCloseTo(-1.1, 1);
  });
});

describe('MUSIC_SPECTRUM', () => {
  it('covers 63 Hz to 8 kHz in octaves, referenced to 1 kHz', () => {
    expect(MUSIC_SPECTRUM.map((b) => b.frequencyHz)).toEqual([...BANDS]);
    expect(MUSIC_SPECTRUM.find((b) => b.frequencyHz === 1000)?.relativeDb).toBe(0);
  });

  it('is bass-heavy and rolls off on top, the shape of a dance rig', () => {
    const at = (f: number) => MUSIC_SPECTRUM.find((b) => b.frequencyHz === f)!.relativeDb;
    expect(at(63)).toBeGreaterThan(at(250));
    expect(at(250)).toBeGreaterThan(at(1000));
    expect(at(8000)).toBeLessThan(at(4000));
  });
});

describe('broadbandCoefficients', () => {
  it('reproduces the 0.8 dB/100 m the model used before the weather existed', () => {
    // The whole point of the tuning: at the conditions the old constant implied, the physical
    // model has to agree with it, or every existing scenario quietly changes answer.
    const { laPer100m } = broadbandCoefficients(20, 70);
    expect(laPer100m).toBeGreaterThan(0.6);
    expect(laPer100m).toBeLessThan(1.0);
    expect(laPer100m).toBeCloseTo(0.8, 1);
  });

  it('keeps the bass coefficient negligible', () => {
    for (const [t, rh] of [
      [20, 70],
      [15, 90],
      [25, 35],
    ] as const) {
      const { lcPer100m } = broadbandCoefficients(t, rh);
      expect(lcPer100m).toBeGreaterThan(0);
      expect(lcPer100m).toBeLessThan(0.02);
    }
  });

  it('loses more of the mix in dry air than in damp air', () => {
    expect(broadbandCoefficients(25, 35).laPer100m).toBeGreaterThan(broadbandCoefficients(15, 90).laPer100m);
  });

  it('moves only a little across the conditions the presets use', () => {
    // Absorption matters, but it is not the headline: between the dampest and driest preset
    // the A-weighted figure shifts by well under a dB per 100 m.
    const values = [broadbandCoefficients(18, 75), broadbandCoefficients(15, 90), broadbandCoefficients(25, 35)].map(
      (c) => c.laPer100m,
    );
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.3);
  });

  it('memoises, so contour bisection does not redo the integral thousands of times', () => {
    expect(broadbandCoefficients(18, 75)).toBe(broadbandCoefficients(18, 75));
    expect(broadbandCoefficients(18, 75)).not.toBe(broadbandCoefficients(19, 75));
  });
});
