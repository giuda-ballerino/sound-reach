import { describe, expect, it } from 'vitest';
import { distanceBearing } from './geo';
import {
  BARRIER_MAX_DB,
  MAX_PROFILE_POINTS,
  analyseProfile,
  barrierPathDifference,
  maekawaAttenuation,
  sampleProfile,
  shieldingFor,
  type ProfilePoint,
} from './terrain';

const stage = { lat: 38.1058, lon: 12.723 };

/** A synthetic profile: `span` m long, flat at `base` m except for one triangular ridge. */
function ridgeProfile(span: number, ridgeHeight: number, points = 21, base = 0): ProfilePoint[] {
  const out: ProfilePoint[] = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    // A single peak at the midpoint, falling linearly to the ends.
    const elevationM = base + ridgeHeight * Math.max(0, 1 - Math.abs(t - 0.5) / 0.1);
    out.push({ lat: stage.lat, lon: stage.lon + t * 0.001, distanceM: t * span, elevationM });
  }
  return out;
}

describe('sampleProfile', () => {
  it('includes both ends and spaces the rest by the step', () => {
    const to = { lat: 38.1058, lon: 12.73 };
    const profile = sampleProfile(stage, to, 30);
    expect(profile[0]).toMatchObject({ lat: stage.lat, lon: stage.lon, distanceM: 0 });
    expect(profile[profile.length - 1]).toMatchObject({ lat: to.lat, lon: to.lon });
    const span = distanceBearing(stage, to).distance;
    expect(profile[profile.length - 1].distanceM).toBeCloseTo(span, 6);
    const step = profile[1].distanceM - profile[0].distanceM;
    expect(step).toBeLessThanOrEqual(30 + 1e-9);
    for (let i = 1; i < profile.length; i++) {
      expect(profile[i].distanceM - profile[i - 1].distanceM).toBeCloseTo(step, 6);
    }
  });

  it('stays on the geodesic between the ends', () => {
    const to = { lat: 38.15, lon: 12.78 };
    const { bearing } = distanceBearing(stage, to);
    for (const p of sampleProfile(stage, to).slice(1)) {
      const leg = distanceBearing(stage, p);
      expect(leg.bearing).toBeCloseTo(bearing, 1);
    }
  });

  it('stretches the step rather than exceeding 100 points', () => {
    const to = { lat: 38.3, lon: 12.723 };
    const profile = sampleProfile(stage, to, 30);
    expect(profile.length).toBe(MAX_PROFILE_POINTS);
    expect(profile[1].distanceM).toBeGreaterThan(30);
  });

  it('degenerates to a single point when both ends coincide', () => {
    expect(sampleProfile(stage, stage)).toHaveLength(1);
  });
});

describe('barrierPathDifference', () => {
  it('reports a negative path difference over flat ground', () => {
    const { deltaM } = barrierPathDifference(ridgeProfile(600, 0));
    expect(deltaM).toBeLessThanOrEqual(0);
    expect(shieldingFor(ridgeProfile(600, 0))).toEqual({ la: 0, lc: 0 });
  });

  it('points at the ridge', () => {
    const profile = ridgeProfile(600, 30, 21);
    const { index, deltaM } = barrierPathDifference(profile);
    expect(profile[index].elevationM).toBeCloseTo(30);
    expect(profile[index].distanceM).toBeCloseTo(300);
    expect(deltaM).toBeCloseTo(2.425, 2);
  });

  it('ignores a ridge that stays below the line of sight', () => {
    // Source and receiver on a 200 m plateau, a 40 m hillock in the valley between them.
    const profile: ProfilePoint[] = [
      { lat: 0, lon: 0, distanceM: 0, elevationM: 200 },
      { lat: 0, lon: 0, distanceM: 300, elevationM: 40 },
      { lat: 0, lon: 0, distanceM: 600, elevationM: 200 },
    ];
    expect(barrierPathDifference(profile).deltaM).toBeLessThan(0);
  });

  it('has no opinion when there is no ground in between', () => {
    const ends: ProfilePoint[] = [
      { lat: 0, lon: 0, distanceM: 0, elevationM: 0 },
      { lat: 0, lon: 0, distanceM: 600, elevationM: 0 },
    ];
    expect(barrierPathDifference(ends)).toEqual({ deltaM: Number.NEGATIVE_INFINITY, index: -1 });
    expect(shieldingFor(ends)).toEqual({ la: 0, lc: 0 });
  });

  it('uses the source and receiver heights above ground', () => {
    const profile = ridgeProfile(600, 12);
    const low = barrierPathDifference(profile, 2, 4).deltaM;
    // A receiver on a higher floor sees more of the stage over the ridge.
    const high = barrierPathDifference(profile, 2, 14).deltaM;
    expect(high).toBeLessThan(low);
  });
});

describe('maekawaAttenuation', () => {
  it('is 4.8 dB at grazing incidence (N = 0)', () => {
    expect(maekawaAttenuation(0, 1000)).toBeCloseTo(4.8, 1);
  });

  it('is nothing at all when the line of sight is well clear (N < −0.2)', () => {
    // N = −0.2 at 1 kHz is δ = −0.0343 m.
    expect(maekawaAttenuation(-0.05, 1000)).toBe(0);
    expect(maekawaAttenuation(-5, 1000)).toBe(0);
    expect(maekawaAttenuation(Number.NEGATIVE_INFINITY, 1000)).toBe(0);
  });

  it('caps at 20 dB for a single edge', () => {
    expect(maekawaAttenuation(50, 1000)).toBe(BARRIER_MAX_DB);
    expect(maekawaAttenuation(1000, 63)).toBe(BARRIER_MAX_DB);
  });

  it('rises with frequency for the same path difference', () => {
    expect(maekawaAttenuation(0.3, 1000)).toBeGreaterThan(maekawaAttenuation(0.3, 63));
  });
});

describe('shieldingFor', () => {
  it('takes 15–20 dB(A) and only 5–10 dB of bass off a modest ridge', () => {
    // A 12 m ridge halfway along 600 m: δ = 0.27 m, which is many wavelengths at 1 kHz
    // and a fraction of one at 63 Hz.
    const { la, lc } = shieldingFor(ridgeProfile(600, 12));
    expect(la).toBeGreaterThan(15);
    expect(la).toBeLessThan(20);
    expect(lc).toBeGreaterThan(5);
    expect(lc).toBeLessThan(10);
  });

  it('saturates the A‑weighted band on a big ridge while the bass still gets through', () => {
    // A 30 m ridge gives δ = 2.43 m, past the 20 dB single‑edge cap at 1 kHz but worth
    // only ~13 dB at 63 Hz. The asymmetry is the whole point.
    const { la, lc } = shieldingFor(ridgeProfile(600, 30));
    expect(la).toBe(BARRIER_MAX_DB);
    expect(lc).toBeCloseTo(13.2, 1);
    expect(la - lc).toBeGreaterThan(5);
  });

  it('never shields more in the bass than in the A‑weighted band', () => {
    for (const h of [0, 2, 5, 10, 20, 40, 80]) {
      const { la, lc } = shieldingFor(ridgeProfile(600, h));
      expect(lc).toBeLessThanOrEqual(la + 1e-9);
    }
  });
});

describe('analyseProfile', () => {
  it('carries the path difference and the ridge index alongside the attenuation', () => {
    const profile = ridgeProfile(600, 30);
    const a = analyseProfile(profile);
    expect(a.index).toBeGreaterThan(0);
    expect(a.index).toBeLessThan(profile.length - 1);
    expect(a).toMatchObject(shieldingFor(profile));
  });
});
