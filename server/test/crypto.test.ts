import { describe, expect, it } from 'vitest';
import { decryptString, encryptString, fromBase64Url, hashPassword, randomSlug, toBase64Url, verifyPassword } from '../src/lib/crypto';
import { basename, dirname, isWithin, joinPath, normalizePath } from '../src/lib/path';
import { parseRange } from '../src/storage/base';

describe('crypto', () => {
  it('hashes and verifies passwords with PBKDF2', async () => {
    const h = await hashPassword('s3cret-pass', 1000);
    expect(h).toMatch(/^pbkdf2\$sha256\$1000\$/);
    expect(await verifyPassword('s3cret-pass', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('uses unique salts', async () => {
    expect(await hashPassword('a', 1000)).not.toEqual(await hashPassword('a', 1000));
  });

  it('rejects iteration counts above the Workers limit', async () => {
    expect(await verifyPassword('a', 'pbkdf2$sha256$200000$AAAA$AAAA')).toBe(false);
  });

  it('round-trips AES-GCM and fails with another key', async () => {
    const ct = await encryptString('{"secretAccessKey":"abc"}', 'key-1');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(await decryptString(ct, 'key-1')).toBe('{"secretAccessKey":"abc"}');
    await expect(decryptString(ct, 'key-2')).rejects.toThrow();
    // tampering is detected
    const parts = ct.split('.');
    const bytes = fromBase64Url(parts[2]);
    bytes[0] ^= 1;
    await expect(decryptString(`v1.${parts[1]}.${toBase64Url(bytes)}`, 'key-1')).rejects.toThrow();
  });

  it('generates slugs', () => {
    const s = randomSlug(10);
    expect(s).toMatch(/^[a-z2-9]{10}$/);
  });
});

describe('paths', () => {
  it('normalizes and prevents traversal', () => {
    expect(normalizePath('a/b/../c/')).toBe('/a/c');
    expect(normalizePath('/../../etc/passwd')).toBe('/etc/passwd');
    expect(normalizePath('')).toBe('/');
    expect(joinPath('/a', 'b', '../c')).toBe('/a/c');
    expect(basename('/a/b.txt')).toBe('b.txt');
    expect(dirname('/a/b.txt')).toBe('/a');
    expect(isWithin('/a/b', '/a')).toBe(true);
    expect(isWithin('/ab', '/a')).toBe(false);
    expect(isWithin('/anything', '/')).toBe(true);
  });

  it('parses Range headers', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-1000', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=200-300', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});
