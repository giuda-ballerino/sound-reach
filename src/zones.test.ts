import { describe, expect, it } from 'vitest';
import { DEFAULT_RIG, levelAt, reachDistance } from './acoustics';
import { distanceBearing } from './geo';
import { newScenario, sanitize } from './state';
import { gridShielding, ZONE_BEARING_STEP_DEG, ZONE_STEP_M } from './terrainService';
import { contourRing, flatGround, maxReach, shieldedReach, type ShieldingAt } from './zones';

const rig = { ...DEFAULT_RIG, night: false, softGround: false, directional: false };
const stage = { lat: 38.1058, lon: 12.723 };

describe('levelAt with shielding', () => {
  it('subtracts the given dB from each band independently', () => {
    const open = levelAt(rig, 500, 90);
    const shielded = levelAt(rig, 500, 90, { la: 14, lc: 5 });
    expect(open.la - shielded.la).toBeCloseTo(14);
    expect(open.lc - shielded.lc).toBeCloseTo(5);
  });

  it('is unchanged when no shielding is passed', () => {
    expect(levelAt(rig, 500, 90, { la: 0, lc: 0 })).toEqual(levelAt(rig, 500, 90));
  });
});

describe('shieldedReach', () => {
  it('matches the unshielded reach over flat ground', () => {
    for (const b of [0, 37, 180, 300]) {
      expect(shieldedReach(rig, 60, b)).toBe(reachDistance(rig, 60, b));
      expect(shieldedReach(rig, 60, b, 'la', () => ({ la: 0, lc: 0 }))).toBeCloseTo(reachDistance(rig, 60, b), 6);
    }
  });

  it('pulls the contour in behind a ridge', () => {
    // 15 dB off everywhere to the south, nothing to the north.
    const south: ShieldingAt = (bearing) => (bearing > 90 && bearing < 270 ? { la: 15, lc: 5 } : { la: 0, lc: 0 });
    expect(shieldedReach(rig, 60, 180, 'la', south)).toBeLessThan(shieldedReach(rig, 60, 0, 'la', south) / 2);
  });

  it('shrinks the traced ring only where the shielding applies', () => {
    const south: ShieldingAt = (bearing) => (bearing > 90 && bearing < 270 ? { la: 15, lc: 5 } : { la: 0, lc: 0 });
    const flat = contourRing(stage, rig, 60);
    const ring = contourRing(stage, rig, 60, 'la', south);
    const reach = (ps: typeof ring, i: number) => distanceBearing(stage, ps[i]).distance;
    expect(reach(ring, 0)).toBeCloseTo(reach(flat, 0), 3);
    const southIndex = ring.findIndex((_, i) => i * 3 === 180);
    expect(reach(ring, southIndex)).toBeLessThan(reach(flat, southIndex));
    expect(maxReach(rig, [60], 'la', south)).toBeCloseTo(maxReach(rig, [60]), 3);
  });
});

describe('gridShielding', () => {
  // Two bearings' worth of rows is enough to exercise both interpolations.
  const rows = Array.from({ length: 36 }, (_, b) =>
    Array.from({ length: 60 }, (_, j) => ({ la: b === 0 ? j + 1 : 0, lc: 0 })),
  );
  const at = gridShielding(rows);

  it('is zero at the stage and reads the grid at the sample distances', () => {
    expect(at(0, 0)).toEqual({ la: 0, lc: 0 });
    expect(at(0, ZONE_STEP_M).la).toBeCloseTo(1);
    expect(at(0, 3 * ZONE_STEP_M).la).toBeCloseTo(3);
  });

  it('interpolates between the two nearest distances', () => {
    expect(at(0, 1.5 * ZONE_STEP_M).la).toBeCloseTo(1.5);
    expect(at(0, 0.5 * ZONE_STEP_M).la).toBeCloseTo(0.5);
  });

  it('interpolates between the two nearest bearings', () => {
    expect(at(ZONE_BEARING_STEP_DEG / 2, ZONE_STEP_M).la).toBeCloseTo(0.5);
    expect(at(ZONE_BEARING_STEP_DEG, ZONE_STEP_M).la).toBeCloseTo(0);
    // Wrapping back round to north from the last bearing.
    expect(at(355, ZONE_STEP_M).la).toBeCloseTo(0.5);
    expect(at(-5, ZONE_STEP_M).la).toBeCloseTo(0.5);
  });

  it('holds the last value past the edge of the grid', () => {
    expect(at(0, 10_000).la).toBeCloseTo(60);
  });
});

describe('scenario terrain settings', () => {
  it('defaults to on, 2 m and 4 m', () => {
    expect(newScenario().terrain).toEqual({ enabled: true, sourceHeightM: 2, receiverHeightM: 4 });
  });

  it('fills the defaults in for a scenario file saved before terrain existed', () => {
    const old = { ...newScenario(), terrain: undefined };
    expect(sanitize(old)?.terrain).toEqual({ enabled: true, sourceHeightM: 2, receiverHeightM: 4 });
  });

  it('keeps sane values and rejects nonsense', () => {
    const s = sanitize({ terrain: { enabled: false, sourceHeightM: 6, receiverHeightM: 'tall' } });
    expect(s?.terrain).toEqual({ enabled: false, sourceHeightM: 6, receiverHeightM: 4 });
    expect(sanitize({ terrain: { sourceHeightM: -3 } })?.terrain.sourceHeightM).toBe(2);
  });
});

describe('flat ground default', () => {
  it('is what the zone helpers use when nothing is passed', () => {
    expect(flatGround(123, 456)).toEqual({ la: 0, lc: 0 });
  });
});
