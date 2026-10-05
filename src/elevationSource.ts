/**
 * The contract every ground-elevation provider satisfies, and the tiering between them.
 *
 * There are two providers: terrain tiles (`demTiles.ts`, the fast path) and the Open-Meteo
 * point API (`elevation.ts`, the fallback). They disagree slightly because they are built on
 * different DEMs, so a single profile must come entirely from one of them or the difference
 * shows up as a fake step in the ground. `TieredElevation` enforces that by latching: a failure
 * sends every request to the fallback, and no single call is ever split across the two.
 *
 * The latch expires. Most outages are transient — a dropped connection, a blip at the CDN — and
 * a session that stays on the chatty, rate-limited point API for hours because of one bad
 * second is the wrong trade. After `FALLBACK_LATCH_MS` the next request tries the tiles again
 * and switches back if they answer; if they do not, the latch simply renews.
 */

import type { LatLon } from './geo';

export interface FetchProgress {
  (done: number, total: number): void;
}

export interface ElevationSource {
  /** Elevations already in hand, in the order asked for; `null` if any point is missing. */
  cached(points: LatLon[]): number[] | null;
  /** Elevations (m) for every point, in order. Rejects when the data cannot be had. */
  elevations(points: LatLon[], onProgress?: FetchProgress): Promise<number[]>;
}

/** How long one primary failure keeps every request on the fallback. */
export const FALLBACK_LATCH_MS = 2 * 60_000;

export interface TieredOptions {
  latchMs?: number;
  /** Injectable clock, so the latch can be tested without waiting two minutes. */
  now?: () => number;
}

export class TieredElevation implements ElevationSource {
  private readonly latchMs: number;
  private readonly now: () => number;
  /** Timestamp the latch lifts at; 0 when the primary is in charge. */
  private latchedUntil = 0;

  constructor(
    private readonly primary: ElevationSource,
    private readonly fallback: ElevationSource,
    options: TieredOptions = {},
  ) {
    this.latchMs = options.latchMs ?? FALLBACK_LATCH_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** True while a primary failure is still latched and the fallback is answering. */
  get usingFallback(): boolean {
    return this.now() < this.latchedUntil;
  }

  cached(points: LatLon[]): number[] | null {
    return (this.usingFallback ? this.fallback : this.primary).cached(points);
  }

  async elevations(points: LatLon[], onProgress?: FetchProgress): Promise<number[]> {
    if (!this.usingFallback) {
      try {
        const out = await this.primary.elevations(points, onProgress);
        this.latchedUntil = 0;
        return out;
      } catch {
        // Whatever the primary managed before it failed is discarded: the fallback refetches
        // every point, so the array handed back comes from one DEM and not a blend of two.
        this.latchedUntil = this.now() + this.latchMs;
      }
    }
    return this.fallback.elevations(points, onProgress);
  }
}
