// 測試 5：效能。AutoReceiver 掃描所有候選設定（含都卜勒搜尋）處理 10 秒音訊 < 2 秒（Node）。
import { describe, expect, it } from 'vitest';
import { makeRng, channel, SCENARIOS } from '../bench/channel.ts';
import { AutoReceiver } from '../src/modem/autoReceiver.ts';
import { BASELINE_OPTIONS, CANDIDATES, DEFAULT_OPTIONS } from '../src/modem/config.ts';
import { synthesize } from '../src/modem/fsk.ts';

function tenSeconds(fs: number): Float32Array {
  // 10 秒：噪音中夾 3 則廣播（不同設定），包含解碼的成本
  const rng = makeRng(5);
  const out = new Float32Array(fs * 10);
  for (let i = 0; i < out.length; i++) out[i] = (rng() * 2 - 1) * 0.02;
  let off = Math.round(fs * 0.5);
  for (const c of [CANDIDATES[0], CANDIDATES[3], CANDIDATES[6]]) {
    const y = channel(
      synthesize([33, 1, 1, 7, 1, 3, 2, 0], c, 48000, 0.6),
      48000,
      fs,
      { ...SCENARIOS.medium, lead: 0 },
      rng,
    );
    for (let i = 0; i < y.length && off + i < out.length; i++) out[off + i] += y[i];
    off += y.length;
  }
  return out;
}

describe('效能', () => {
  for (const fs of [44100, 48000]) {
    for (const [name, opts] of [
      ['預設（含都卜勒搜尋）', DEFAULT_OPTIONS],
      ['baseline', BASELINE_OPTIONS],
    ] as const) {
      it(`${name}：${fs} Hz、10 秒音訊 < 2 秒`, () => {
        const x = tenSeconds(fs);
        let ok = 0;
        const a = new AutoReceiver(fs, { opts, onEvent: (e) => e.ok && ok++ });
        a.push(new Float32Array(4096)); // 暖機：JIT
        const t0 = performance.now();
        for (let i = 0; i < x.length; i += 4096) a.push(x.subarray(i, i + 4096));
        const ms = performance.now() - t0;
        console.log(`${name} ${fs} Hz：${ms.toFixed(0)} ms，解出 ${ok} 則`);
        expect(ms).toBeLessThan(2000);
        expect(ok).toBeGreaterThanOrEqual(1);
      });
    }
  }
});
