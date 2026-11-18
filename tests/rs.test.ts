// 測試 1：Reed-Solomon
import { describe, expect, it } from 'vitest';
import { RsError, rsDecode, rsEncode } from '../src/modem/rs.ts';
import { makeRng } from '../bench/channel.ts';

const corrupt = (cw: number[], n: number, rng: () => number): number[] => {
  const pos = new Set<number>();
  while (pos.size < n) pos.add(Math.floor(rng() * cw.length));
  for (const p of pos) cw[p] ^= 1 + Math.floor(rng() * 255);
  return [...pos];
};

describe('Reed-Solomon（GF(256)、0x11d、nsym = 6）', () => {
  it('2000 次隨機訊息（長度 1～40），0～3 個位元組錯誤全部正確修正', () => {
    const rng = makeRng(1);
    let ok = 0;
    for (let t = 0; t < 2000; t++) {
      const n = 1 + Math.floor(rng() * 40);
      const msg = Array.from({ length: n }, () => Math.floor(rng() * 256));
      const cw = rsEncode(msg, 6);
      const ne = Math.floor(rng() * 4);
      corrupt(cw, ne, rng);
      const r = rsDecode(cw, 6);
      if (r.data.join() === msg.join()) ok++;
      expect(r.fixed).toBe(ne);
    }
    expect(ok).toBe(2000);
  });

  it('4 個以上錯誤要回報失敗，不能「修成錯的」', () => {
    const rng = makeRng(2);
    let wrong = 0;
    let failed = 0;
    for (let t = 0; t < 2000; t++) {
      const n = 1 + Math.floor(rng() * 40);
      const msg = Array.from({ length: n }, () => Math.floor(rng() * 256));
      const cw = rsEncode(msg, 6);
      corrupt(cw, Math.min(cw.length, 4 + Math.floor(rng() * 4)), rng);
      try {
        const r = rsDecode(cw, 6);
        if (r.data.join() !== msg.join()) wrong++;
      } catch (e) {
        expect(e).toBeInstanceOf(RsError);
        failed++;
      }
    }
    expect(wrong).toBe(0);
    expect(failed).toBeGreaterThan(1990);
  });

  it('抹除解碼：2e + f ≤ nsym 時可修正（最多 6 個抹除）', () => {
    const rng = makeRng(3);
    for (let t = 0; t < 1000; t++) {
      const n = 4 + Math.floor(rng() * 36);
      const msg = Array.from({ length: n }, () => Math.floor(rng() * 256));
      const cw = rsEncode(msg, 6);
      const f = Math.floor(rng() * 7);
      const e = Math.floor((6 - f) / 2);
      const all = corrupt(cw, f + e, rng);
      const erasures = all.slice(0, f);
      const r = rsDecode(cw, 6, { erasures });
      expect(r.data).toEqual(msg);
    }
  });

  it('偵錯餘量：reserve = 2 時 3 個錯誤要拒絕', () => {
    const rng = makeRng(4);
    const msg = Array.from({ length: 8 }, () => Math.floor(rng() * 256));
    const cw = rsEncode(msg, 6);
    corrupt(cw, 3, rng);
    expect(() => rsDecode(cw, 6, { reserve: 2 })).toThrow(RsError);
    expect(rsDecode(cw, 6).data).toEqual(msg);
  });
});
