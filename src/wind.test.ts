import { describe, expect, it } from 'vitest';
import { CONDITION_PRESETS } from './conditions';
import {
  downwindBonus,
  downwindFactor,
  inversionTerm,
  propagationCorrection,
  speedFactor,
  upwindFactor,
  upwindPenalty,
  type WindState,
} from './wind';

const calm: WindState = { windSpeedMs: 0, windFromDeg: 0, inversion: false };
/** Wind from the north at 5 m/s, so it blows towards the south: bearing 180 is downwind. */
const northerly: WindState = { windSpeedMs: 5, windFromDeg: 0, inversion: false };

describe('angular factors', () => {
  it('counts anything within 45° of downwind as fully downwind', () => {
    expect(downwindFactor(0)).toBe(1);
    expect(downwindFactor(45)).toBe(1);
    expect(downwindFactor(-45)).toBe(1);
    expect(downwindFactor(67.5)).toBeCloseTo(0.5);
    expect(downwindFactor(90)).toBe(0);
    expect(downwindFactor(180)).toBe(0);
  });

  it('counts anything beyond 135° as fully upwind', () => {
    expect(upwindFactor(180)).toBe(1);
    expect(upwindFactor(135)).toBe(1);
    expect(upwindFactor(112.5)).toBeCloseTo(0.5);
    expect(upwindFactor(90)).toBe(0);
    expect(upwindFactor(0)).toBe(0);
  });

  it('leaves a dead band across the wind where neither applies', () => {
    expect(downwindFactor(90) + upwindFactor(90)).toBe(0);
  });
});

describe('speedFactor', () => {
  it('ignores air that is barely moving and saturates at 5 m/s', () => {
    expect(speedFactor(0)).toBe(0);
    expect(speedFactor(1)).toBe(0);
    expect(speedFactor(3)).toBeCloseTo(0.5);
    expect(speedFactor(5)).toBe(1);
    expect(speedFactor(20)).toBe(1);
  });
});

describe('distance ramps', () => {
  it('gives the downwind bonus only at distance', () => {
    expect(downwindBonus(100)).toBe(0);
    expect(downwindBonus(300)).toBeCloseTo(2.5);
    expect(downwindBonus(500)).toBeCloseTo(5);
    expect(downwindBonus(1000)).toBeCloseTo(7);
    expect(downwindBonus(5000)).toBeCloseTo(7);
  });

  it('opens the upwind shadow sooner and deeper in a stronger wind', () => {
    // 5 m/s: shadow from 300 m, full −15 dB by 700 m.
    expect(upwindPenalty(300, 5)).toBe(0);
    expect(upwindPenalty(500, 5)).toBeCloseTo(-7.5);
    expect(upwindPenalty(700, 5)).toBeCloseTo(-15);
    expect(upwindPenalty(3000, 5)).toBeCloseTo(-15);
    // 2 m/s: shadow only from 525 m, and bottoming out at −11.25 dB.
    expect(upwindPenalty(500, 2)).toBe(0);
    expect(upwindPenalty(3000, 2)).toBeCloseTo(-11.25);
  });

  it('ramps the inversion exactly as the old night term did', () => {
    expect(inversionTerm(50)).toBe(0);
    expect(inversionTerm(175)).toBeCloseTo(2.5);
    expect(inversionTerm(300)).toBeCloseTo(5);
    expect(inversionTerm(2000)).toBeCloseTo(5);
  });
});

describe('propagationCorrection', () => {
  it('adds 7 dB a kilometre downwind at 5 m/s', () => {
    expect(propagationCorrection(1000, 180, northerly)).toBeCloseTo(7);
  });

  it('does nothing across the wind', () => {
    expect(propagationCorrection(1000, 90, northerly)).toBe(0);
    expect(propagationCorrection(1000, 270, northerly)).toBe(0);
  });

  it('digs a 15 dB shadow upwind at 1.5 km', () => {
    expect(propagationCorrection(1500, 0, northerly)).toBeCloseTo(-15);
  });

  it('leaves only the inversion when the air is calm', () => {
    const still: WindState = { windSpeedMs: 0.5, windFromDeg: 0, inversion: true };
    for (const bearing of [0, 90, 180, 270]) {
      expect(propagationCorrection(1000, bearing, still)).toBeCloseTo(inversionTerm(1000));
    }
    expect(propagationCorrection(1000, 0, calm)).toBe(0);
  });

  it('halves the upwind shadow when an inversion is working against it', () => {
    const windy: WindState = { ...northerly, inversion: true };
    // +5 from the inversion, and half of the −15 shadow.
    expect(propagationCorrection(1500, 0, windy)).toBeCloseTo(5 - 7.5);
  });

  it('takes the larger of inversion and downwind rather than stacking them', () => {
    const windy: WindState = { ...northerly, inversion: true };
    // 300 m: inversion is worth 5, downwind only 2.5.
    expect(propagationCorrection(300, 180, windy)).toBeCloseTo(5);
    // 1 km: downwind is worth 7, inversion still 5.
    expect(propagationCorrection(1000, 180, windy)).toBeCloseTo(7);
  });

  it('reads the wind direction the way a forecast states it', () => {
    // Wind FROM 270° blows towards 90°, so an easterly bearing is the downwind one.
    const westerly: WindState = { windSpeedMs: 5, windFromDeg: 270, inversion: false };
    expect(propagationCorrection(1000, 90, westerly)).toBeCloseTo(7);
    expect(propagationCorrection(1000, 270, westerly)).toBeLessThan(-10);
  });
});

describe('omnidirectional wind', () => {
  it('makes every bearing downwind for the worst case', () => {
    const w = CONDITION_PRESETS.worst;
    for (const bearing of [0, 45, 90, 180, 270, 359]) {
      expect(propagationCorrection(1000, bearing, w)).toBeCloseTo(7);
    }
  });

  it('never puts a house in a shadow under the worst case', () => {
    for (const d of [100, 500, 1000, 3000]) {
      for (const bearing of [0, 90, 180, 270]) {
        expect(propagationCorrection(d, bearing, CONDITION_PRESETS.worst)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('makes every bearing upwind for the favourable case', () => {
    const w = CONDITION_PRESETS.favourable;
    for (const bearing of [0, 90, 180, 270]) {
      expect(propagationCorrection(2000, bearing, w)).toBeCloseTo(-15);
    }
  });
});

describe('condition presets', () => {
  it('saturates the wind factor for both enveloping presets', () => {
    expect(speedFactor(CONDITION_PRESETS.worst.windSpeedMs)).toBe(1);
    expect(speedFactor(CONDITION_PRESETS.favourable.windSpeedMs)).toBe(1);
  });

  it('is loudest under worst and quietest under favourable at every distance', () => {
    for (const d of [200, 500, 1000, 2000]) {
      const worst = propagationCorrection(d, 0, CONDITION_PRESETS.worst);
      const typical = propagationCorrection(d, 0, CONDITION_PRESETS.typical);
      const favourable = propagationCorrection(d, 0, CONDITION_PRESETS.favourable);
      expect(worst).toBeGreaterThanOrEqual(typical);
      expect(typical).toBeGreaterThanOrEqual(favourable);
    }
  });
});
