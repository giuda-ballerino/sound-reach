import { describe, expect, it } from 'vitest';
import { DEFAULT_RIG, levelAt, reachDistance } from './acoustics';
import { CONDITION_PRESETS, type Conditions } from './conditions';
import { distanceBearing } from './geo';
import { newScenario, sanitize } from './state';
import { gridShielding, ZONE_BEARING_STEP_DEG, ZONE_STEP_M } from './terrainService';
import { REACH_STEP_M, contourRing, flatGround, maxReach, shieldedReach, type ShieldingAt } from './zones';

const rig = { ...DEFAULT_RIG, directional: false };
const plain: Conditions = { ...CONDITION_PRESETS.typical, groundSoft: false };
const stage = { lat: 38.1058, lon: 12.723 };

describe('levelAt with shielding', () => {
  it('subtracts the given dB from each band independently', () => {
    const open = levelAt(rig, plain, 500, 90);
    const shielded = levelAt(rig, plain, 500, 90, { la: 14, lc: 5 });
    expect(open.la - shielded.la).toBeCloseTo(14);
    expect(open.lc - shielded.lc).toBeCloseTo(5);
  });

  it('is unchanged when no shielding is passed', () => {
    expect(levelAt(rig, plain, 500, 90, { la: 0, lc: 0 })).toEqual(levelAt(rig, plain, 500, 90));
  });
});

describe('shieldedReach', () => {
  it('marches in the same steps the zone grid is sampled at', () => {
    // A coarser march could stride over a ridge the shielding data can actually resolve.
    expect(REACH_STEP_M).toBe(ZONE_STEP_M);
  });

  it('matches the unshielded reach over flat ground, to within 0.1 m', () => {
    // Flat ground is monotonic, so march-then-bisect must land on the same root as the plain
    // bisection in acoustics.reachDistance.
    const directional = { ...DEFAULT_RIG };
    for (const [params, target] of [
      [rig, 60],
      [rig, 45],
      [rig, 80],
      [directional, 60],
      [directional, 35],
    ] as const) {
      for (const b of [0, 37, 90, 180, 300, undefined]) {
        const marched = shieldedReach(params, plain, target, b);
        const bisected = reachDistance(params, plain, target, b);
        expect(Math.abs(marched - bisected)).toBeLessThan(0.1);
      }
    }
  });

  it('is unchanged by a callback that shields nothing', () => {
    for (const b of [0, 37, 180, 300]) {
      const zeros = shieldedReach(rig, plain, 60, b, 'la', () => ({ la: 0, lc: 0 }));
      expect(Math.abs(zeros - reachDistance(rig, plain, 60, b))).toBeLessThan(0.1);
    }
  });

  it('clamps to maxDistance when the target is never reached', () => {
    expect(shieldedReach(rig, plain, 5, 0, 'la', flatGround, 2000)).toBe(2000);
  });

  it('returns the reference distance when the target is already met at the source', () => {
    expect(shieldedReach(rig, plain, 200, 0)).toBe(10);
  });

  it('returns the FIRST crossing when terrain makes the level non-monotonic', () => {
    // A band of heavy shielding from 300 to 500 m: the level dives below the target at 300 m,
    // then climbs back above it past 500 m and only falls again just past a kilometre. A
    // bisection over the whole range converges on that last crossing and draws the contour
    // three times too far out; the march has to stop at 300.
    const RIDGE_FROM = 300;
    const RIDGE_TO = 500;
    const bumpy: ShieldingAt = (_b, d) =>
      d >= RIDGE_FROM && d <= RIDGE_TO ? { la: 20, lc: 8 } : { la: 0, lc: 0 };
    const target = 60;
    const at = (d: number) => levelAt(rig, plain, d, 0, bumpy(0, d)).la;

    // The shape the test depends on: above, below, above again, then finally below.
    expect(at(RIDGE_FROM - 1)).toBeGreaterThan(target);
    expect(at(RIDGE_FROM)).toBeLessThan(target);
    expect(at(RIDGE_TO + 100)).toBeGreaterThan(target);
    expect(at(1500)).toBeLessThan(target);

    expect(shieldedReach(rig, plain, target, 0, 'la', bumpy)).toBeCloseTo(RIDGE_FROM, 1);
    // And the later crossing really is out where a whole-range bisection would have landed.
    expect(shieldedReach(rig, plain, target, 0)).toBeGreaterThan(900);
  });

  it('pulls the contour in behind a ridge', () => {
    // 15 dB off everywhere to the south, nothing to the north.
    const south: ShieldingAt = (bearing) => (bearing > 90 && bearing < 270 ? { la: 15, lc: 5 } : { la: 0, lc: 0 });
    expect(shieldedReach(rig, plain, 60, 180, 'la', south)).toBeLessThan(shieldedReach(rig, plain, 60, 0, 'la', south) / 2);
  });

  it('shrinks the traced ring only where the shielding applies', () => {
    const south: ShieldingAt = (bearing) => (bearing > 90 && bearing < 270 ? { la: 15, lc: 5 } : { la: 0, lc: 0 });
    const flat = contourRing(stage, rig, plain, 60);
    const ring = contourRing(stage, rig, plain, 60, 'la', south);
    const reach = (ps: typeof ring, i: number) => distanceBearing(stage, ps[i]).distance;
    expect(reach(ring, 0)).toBeCloseTo(reach(flat, 0), 3);
    const southIndex = ring.findIndex((_, i) => i * 3 === 180);
    expect(reach(ring, southIndex)).toBeLessThan(reach(flat, southIndex));
    expect(maxReach(rig, plain, [60], 'la', south)).toBeCloseTo(maxReach(rig, plain, [60]), 3);
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
