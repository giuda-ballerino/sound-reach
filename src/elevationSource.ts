/**
 * The contract every ground-elevation provider satisfies, and the tiering between them.
 *
 * There are two providers: terrain tiles (`demTiles.ts`, the fast path) and the Open-Meteo
 * point API (`elevation.ts`, the fallback). They disagree slightly because they are built on
 * different DEMs, so a single profile must come entirely from one of them or the difference
 * shows up as a fake step in the ground. `TieredElevation` enforces that by latching: once the
 * tiles have failed, everything uses the fallback for the rest of the session.
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

export class TieredElevation implements ElevationSource {
  private degraded = false;

  constructor(
    private readonly primary: ElevationSource,
    private readonly fallback: ElevationSource,
  ) {}

  /** True once the primary source has failed and the fallback has taken over. */
  get usingFallback(): boolean {
    return this.degraded;
  }

  cached(points: LatLon[]): number[] | null {
    return (this.degraded ? this.fallback : this.primary).cached(points);
  }

  async elevations(points: LatLon[], onProgress?: FetchProgress): Promise<number[]> {
    if (!this.degraded) {
      try {
        return await this.primary.elevations(points, onProgress);
      } catch {
        this.degraded = true;
      }
    }
    return this.fallback.elevations(points, onProgress);
  }
}
