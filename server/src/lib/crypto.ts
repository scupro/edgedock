/** WebCrypto helpers that work on Workers and Node >= 20. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** URL-safe random token. */
export function randomToken(bytes = 24): string {
  return toBase64Url(randomBytes(bytes));
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
/** Short human-friendly slug (no ambiguous chars). */
export function randomSlug(len = 8): string {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  const h = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------- PBKDF2
// Workers caps PBKDF2 at 100000 iterations.
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Returns `pbkdf2$sha256$<iterations>$<salt>$<hash>` */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const hash = await pbkdf2(password, fromBase64Url(parts[3]), iterations);
  return timingSafeEqual(toBase64Url(hash), parts[4]);
}

// ---------------------------------------------------------------- AES-GCM
const keyCache = new Map<string, CryptoKey>();

async function aesKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  // Derive a 256-bit key from the configured secret with HKDF-SHA256.
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('edgedock/v1'), info: enc.encode('storage-secrets') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  keyCache.set(secret, key);
  return key;
}

/** Returns `v1.<iv>.<ciphertext>` (base64url). */
export async function encryptString(plain: string, secret: string): Promise<string> {
  if (!secret) throw new Error('ENCRYPTION_KEY is not configured');
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

export async function decryptString(payload: string, secret: string): Promise<string> {
  if (!secret) throw new Error('ENCRYPTION_KEY is not configured');
  const [v, iv, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Invalid encrypted payload');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv) }, await aesKey(secret), fromBase64Url(ct));
  return dec.decode(pt);
}

/** JWT signing secret: explicit JWT_SECRET, or derived from ENCRYPTION_KEY. */
export async function jwtSecret(env: { JWT_SECRET?: string; ENCRYPTION_KEY: string }): Promise<string> {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is not configured');
  return sha256Hex('edgedock-jwt:' + env.ENCRYPTION_KEY);
}
