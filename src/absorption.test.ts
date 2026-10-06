import { describe, expect, it } from 'vitest';
import {
  FIT_DISTANCE_M,
  LOOKUP_MAX_M,
  MUSIC_SPECTRUM,
  P_REF,
  REFERENCE_M,
  aWeighting,
  absorptionCoefficient,
  absorptionLoss,
  absorptionLossExact,
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

describe('absorptionLoss', () => {
  it('agrees with the 500 m rate fit at 500 m, which is where the fit was made', () => {
    for (const [t, rh] of [
      [20, 70],
      [18, 75],
      [15, 90],
      [25, 35],
    ] as const) {
      const exact = absorptionLossExact(FIT_DISTANCE_M, t, rh).la;
      const fromRate = (broadbandCoefficients(t, rh).laPer100m * (FIT_DISTANCE_M - REFERENCE_M)) / 100;
      expect(Math.abs(exact - fromRate)).toBeLessThan(0.05);
    }
  });

  it('flattens off with distance instead of growing linearly', () => {
    // Once the 4 and 8 kHz bands are gone the air has nothing left to take, so the A-weighted
    // loss stops keeping pace with distance. A per-100 m rate fitted at 500 m keeps going.
    const rate = broadbandCoefficients(18, 75).laPer100m;
    for (const [d, want] of [
      [1000, 5.9],
      [2000, 8.8],
      [3000, 10.7],
    ] as const) {
      expect(absorptionLossExact(d, 18, 75).la).toBeCloseTo(want, 0);
      expect(Math.abs(absorptionLossExact(d, 18, 75).la - want)).toBeLessThan(0.3);
      // And the linear term really does overshoot by the amount that motivated this.
      expect((rate * (d - REFERENCE_M)) / 100).toBeGreaterThan(absorptionLossExact(d, 18, 75).la + 1);
    }
  });

  it('is zero at the reference distance and never goes backwards', () => {
    expect(absorptionLoss(REFERENCE_M, 18, 75)).toEqual({ la: 0, lc: 0 });
    expect(absorptionLoss(5, 18, 75)).toEqual({ la: 0, lc: 0 });
    let previous = -1;
    for (let d = 10; d <= 20_000; d += 37) {
      const { la } = absorptionLoss(d, 18, 75);
      expect(la).toBeGreaterThanOrEqual(previous);
      previous = la;
    }
  });

  it('keeps the bass loss linear in distance', () => {
    const a = absorptionLoss(1000, 18, 75).lc;
    const b = absorptionLoss(3000, 18, 75).lc;
    expect((b / a)).toBeCloseTo((3000 - REFERENCE_M) / (1000 - REFERENCE_M), 6);
    // And negligible either way: a fifth of a dB across three kilometres.
    expect(b).toBeLessThan(0.3);
  });

  it('matches the direct computation everywhere the table is used', () => {
    for (let i = 0; i < 20; i++) {
      const d = REFERENCE_M * Math.exp(Math.random() * Math.log(LOOKUP_MAX_M / REFERENCE_M));
      for (const [t, rh] of [
        [18, 75],
        [15, 90],
        [25, 35],
      ] as const) {
        const viaTable = absorptionLoss(d, t, rh);
        const direct = absorptionLossExact(d, t, rh);
        expect(Math.abs(viaTable.la - direct.la), `la at ${d.toFixed(1)} m`).toBeLessThan(0.05);
        expect(Math.abs(viaTable.lc - direct.lc), `lc at ${d.toFixed(1)} m`).toBeLessThan(0.05);
      }
    }
  });

  it('loses more of the mix in dry air at every distance', () => {
    for (const d of [200, 1000, 3000]) {
      expect(absorptionLoss(d, 25, 35).la).toBeGreaterThan(absorptionLoss(d, 15, 90).la);
    }
  });

  it('holds the last value past the end of the table rather than running away', () => {
    expect(absorptionLoss(LOOKUP_MAX_M * 2, 18, 75).la).toBeCloseTo(absorptionLoss(LOOKUP_MAX_M, 18, 75).la, 6);
  });
});
