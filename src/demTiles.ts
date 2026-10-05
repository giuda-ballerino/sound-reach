/**
 * Ground elevations from terrain-RGB raster tiles.
 *
 * A 256×256 tile carries 65 536 elevations in one ~90 kB request, so a whole zone grid costs
 * a handful of HTTP calls instead of dozens, and every later query — dragging a house, moving
 * the stage inside the same tile, adding a receptor — is a local array lookup with no network
 * at all. That is the difference between a tool you can drag around and one that gets rate
 * limited, which is why this is the primary source and the point API is only the fallback.
 *
 * Format: Tilezen "terrarium" tiles, hosted as AWS Open Data. Elevation is packed into the
 * pixel as (R · 256 + G + B / 256) − 32768 metres. Served with `Access-Control-Allow-Origin: *`
 * and no key. Zoom 12 is about 31 m per pixel at 38° N, which matches the native resolution of
 * the SRTM and EU-DEM sources underneath; asking for more zoom would only interpolate.
 *
 * Attribution is required and is listed in the README and on the map.
 */

import type { ElevationSource, FetchProgress } from './elevationSource';
import type { LatLon } from './geo';
import { decodePng, type DecodedPng } from './png';

export const TILE_SIZE = 256;

/** ~31 m per pixel at 38° N, the native resolution of the DEMs behind these tiles. */
export const DEFAULT_ZOOM = 12;

const DEFAULT_ENDPOINT = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const MAX_CONCURRENT_TILES = 4;
/** Each decoded tile is 256 KiB of Float32; 48 of them covers a lot of map for 12 MB. */
const DEFAULT_TILE_LIMIT = 48;
const RETRY_DELAY_MS = 500;

export class TerrainTileError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TerrainTileError';
  }
}

export interface TerrainTileOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  zoom?: number;
  maxTiles?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Web-Mercator pixel coordinates at a zoom level, as floats. */
export function globalPixel(p: LatLon, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const s = Math.min(Math.max(Math.sin((p.lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: ((p.lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/** Ground resolution in metres per pixel, for the docs and for choosing a zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** Unpack a terrarium tile into one height per pixel. */
export function decodeTerrarium(png: DecodedPng): Float32Array {
  const { width, height, channels, data } = png;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const at = i * channels;
    out[i] = data[at] * 256 + data[at + 1] + data[at + 2] / 256 - 32768;
  }
  return out;
}

const tileKey = (zoom: number, x: number, y: number) => `${zoom}/${x}/${y}`;

/** The four pixels a bilinear sample touches, as global pixel coordinates. */
function samplePixels(p: LatLon, zoom: number) {
  const { x, y } = globalPixel(p, zoom);
  // Pixel values sit at pixel centres, half a pixel in from the pixel's top-left corner.
  const u = x - 0.5;
  const v = y - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  return { x0, y0, fx: u - x0, fy: v - y0 };
}

export class TerrainTileService implements ElevationSource {
  /** Insertion-ordered so the oldest tile is the one dropped. */
  private readonly tiles = new Map<string, Float32Array>();
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly maxTiles: number;
  private readonly retryDelayMs: number;
  /**
   * Whether any tile has been fetched and decoded this session. Until it has, a 403/404 is
   * treated as the host being unreachable rather than as empty ocean. Tiles load concurrently,
   * so a first batch that mixes a real tile with a genuinely absent one can still throw if the
   * absent one lands first; the fallback covers that and the next request sorts it out.
   */
  private hasLoadedAny = false;
  readonly zoom: number;

  constructor(options: TerrainTileOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.zoom = options.zoom ?? DEFAULT_ZOOM;
    this.maxTiles = options.maxTiles ?? DEFAULT_TILE_LIMIT;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /** Number of tiles currently decoded and resident. */
  get tileCount(): number {
    return this.tiles.size;
  }

  cached(points: LatLon[]): number[] | null {
    const out: number[] = [];
    for (const p of points) {
      const v = this.sample(p);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  }

  async elevations(points: LatLon[], onProgress?: FetchProgress): Promise<number[]> {
    const missing = this.missingTiles(points);
    if (missing.length) {
      let done = 0;
      onProgress?.(0, missing.length);
      await this.pool(missing, async (key) => {
        await this.loadTile(key);
        onProgress?.(++done, missing.length);
      });
    }
    const out = points.map((p) => {
      const v = this.sample(p);
      if (v === null) throw new TerrainTileError(`no terrain tile covering ${p.lat},${p.lon}`);
      return v;
    });
    // Trim after sampling, so one request spanning more tiles than the cap still answers.
    this.trim();
    return out;
  }

  /** Every tile the bilinear samples for these points need, that is not already loaded. */
  private missingTiles(points: LatLon[]): string[] {
    const wanted = new Set<string>();
    for (const p of points) {
      const { x0, y0 } = samplePixels(p, this.zoom);
      for (const dy of [0, 1]) {
        for (const dx of [0, 1]) {
          const key = this.tileKeyForPixel(x0 + dx, y0 + dy);
          if (key && !this.tiles.has(key)) wanted.add(key);
        }
      }
    }
    return [...wanted];
  }

  private tileKeyForPixel(gx: number, gy: number): string | null {
    const n = 2 ** this.zoom;
    const span = n * TILE_SIZE;
    if (gy < 0 || gy >= span) return null;
    const px = ((gx % span) + span) % span;
    return tileKey(this.zoom, Math.floor(px / TILE_SIZE), Math.floor(gy / TILE_SIZE));
  }

  private pixel(gx: number, gy: number): number | null {
    const key = this.tileKeyForPixel(gx, gy);
    if (!key) return null;
    const tile = this.tiles.get(key);
    if (!tile) return null;
    const n = 2 ** this.zoom;
    const span = n * TILE_SIZE;
    const px = ((gx % span) + span) % span;
    return tile[(gy % TILE_SIZE) * TILE_SIZE + (px % TILE_SIZE)];
  }

  /** Bilinear interpolation between the four surrounding pixels, across tile seams. */
  private sample(p: LatLon): number | null {
    const { x0, y0, fx, fy } = samplePixels(p, this.zoom);
    const a = this.pixel(x0, y0);
    const b = this.pixel(x0 + 1, y0);
    const c = this.pixel(x0, y0 + 1);
    const d = this.pixel(x0 + 1, y0 + 1);
    if (a === null || b === null || c === null || d === null) return null;
    const top = a + (b - a) * fx;
    const bottom = c + (d - c) * fx;
    return top + (bottom - top) * fy;
  }

  private async loadTile(key: string): Promise<void> {
    const bytes = await this.request(`${this.endpoint}/${key}.png`);
    if (bytes === null) {
      // A 403/404 means "the mosaic publishes no tile here" — open sea — but only once we have
      // seen the host actually serve one. Before that it reads the same as a dead endpoint, a
      // moved bucket or a blocked request, and quietly answering sea level would hide a total
      // outage behind plausible flat terrain. Throwing instead lets TieredElevation fall back.
      if (!this.hasLoadedAny) {
        throw new TerrainTileError(
          `tile ${key} was not found and no tile has loaded yet, so the tile host looks unreachable`,
        );
      }
      this.tiles.set(key, new Float32Array(TILE_SIZE * TILE_SIZE));
      return;
    }
    let png: DecodedPng;
    try {
      png = await decodePng(bytes);
    } catch (err) {
      throw new TerrainTileError(`tile ${key} could not be decoded`, err);
    }
    if (png.width !== TILE_SIZE || png.height !== TILE_SIZE) {
      throw new TerrainTileError(`tile ${key} was ${png.width}×${png.height}, expected ${TILE_SIZE}²`);
    }
    this.tiles.set(key, decodeTerrarium(png));
    this.hasLoadedAny = true;
  }

  /** Tile bytes, or null when the server says there is no such tile. */
  private async request(url: string): Promise<Uint8Array | null> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url);
      } catch (err) {
        if (attempt === 0) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new TerrainTileError('terrain tile request failed', err);
      }
      if (response.status === 404 || response.status === 403) return null;
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt === 0) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new TerrainTileError(`terrain tile request failed with HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
  }

  private async pool(keys: string[], worker: (key: string) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_TILES, keys.length) }, async () => {
        while (next < keys.length) await worker(keys[next++]);
      }),
    );
  }

  private trim(): void {
    while (this.tiles.size > this.maxTiles) {
      const oldest = this.tiles.keys().next();
      if (oldest.done) break;
      this.tiles.delete(oldest.value);
    }
  }
}
