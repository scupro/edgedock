/**
 * Incremental MD5 (pure JS; WebCrypto has no MD5 on Node and no streaming digest).
 * Used for per-part integrity (S3 Content-MD5 / part ETag) and bucket CORS (PutBucketCors needs Content-MD5).
 * The same file is mirrored in web/src/lib/md5.ts for the browser.
 */
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

export class Md5 {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Int32Array(16);

  update(data: Uint8Array | string): this {
    const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.total += d.length;
    let i = 0;
    if (this.bufLen) {
      const n = Math.min(64 - this.bufLen, d.length);
      this.buf.set(d.subarray(0, n), this.bufLen);
      this.bufLen += n;
      i = n;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; i + 64 <= d.length; i += 64) this.block(d, i);
    if (i < d.length) {
      this.buf.set(d.subarray(i), 0);
      this.bufLen = d.length - i;
    }
    return this;
  }

  private block(b: Uint8Array, o: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = b[o + i * 4] | (b[o + i * 4 + 1] << 8) | (b[o + i * 4 + 2] << 16) | (b[o + i * 4 + 3] << 24);
    let [a, bb, c, d] = this.h;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = (bb & c) | (~bb & d);
        g = i;
      } else if (i < 32) {
        f = (d & bb) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = bb ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (bb | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = bb;
      const x = (a + f + K[i] + w[g]) | 0;
      bb = (bb + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
      a = tmp;
    }
    this.h[0] = (this.h[0] + a) | 0;
    this.h[1] = (this.h[1] + bb) | 0;
    this.h[2] = (this.h[2] + c) | 0;
    this.h[3] = (this.h[3] + d) | 0;
  }

  digest(): Uint8Array {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.bufLen < 56 ? 56 : 120) - this.bufLen) + 8);
    pad[0] = 0x80;
    const lo = bits >>> 0;
    const hi = Math.floor(bits / 2 ** 32) >>> 0;
    const p = pad.length - 8;
    for (let i = 0; i < 4; i++) {
      pad[p + i] = (lo >>> (8 * i)) & 0xff;
      pad[p + 4 + i] = (hi >>> (8 * i)) & 0xff;
    }
    const savedTotal = this.total;
    this.update(pad);
    this.total = savedTotal;
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = (this.h[i] >>> (8 * j)) & 0xff;
    return out;
  }
}

export function md5(data: Uint8Array | string): Uint8Array {
  return new Md5().update(data).digest();
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const md5Hex = (d: Uint8Array | string) => toHex(md5(d));
export const md5Base64 = (d: Uint8Array | string) => toBase64(md5(d));

/** S3 multipart ETag: md5(concat(md5(part_i))) + "-" + N */
export function multipartEtag(partMd5Hex: string[]): string {
  const all = new Uint8Array(partMd5Hex.length * 16);
  partMd5Hex.forEach((h, i) => {
    for (let j = 0; j < 16; j++) all[i * 16 + j] = parseInt(h.slice(j * 2, j * 2 + 2), 16);
  });
  return `${md5Hex(all)}-${partMd5Hex.length}`;
}

/** Pass-through stream that hashes bytes as they flow. */
export function md5Tap(): { stream: TransformStream<Uint8Array, Uint8Array>; result: () => { hex: string; bytes: number } } {
  const h = new Md5();
  let bytes = 0;
  let final: { hex: string; bytes: number } | null = null;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      h.update(chunk);
      bytes += chunk.byteLength;
      ctrl.enqueue(chunk);
    },
  });
  return {
    stream,
    result: () => (final ??= { hex: toHex(h.digest()), bytes }),
  };
}
