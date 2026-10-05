import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ZOOM,
  TILE_SIZE,
  TerrainTileError,
  TerrainTileService,
  decodeTerrarium,
  globalPixel,
  metresPerPixel,
} from './demTiles';
import type { LatLon } from './geo';
import { encodePng } from './png.fixture';

const stage: LatLon = { lat: 38.1058, lon: 12.723 };

/** Pack a height field into terrarium RGB. Integer heights keep the blue channel at zero. */
function terrariumPixels(height: (x: number, y: number) => number): Uint8Array {
  const px = new Uint8Array(TILE_SIZE * TILE_SIZE * 3);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const v = Math.round(height(x, y)) + 32768;
      const at = (y * TILE_SIZE + x) * 3;
      px[at] = (v >> 8) & 0xff;
      px[at + 1] = v & 0xff;
      px[at + 2] = 0;
    }
  }
  return px;
}

const tilePng = (height: (x: number, y: number) => number) =>
  encodePng({ width: TILE_SIZE, height: TILE_SIZE, channels: 3, pixels: terrariumPixels(height), filters: [1] });

interface Stub {
  fetchImpl: typeof fetch;
  urls: string[];
}

/** A server whose every tile carries the same height field, unless `respond` says otherwise. */
function server(
  height: (x: number, y: number) => number,
  respond?: (key: string, call: number) => Response | null,
): Stub {
  const urls: string[] = [];
  let call = 0;
  const cache = new Map<string, Promise<Uint8Array>>();
  return {
    urls,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const key = url.slice(url.indexOf('/terrarium/') + 11);
      const override = respond?.(key, ++call);
      if (override) return override;
      let png = cache.get(key);
      if (!png) {
        png = tilePng(height);
        cache.set(key, png);
      }
      return new Response(new Blob([(await png) as BlobPart]), { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch,
  };
}

const service = (stub: Stub, extra: Record<string, unknown> = {}) =>
  new TerrainTileService({ fetchImpl: stub.fetchImpl, endpoint: 'https://tiles.test/terrarium', retryDelayMs: 0, ...extra });

describe('tile geometry', () => {
  it('puts null island at the centre of the world', () => {
    expect(globalPixel({ lat: 0, lon: 0 }, 0)).toEqual({ x: 128, y: 128 });
    expect(globalPixel({ lat: 0, lon: -180 }, 0).x).toBe(0);
  });

  it('places the stage in the tile the live service serves for it', () => {
    const { x, y } = globalPixel(stage, DEFAULT_ZOOM);
    expect(Math.floor(x / TILE_SIZE)).toBe(2192);
    expect(Math.floor(y / TILE_SIZE)).toBe(1578);
  });

  it('is about 31 m per pixel at the stage, matching the DEMs underneath', () => {
    expect(metresPerPixel(stage.lat, DEFAULT_ZOOM)).toBeCloseTo(30.1, 1);
    expect(metresPerPixel(0, 12)).toBeCloseTo(38.2, 1);
  });
});

describe('decodeTerrarium', () => {
  it('unpacks (R·256 + G + B/256) − 32768', () => {
    const data = new Uint8Array([128, 0, 0, 128, 10, 128, 127, 255, 0]);
    const out = decodeTerrarium({ width: 3, height: 1, channels: 3, data });
    expect([...out]).toEqual([0, 10.5, -1]);
  });

  it('skips the alpha channel on RGBA tiles', () => {
    const data = new Uint8Array([128, 0, 0, 255, 128, 5, 0, 255]);
    expect([...decodeTerrarium({ width: 2, height: 1, channels: 4, data })]).toEqual([0, 5]);
  });
});

describe('TerrainTileService', () => {
  it('fetches the four tiles a bilinear sample can touch, and no more', async () => {
    const stub = server(() => 100);
    const svc = service(stub);
    expect(await svc.elevations([stage])).toEqual([100]);
    // Deep inside a tile, all four neighbours are the same tile.
    expect(stub.urls).toEqual(['https://tiles.test/terrarium/12/2192/1578.png']);
    expect(svc.tileCount).toBe(1);
  });

  it('interpolates between pixels instead of snapping to one', async () => {
    // height = pixel column, so a bilinear sample must come out at the continuous coordinate.
    const svc = service(server((x) => x));
    const { x: gx } = globalPixel(stage, DEFAULT_ZOOM);
    const tileLeft = Math.floor(gx / TILE_SIZE) * TILE_SIZE;
    const [v] = await svc.elevations([stage]);
    expect(v).toBeCloseTo(gx - tileLeft - 0.5, 6);
    expect(Number.isInteger(v)).toBe(false);
  });

  it('interpolates across a tile seam', async () => {
    // A point sitting exactly on a tile boundary needs the tile on each side.
    const scale = TILE_SIZE * 2 ** DEFAULT_ZOOM;
    const onSeam: LatLon = { lat: stage.lat, lon: (2192 * TILE_SIZE * 360) / scale - 180 };
    const stub = server((x) => x);
    const svc = service(stub);
    const [v] = await svc.elevations([onSeam]);
    expect(stub.urls.length).toBe(2);
    expect(stub.urls.some((u) => u.endsWith('/12/2191/1578.png'))).toBe(true);
    expect(stub.urls.some((u) => u.endsWith('/12/2192/1578.png'))).toBe(true);
    // Half way between column 255 of the left tile and column 0 of the right one.
    expect(v).toBeCloseTo((255 + 0) / 2, 6);
  });

  it('serves everything else from memory once the tile is in', async () => {
    const stub = server(() => 42);
    const svc = service(stub);
    const around = Array.from({ length: 200 }, (_, i) => ({ lat: stage.lat + i * 1e-5, lon: stage.lon + i * 1e-5 }));
    await svc.elevations(around);
    const before = stub.urls.length;
    await svc.elevations(around);
    expect(await svc.elevations([stage])).toEqual([42]);
    expect(stub.urls.length).toBe(before);
  });

  it('reports a miss before the tile is loaded and a hit after', async () => {
    const svc = service(server(() => 7));
    expect(svc.cached([stage])).toBeNull();
    await svc.elevations([stage]);
    expect(svc.cached([stage])).toEqual([7]);
  });

  it('treats a tile the mosaic does not publish as sea level, once the host has proved itself', async () => {
    // Somewhere the mosaic has a tile, so the host is known good...
    const stub = server(() => 100, (key) => (key.startsWith('12/2192/') ? null : new Response('nope', { status: 404 })));
    const svc = service(stub);
    expect(await svc.elevations([stage])).toEqual([100]);
    // ...and only then does a missing tile elsewhere read as open sea.
    expect(await svc.elevations([{ lat: 45, lon: 9 }])).toEqual([0]);
  });

  it('refuses to call a 404 sea level before any tile has loaded', async () => {
    // An unreachable or moved bucket answers 404 for everything. Flat terrain everywhere is a
    // plausible-looking lie, so this has to fail and let the fallback source take over.
    const stub = server(() => 100, () => new Response('nope', { status: 404 }));
    await expect(service(stub).elevations([stage])).rejects.toBeInstanceOf(TerrainTileError);
    await expect(service(stub).elevations([stage])).rejects.toThrow(/no tile has loaded yet/);
  });

  it('refuses to call a 403 sea level before any tile has loaded', async () => {
    const stub = server(() => 100, () => new Response('denied', { status: 403 }));
    await expect(service(stub).elevations([stage])).rejects.toBeInstanceOf(TerrainTileError);
  });

  it('keeps answering sea level for later gaps once a tile has loaded', async () => {
    const stub = server(() => 42, (key) => (key.startsWith('12/2192/') ? null : new Response('', { status: 403 })));
    const svc = service(stub);
    await svc.elevations([stage]);
    expect(await svc.elevations([{ lat: 45, lon: 9 }])).toEqual([0]);
    expect(await svc.elevations([{ lat: 50, lon: 2 }])).toEqual([0]);
  });

  it('retries once on 429 and then succeeds', async () => {
    const stub = server(() => 55, (_key, call) => (call === 1 ? new Response('slow', { status: 429 }) : null));
    expect(await service(stub).elevations([stage])).toEqual([55]);
    expect(stub.urls).toHaveLength(2);
  });

  it('gives up cleanly when the tile host keeps failing', async () => {
    const stub = server(() => 1, () => new Response('bad', { status: 503 }));
    await expect(service(stub).elevations([stage])).rejects.toBeInstanceOf(TerrainTileError);
  });

  it('rejects a response that is not a tile-sized PNG', async () => {
    const small = await encodePng({ width: 4, height: 4, channels: 3, pixels: new Uint8Array(48) });
    const stub = server(() => 1, () => new Response(new Blob([small as BlobPart])));
    await expect(service(stub).elevations([stage])).rejects.toThrow(/expected 256/);
  });

  it('drops the oldest tiles past the cap', async () => {
    const stub = server(() => 9);
    // Every tile here returns 200, so the not-yet-proven-host guard never fires.
    const svc = service(stub, { maxTiles: 2 });
    // Three well-separated places, so three different tiles.
    const spread = [stage, { lat: 45, lon: 9 }, { lat: 50, lon: 2 }];
    for (const p of spread) await svc.elevations([p]);
    expect(svc.tileCount).toBe(2);
    expect(svc.cached([stage])).toBeNull();
    expect(svc.cached([spread[2]])).toEqual([9]);
  });
});
