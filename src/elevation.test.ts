import { describe, expect, it } from 'vitest';
import { ElevationError, ElevationService, MAX_POINTS_PER_REQUEST, coordKey } from './elevation';
import type { LatLon } from './geo';

/** A grid of distinct points whose elevation is simply their index. */
function points(n: number): LatLon[] {
  return Array.from({ length: n }, (_, i) => ({ lat: 38 + i / 1000, lon: 12 + i / 1000 }));
}

interface Recorder {
  fetchImpl: typeof fetch;
  urls: string[];
  /** Highest number of requests that were in flight at the same time. */
  peak: number;
}

function recorder(respond?: (url: string, n: number) => Response | Promise<Response>): Recorder {
  const urls: string[] = [];
  let inFlight = 0;
  const rec: Recorder = {
    urls,
    peak: 0,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      inFlight++;
      rec.peak = Math.max(rec.peak, inFlight);
      try {
        const n = new URL(url).searchParams.get('latitude')!.split(',').length;
        // Yield twice so concurrent callers actually overlap.
        await Promise.resolve();
        await Promise.resolve();
        if (respond) return await respond(url, n);
        return Response.json({ elevation: Array.from({ length: n }, (_, i) => i) });
      } finally {
        inFlight--;
      }
    }) as typeof fetch,
  };
  return rec;
}

const service = (rec: Recorder, retryDelayMs = 0) =>
  new ElevationService({ fetchImpl: rec.fetchImpl, storage: null, retryDelayMs });

describe('coordKey', () => {
  it('rounds to 5 decimals so near‑identical points share a cache entry', () => {
    expect(coordKey({ lat: 38.123456, lon: 12.7 })).toBe(coordKey({ lat: 38.1234561, lon: 12.7000004 }));
    expect(coordKey({ lat: 38.12345, lon: 12.7 })).not.toBe(coordKey({ lat: 38.12346, lon: 12.7 }));
  });
});

describe('batching', () => {
  it('splits into requests of at most 100 points', async () => {
    const rec = recorder();
    const out = await service(rec).elevations(points(250));
    expect(rec.urls).toHaveLength(3);
    for (const url of rec.urls) {
      expect(new URL(url).searchParams.get('latitude')!.split(',').length).toBeLessThanOrEqual(MAX_POINTS_PER_REQUEST);
    }
    expect(out).toHaveLength(250);
  });

  it('keeps at most 3 requests in flight', async () => {
    const rec = recorder();
    await service(rec).elevations(points(1000));
    expect(rec.urls).toHaveLength(10);
    expect(rec.peak).toBeLessThanOrEqual(3);
    expect(rec.peak).toBe(3);
  });

  it('asks for each distinct coordinate once, and returns values in the order requested', async () => {
    const rec = recorder((_url, n) => Response.json({ elevation: Array.from({ length: n }, (_, i) => 100 + i) }));
    const a = { lat: 38, lon: 12 };
    const b = { lat: 39, lon: 13 };
    const out = await service(rec).elevations([a, b, a, b, a]);
    expect(new URL(rec.urls[0]).searchParams.get('latitude')).toBe('38.00000,39.00000');
    expect(out).toEqual([100, 101, 100, 101, 100]);
  });
});

describe('caching', () => {
  it('does not refetch what it already knows', async () => {
    const rec = recorder();
    const svc = service(rec);
    await svc.elevations(points(10));
    await svc.elevations(points(10));
    expect(rec.urls).toHaveLength(1);
    expect(svc.cached(points(10))).toHaveLength(10);
  });

  it('reports a cache miss rather than guessing', async () => {
    const rec = recorder();
    const svc = service(rec);
    await svc.elevations(points(3));
    expect(svc.cached(points(4))).toBeNull();
  });

  it('drops the oldest entries past the cap', async () => {
    const rec = recorder();
    const svc = new ElevationService({ fetchImpl: rec.fetchImpl, storage: null, maxEntries: 120 });
    await svc.elevations(points(200));
    expect(svc.cached(points(1))).toBeNull();
    expect(svc.cached(points(200).slice(-120))).toHaveLength(120);
  });

  it('persists to storage and restores from it without any network', async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const first = recorder();
    await new ElevationService({ fetchImpl: first.fetchImpl, storage }).elevations(points(5));
    expect(store.size).toBe(1);

    const second = recorder();
    const restored = new ElevationService({ fetchImpl: second.fetchImpl, storage });
    expect(restored.cached(points(5))).toEqual([0, 1, 2, 3, 4]);
    expect(second.urls).toHaveLength(0);
  });

  it('starts empty when the stored cache is corrupt', () => {
    const storage = { getItem: () => 'not json', setItem: () => {} };
    expect(new ElevationService({ fetchImpl: recorder().fetchImpl, storage }).cached(points(1))).toBeNull();
  });
});

describe('failures', () => {
  it('retries a 429 once and succeeds', async () => {
    let calls = 0;
    const rec = recorder((_url, n) =>
      ++calls === 1 ? new Response('slow down', { status: 429 }) : Response.json({ elevation: Array(n).fill(7) }),
    );
    expect(await service(rec).elevations(points(2))).toEqual([7, 7]);
    expect(calls).toBe(2);
  });

  it('retries a 503 once and gives up on the second failure', async () => {
    let calls = 0;
    const rec = recorder(() => {
      calls++;
      return new Response('nope', { status: 503 });
    });
    await expect(service(rec).elevations(points(2))).rejects.toBeInstanceOf(ElevationError);
    expect(calls).toBe(2);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const rec = recorder(() => {
      calls++;
      return new Response('bad', { status: 400 });
    });
    await expect(service(rec).elevations(points(2))).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });

  it('retries a dropped connection once', async () => {
    let calls = 0;
    const rec = recorder((_url, n) => {
      if (++calls === 1) throw new TypeError('Failed to fetch');
      return Response.json({ elevation: Array(n).fill(3) });
    });
    expect(await service(rec).elevations(points(1))).toEqual([3]);
  });

  it('rejects when the response is the wrong shape', async () => {
    const rec = recorder(() => Response.json({ elevation: [1] }));
    await expect(service(rec).elevations(points(2))).rejects.toThrow(/of 2 values/);
  });

  it('treats a null elevation (open sea) as sea level', async () => {
    const rec = recorder(() => Response.json({ elevation: [null, 12] }));
    expect(await service(rec).elevations(points(2))).toEqual([0, 12]);
  });
});
