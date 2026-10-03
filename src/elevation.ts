/**
 * Ground elevations from the Open‑Meteo Elevation API (Copernicus DEM GLO‑90, ~90 m posts).
 * Free, no key, CORS‑enabled; up to 100 coordinate pairs per call.
 *
 * This is the FALLBACK source. One point costs one slot in a 100-point request, so a zone grid
 * is dozens of calls and dragging burns the per-IP rate limit; `demTiles.ts` is the primary.
 * Kept because it is a different DEM from a different host, so it still answers when the tile
 * mosaic does not.
 *
 *   GET https://api.open-meteo.com/v1/elevation?latitude=38.1,38.2&longitude=12.7,12.8
 *   → {"elevation":[123.0,456.0]}
 *
 * Attribution: elevation data © Open‑Meteo, CC BY 4.0 (Copernicus DEM).
 *
 * Everything is cached by coordinate rounded to 5 decimals (~1 m), in memory and in
 * localStorage, so panning and dragging do not hammer the API. Network failures reject with
 * `ElevationError` so callers can fall back to flat terrain instead of showing nothing.
 */

import type { ElevationSource, FetchProgress } from './elevationSource';
import type { LatLon } from './geo';

/** Coordinates per request, as documented by Open‑Meteo. */
export const MAX_POINTS_PER_REQUEST = 100;
/** Requests in flight at once. Polite, and enough to keep a 2000‑point grid quick. */
export const MAX_CONCURRENT_REQUESTS = 3;
/** Roughly 500 kB of JSON once persisted. */
export const DEFAULT_CACHE_LIMIT = 20_000;

const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const STORAGE_KEY = 'sound-reach.elevation';
const RETRY_DELAY_MS = 500;

export class ElevationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ElevationError';
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface ElevationOptions {
  fetchImpl?: typeof fetch;
  /** Pass `null` to keep the cache in memory only. Defaults to localStorage when available. */
  storage?: StorageLike | null;
  maxEntries?: number;
  retryDelayMs?: number;
  endpoint?: string;
}

/** Cache key: 5 decimals is about a metre, finer than the 90 m DEM behind the API. */
export function coordKey(p: LatLon): string {
  return `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Run `worker` over `items` with at most `limit` in flight. Rejects with the first failure. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class ElevationService implements ElevationSource {
  /** Insertion‑ordered, so the first keys are the oldest and get dropped first. */
  private readonly cache = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly storage: StorageLike | null;
  private readonly maxEntries: number;
  private readonly retryDelayMs: number;
  private readonly endpoint: string;

  constructor(options: ElevationOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.maxEntries = options.maxEntries ?? DEFAULT_CACHE_LIMIT;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.endpoint = options.endpoint ?? ENDPOINT;
    this.restore();
  }

  /** Elevations already known, in the order asked for; `null` if any point is missing. */
  cached(points: LatLon[]): number[] | null {
    const out: number[] = [];
    for (const p of points) {
      const v = this.cache.get(coordKey(p));
      if (v === undefined) return null;
      out.push(v);
    }
    return out;
  }

  /**
   * Elevations (m) for every point, in order. Only the points not already cached are fetched,
   * in batches of 100 with 3 requests in flight. Rejects with `ElevationError`.
   */
  async elevations(points: LatLon[], onProgress?: FetchProgress): Promise<number[]> {
    const missing: LatLon[] = [];
    const queued = new Set<string>();
    for (const p of points) {
      const k = coordKey(p);
      if (this.cache.has(k) || queued.has(k)) continue;
      queued.add(k);
      missing.push(p);
    }

    if (missing.length) {
      const batches = chunk(missing, MAX_POINTS_PER_REQUEST);
      let done = 0;
      onProgress?.(0, batches.length);
      await pool(batches, MAX_CONCURRENT_REQUESTS, async (batch) => {
        await this.fetchBatch(batch);
        onProgress?.(++done, batches.length);
      });
    }

    const out = points.map((p) => {
      const v = this.cache.get(coordKey(p));
      if (v === undefined) throw new ElevationError(`no elevation returned for ${coordKey(p)}`);
      return v;
    });
    // Trim after reading, so a single request larger than the cap still answers in full.
    this.trim();
    if (missing.length) this.persist();
    return out;
  }

  private async fetchBatch(batch: LatLon[]): Promise<void> {
    const url = `${this.endpoint}?latitude=${batch.map((p) => p.lat.toFixed(5)).join(',')}&longitude=${batch
      .map((p) => p.lon.toFixed(5))
      .join(',')}`;
    const values = await this.requestWithRetry(url, batch.length);
    batch.forEach((p, i) => {
      const v = values[i];
      // The API returns null over the sea; treat that as sea level rather than dropping the point.
      this.cache.set(coordKey(p), Number.isFinite(v) ? Number(v) : 0);
    });
  }

  private async requestWithRetry(url: string, expected: number): Promise<unknown[]> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url);
      } catch (err) {
        if (attempt === 0) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new ElevationError('elevation request failed', err);
      }
      // 429 and 5xx are worth one more try; anything else is not going to improve.
      if (!response.ok) {
        const retriable = response.status === 429 || response.status >= 500;
        if (retriable && attempt === 0) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new ElevationError(`elevation request failed with HTTP ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        throw new ElevationError('elevation response was not JSON', err);
      }
      const list = (body as { elevation?: unknown })?.elevation;
      if (!Array.isArray(list) || list.length !== expected) {
        throw new ElevationError(`elevation response had ${Array.isArray(list) ? list.length : 0} of ${expected} values`);
      }
      return list;
    }
  }

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [k, v] = entry as [unknown, unknown];
        if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) this.cache.set(k, v);
      }
      this.trim();
    } catch {
      /* a corrupt cache is not worth reporting: start empty */
    }
  }

  private trim(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.cache]));
    } catch {
      /* quota or private mode: the in‑memory cache still works for this session */
    }
  }
}
