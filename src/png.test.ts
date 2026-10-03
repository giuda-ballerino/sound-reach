import { describe, expect, it } from 'vitest';
import { encodePng, pattern } from './png.fixture';
import { PngError, decodePng } from './png';

describe('decodePng', () => {
  it('round-trips an RGB image through every filter type', async () => {
    const pixels = pattern(7, 5, 3);
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = await encodePng({ width: 7, height: 5, channels: 3, pixels, filters: [filter] });
      const out = await decodePng(png);
      expect(out).toMatchObject({ width: 7, height: 5, channels: 3 });
      expect([...out.data]).toEqual([...pixels]);
    }
  });

  it('handles a different filter on every row, as real encoders emit', async () => {
    const pixels = pattern(9, 6, 3);
    const png = await encodePng({ width: 9, height: 6, channels: 3, pixels, filters: [4, 0, 2, 1, 3, 4] });
    expect([...(await decodePng(png)).data]).toEqual([...pixels]);
  });

  it('reads RGBA as four channels', async () => {
    const pixels = pattern(4, 4, 4);
    const out = await decodePng(await encodePng({ width: 4, height: 4, channels: 4, pixels, filters: [1] }));
    expect(out.channels).toBe(4);
    expect([...out.data]).toEqual([...pixels]);
  });

  it('survives image data split across several IDAT chunks', async () => {
    // Real tiles arrive this way; the decoder has to concatenate before inflating.
    const pixels = pattern(16, 12, 3);
    const split = await encodePng({ width: 16, height: 12, channels: 3, pixels, filters: [2], idatChunks: 4 });
    expect([...(await decodePng(split)).data]).toEqual([...pixels]);
  });

  it('refuses what it cannot read, rather than guessing', async () => {
    const pixels = pattern(4, 4, 3);
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(PngError);
    await expect(
      decodePng(await encodePng({ width: 4, height: 4, channels: 3, pixels, colourType: 0 })),
    ).rejects.toThrow(/colour type/);
    await expect(
      decodePng(await encodePng({ width: 4, height: 4, channels: 3, pixels, interlace: 1 })),
    ).rejects.toThrow(/interlaced/);
    await expect(
      decodePng(await encodePng({ width: 4, height: 4, channels: 3, pixels, bitDepth: 16 })),
    ).rejects.toThrow(/bit depth/);
  });
});
