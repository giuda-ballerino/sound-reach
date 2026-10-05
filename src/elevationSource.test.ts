import { describe, expect, it } from 'vitest';
import { FALLBACK_LATCH_MS, TieredElevation, type ElevationSource } from './elevationSource';
import type { LatLon } from './geo';

const p: LatLon[] = [{ lat: 38, lon: 12 }];
const pair: LatLon[] = [
  { lat: 38, lon: 12 },
  { lat: 39, lon: 13 },
];

interface Stub extends ElevationSource {
  calls: number;
  /** Flip to make the source start or stop failing mid-test. */
  broken: boolean;
}

/** A source that answers with one fixed height, or refuses while `broken`. */
function stub(height: number, opts: { broken?: boolean; hasCache?: boolean } = {}): Stub {
  const s: Stub = {
    calls: 0,
    broken: opts.broken ?? false,
    cached: (points: LatLon[]) => ((opts.hasCache ?? true) && !s.broken ? points.map(() => height) : null),
    elevations: async (points: LatLon[]) => {
      s.calls++;
      if (s.broken) throw new Error('unavailable');
      return points.map(() => height);
    },
  };
  return s;
}

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const LATCH = 2 * 60_000;

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
    const tier = new TieredElevation(stub(100, { broken: true }), stub(200));
    expect(await tier.elevations(p)).toEqual([200]);
    expect(tier.usingFallback).toBe(true);
  });

  it('never mixes two DEMs inside one call', async () => {
    // The primary fails after it would have had some points in hand; every value handed back
    // must still come from the fallback alone, or the profile gets a fake step in it.
    const primary = stub(100, { broken: true });
    const fallback = stub(200);
    const tier = new TieredElevation(primary, fallback);
    const out = await tier.elevations(pair);
    expect(out).toEqual([200, 200]);
    expect(new Set(out).size).toBe(1);
  });

  it('reads through to whichever source is currently in charge', async () => {
    const c = clock();
    const primary = stub(100);
    const tier = new TieredElevation(primary, stub(200), { latchMs: LATCH, now: c.now });
    expect(tier.cached(p)).toEqual([100]);
    primary.broken = true;
    await tier.elevations(p);
    expect(tier.cached(p)).toEqual([200]);
  });

  it('keeps the primary untouched for the whole latch window', async () => {
    const c = clock();
    const primary = stub(100, { broken: true });
    const fallback = stub(200);
    const tier = new TieredElevation(primary, fallback, { latchMs: LATCH, now: c.now });

    await tier.elevations(p);
    expect(primary.calls).toBe(1);

    c.advance(LATCH - 1);
    expect(await tier.elevations(p)).toEqual([200]);
    expect(primary.calls).toBe(1);
    expect(tier.usingFallback).toBe(true);
    expect(fallback.calls).toBe(2);
  });

  it('retries the primary as soon as the latch expires, and switches back when it answers', async () => {
    const c = clock();
    const primary = stub(100, { broken: true });
    const fallback = stub(200);
    const tier = new TieredElevation(primary, fallback, { latchMs: LATCH, now: c.now });

    await tier.elevations(p);
    expect(tier.usingFallback).toBe(true);

    primary.broken = false;
    c.advance(LATCH);
    expect(await tier.elevations(p)).toEqual([100]);
    expect(primary.calls).toBe(2);
    expect(tier.usingFallback).toBe(false);
    expect(tier.cached(p)).toEqual([100]);
  });

  it('renews the latch when the retry fails too', async () => {
    const c = clock();
    const primary = stub(100, { broken: true });
    const tier = new TieredElevation(primary, stub(200), { latchMs: LATCH, now: c.now });

    await tier.elevations(p);
    c.advance(LATCH);
    expect(await tier.elevations(p)).toEqual([200]);
    expect(primary.calls).toBe(2);

    // The second failure buys another full window rather than retrying on every request.
    c.advance(LATCH - 1);
    expect(await tier.elevations(p)).toEqual([200]);
    expect(primary.calls).toBe(2);

    c.advance(1);
    await tier.elevations(p);
    expect(primary.calls).toBe(3);
  });

  it('defaults the window to two minutes', () => {
    expect(FALLBACK_LATCH_MS).toBe(2 * 60_000);
  });

  it('propagates the failure when neither source can answer', async () => {
    const tier = new TieredElevation(stub(100, { broken: true }), stub(200, { broken: true }));
    await expect(tier.elevations(p)).rejects.toThrow('unavailable');
  });

  it('reports a miss rather than reaching past the active source', () => {
    const tier = new TieredElevation(stub(100, { hasCache: false }), stub(200));
    expect(tier.cached(p)).toBeNull();
  });
});
