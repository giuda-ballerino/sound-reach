/**
 * A minimal PNG encoder, for tests only. Nothing in the app imports it; it exists so the
 * decoder and the tile service can be exercised against real PNG bytes without a binary
 * fixture in the repo.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export interface PngSpec {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array;
  /** Filter type per row; repeated if shorter than the image. */
  filters?: number[];
  colourType?: number;
  bitDepth?: number;
  interlace?: number;
  /** Split the compressed data across this many IDAT chunks, as real encoders do. */
  idatChunks?: number;
}

export async function encodePng(spec: PngSpec): Promise<Uint8Array> {
  const { width, height, channels, pixels } = spec;
  const filters = spec.filters ?? [0];
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length];
    raw[at++] = filter;
    for (let x = 0; x < stride; x++) {
      const here = pixels[y * stride + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      raw[at + x] = (here - predictor) & 0xff;
    }
    at += stride;
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = spec.bitDepth ?? 8;
  ihdr[9] = spec.colourType ?? (channels === 3 ? 2 : 6);
  ihdr[12] = spec.interlace ?? 0;

  const compressed = await deflate(raw);
  const pieces = Math.max(1, spec.idatChunks ?? 1);
  const size = Math.ceil(compressed.length / pieces);
  const idats: Uint8Array[] = [];
  for (let i = 0; i < compressed.length; i += size) idats.push(chunk('IDAT', compressed.subarray(i, i + size)));

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...idats,
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A deterministic but non-uniform image, so the filters have something to predict. */
export function pattern(width: number, height: number, channels: number): Uint8Array {
  const px = new Uint8Array(width * height * channels);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i % 11) * 19) & 0xff;
  return px;
}
