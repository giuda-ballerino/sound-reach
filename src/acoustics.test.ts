import { describe, expect, it } from 'vitest';
import { DEFAULT_RIG, levelAt, offAxisAngle, reachDistance, sourceLevel, topsDirectivity } from './acoustics';
import { destination, distanceBearing, parseLatLon } from './geo';
import { contourRing, legalBands } from './zones';

const rig = { ...DEFAULT_RIG, night: false, softGround: false, directional: false };

describe('source level', () => {
  it('is the rig maximum at 100%', () => {
    expect(sourceLevel({ ...rig, volumePct: 100 })).toBeCloseTo(112);
  });
  it('drops 10 dB per halving of the percentage', () => {
    expect(sourceLevel({ ...rig, volumePct: 50 })).toBeCloseTo(102);
    expect(sourceLevel({ ...rig, volumePct: 25 })).toBeCloseTo(92);
  });
});

describe('propagation', () => {
  it('falls about 6 dB per doubling near the source', () => {
    const l10 = levelAt(rig, 10).la;
    const l20 = levelAt(rig, 20).la;
    expect(l10 - l20).toBeGreaterThan(5.9);
    expect(l10 - l20).toBeLessThan(6.2);
  });
  it('never reports a level above the reference inside 10 m', () => {
    expect(levelAt(rig, 1).la).toBeCloseTo(levelAt(rig, 10).la);
  });
  it('bass band sits above the A-weighted band by the configured excess at 10 m', () => {
    const { la, lc } = levelAt(rig, 10);
    expect(lc - la).toBeCloseTo(rig.bassExcess);
  });
  it('night conditions add up to 5 dB far away', () => {
    const quiet = levelAt({ ...rig, night: false }, 1000).la;
    const night = levelAt({ ...rig, night: true }, 1000).la;
    expect(night - quiet).toBeCloseTo(5);
  });
  it('reach distance inverts levelAt', () => {
    const d = reachDistance(rig, 60, undefined);
    expect(levelAt(rig, d).la).toBeCloseTo(60, 2);
  });
  it('a 100% rig on an open field reaches 60 dB(A) around a kilometre at night', () => {
    const d = reachDistance({ ...DEFAULT_RIG, volumePct: 100 }, 60, DEFAULT_RIG.aimDeg);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(2200);
  });
});

describe('directivity', () => {
  it('is 0 dB on axis and −12 dB behind', () => {
    expect(topsDirectivity(0)).toBe(0);
    expect(topsDirectivity(180)).toBeCloseTo(-12);
    expect(topsDirectivity(90)).toBeCloseTo(-6);
  });
  it('off-axis angle wraps around north', () => {
    expect(offAxisAngle(350, 10)).toBeCloseTo(20);
    expect(offAxisAngle(190, 10)).toBeCloseTo(180);
  });
  it('a directional rig is quieter behind than in front', () => {
    const p = { ...rig, directional: true, aimDeg: 180 };
    expect(levelAt(p, 300, 180).la).toBeGreaterThan(levelAt(p, 300, 0).la + 10);
  });
});

describe('geo', () => {
  it('parses Google Maps style coordinates', () => {
    expect(parseLatLon('38.1058, 12.7230')).toEqual({ lat: 38.1058, lon: 12.723 });
    expect(parseLatLon('38,1058; 12,7230')).toEqual({ lat: 38.1058, lon: 12.723 });
    expect(parseLatLon('nope')).toBeNull();
    expect(parseLatLon('95, 10')).toBeNull();
  });
  it('destination and distanceBearing are inverses', () => {
    const a = { lat: 38.1, lon: 12.7 };
    const b = destination(a, 37, 1234);
    const { distance, bearing } = distanceBearing(a, b);
    expect(distance).toBeCloseTo(1234, 0);
    expect(bearing).toBeCloseTo(37, 1);
  });
});

describe('zones', () => {
  it('legal bands tile the space below the limit without gaps', () => {
    const b = legalBands(60);
    expect(b[0].lower).toBe(60);
    expect(b[1].upper).toBe(60);
    expect(b[2].upper).toBe(55);
  });
  it('contour ring is closed and roughly circular for an omni source', () => {
    const stage = { lat: 38.1, lon: 12.7 };
    const ring = contourRing(stage, rig, 60);
    expect(ring.length).toBe(120);
    const dists = ring.map((p) => distanceBearing(stage, p).distance);
    const min = Math.min(...dists);
    const max = Math.max(...dists);
    expect(max / min).toBeLessThan(1.02);
  });
});
