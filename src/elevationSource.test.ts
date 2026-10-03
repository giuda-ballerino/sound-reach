import { describe, expect, it } from 'vitest';
import { TieredElevation, type ElevationSource } from './elevationSource';
import type { LatLon } from './geo';

const p: LatLon[] = [{ lat: 38, lon: 12 }];

/** A source that answers with one fixed height, or refuses. */
function stub(height: number | null, hasCache = true): ElevationSource & { calls: number } {
  const s = {
    calls: 0,
    cached: (points: LatLon[]) => (hasCache && height !== null ? points.map(() => height) : null),
    elevations: async (points: LatLon[]) => {
      s.calls++;
      if (height === null) throw new Error('unavailable');
      return points.map(() => height);
    },
  };
  return s;
}

describe('TieredElevation', () => {
  it('uses the primary while it works and never touches the fallback', async () => {
    const primary = stub(100);
    const fallback = stub(200);
    const tier = new TieredElevation(primary, fallback);
    expect(await tier.elevations(p)).toEqual([100]);
    expect(tier.cached(p)).toEqual([100]);
    expect(fallback.calls).toBe(0);
    expect(tier.usingFallback).toBe(false);
  });

  it('falls back when the primary fails', async () => {
    const tier = new TieredElevation(stub(null), stub(200));
    expect(await tier.elevations(p)).toEqual([200]);
    expect(tier.usingFallback).toBe(true);
  });

  it('latches, so one profile never mixes two different DEMs', async () => {
    const primary = stub(null);
    const fallback = stub(200);
    const tier = new TieredElevation(primary, fallback);
    await tier.elevations(p);
    const after = primary.calls;
    await tier.elevations(p);
    // The primary is not retried, and reads come from the same source as the writes.
    expect(primary.calls).toBe(after);
    expect(tier.cached(p)).toEqual([200]);
    expect(fallback.calls).toBe(2);
  });

  it('reports a miss rather than reaching past the active source', () => {
    const tier = new TieredElevation(stub(100, false), stub(200));
    expect(tier.cached(p)).toBeNull();
  });

  it('propagates the failure when neither source can answer', async () => {
    const tier = new TieredElevation(stub(null), stub(null));
    await expect(tier.elevations(p)).rejects.toThrow('unavailable');
  });
});
