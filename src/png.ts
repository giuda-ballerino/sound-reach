/**
 * A minimal PNG decoder, just enough for terrain tiles.
 *
 * Terrain-RGB tiles encode elevation in the pixel bytes, so they have to be read exactly: a
 * canvas round-trip is lossy on some platforms (colour management, premultiplied alpha) and
 * `getImageData` needs a same-origin or CORS-clean canvas. Decoding the bytes ourselves avoids
 * both problems and, more usefully here, keeps the whole path pure and testable under Node.
 *
 * Supports what the tile servers actually emit: 8 bits per channel, colour type 2 (RGB) or 6
 * (RGBA), no interlacing. Anything else throws rather than guessing.
 */

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngError';
  }
}

export interface DecodedPng {
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA. */
  channels: 3 | 4;
  /** Unfiltered pixel bytes, row-major, `channels` bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Paeth predictor, PNG filter type 4. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** IDAT payloads are zlib-wrapped, which is what DecompressionStream calls 'deflate'. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new PngError('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let channels: 3 | 4 | 0 = 0;
  const idat: Uint8Array[] = [];

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const body = at + 8;
    if (body + length > bytes.length) throw new PngError(`truncated ${type} chunk`);
    if (type === 'IHDR') {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      const depth = bytes[body + 8];
      const colourType = bytes[body + 9];
      const interlace = bytes[body + 12];
      if (depth !== 8) throw new PngError(`unsupported bit depth ${depth}`);
      if (colourType !== 2 && colourType !== 6) throw new PngError(`unsupported colour type ${colourType}`);
      if (interlace !== 0) throw new PngError('interlaced PNGs are not supported');
      channels = colourType === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(body, body + length));
    } else if (type === 'IEND') {
      break;
    }
    at = body + length + 4; // skip the chunk CRC
  }

  if (!width || !height || !channels) throw new PngError('PNG had no usable header');
  if (!idat.length) throw new PngError('PNG had no image data');

  const raw = await inflate(concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new PngError('PNG image data was short');

  const data = new Uint8Array(height * stride);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    if (filter > 4) throw new PngError(`unknown row filter ${filter}`);
    const row = y * stride;
    const above = row - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[row + x - channels] : 0;
      const up = y > 0 ? data[above + x] : 0;
      const upLeft = x >= channels && y > 0 ? data[above + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      data[row + x] = (raw[read + x] + predictor) & 0xff;
    }
    read += stride;
  }

  return { width, height, channels, data };
}
