import { createHash, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { Md5, md5Hex } from '../src/lib/md5';
it('md5', () => {
  for (const n of [0,1,55,56,63,64,65,119,120,1000,100000]) {
    const b = randomBytes(n);
    expect(md5Hex(b)).toBe(createHash('md5').update(b).digest('hex'));
    const m = new Md5(); let o=0; while(o<n){const k=Math.min(n-o,1+((o*7)%97)); m.update(b.subarray(o,o+k)); o+=k;}
    expect(Buffer.from(m.digest()).toString('hex')).toBe(createHash('md5').update(b).digest('hex'));
  }
});
