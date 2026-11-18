// 測試 4：自動偵測頻段
import { describe, expect, it } from 'vitest';
import { makeRng } from '../bench/channel.ts';
import { candidateAt, runTrials } from '../bench/trial.ts';
import { AutoReceiver } from '../src/modem/autoReceiver.ts';
import { BASELINE_OPTIONS, CANDIDATES, DEFAULT_OPTIONS, type ModemConfig } from '../src/modem/config.ts';
import { synthesize } from '../src/modem/fsk.ts';
import { resampleDoppler } from '../bench/channel.ts';
import { SCENARIOS } from './helpers.ts';

const N = 32; // 8 組設定各 4 次

describe.each([
  ['預設接收器', DEFAULT_OPTIONS],
  ['baseline', BASELINE_OPTIONS],
] as const)('自動偵測（%s）', (_name, opts) => {
  for (const [label, ch, min] of [
    ['安靜', SCENARIOS.quiet, 0.95],
    ['中等', SCENARIOS.medium, 0.95],
    ['強噪音', SCENARIOS.strong, 0.8],
  ] as const) {
    it(`${label}：8 組設定輪流發送，解碼與鎖定成功率 ≥ ${min * 100}%`, () => {
      const r = runTrials(N, (i) => ({
        cfg: candidateAt(i),
        ch,
        opts,
        rng: makeRng(20_000 + i),
        mode: 'auto',
      }));
      expect(r.ok / N).toBeGreaterThanOrEqual(min);
      expect(r.lock / N).toBeGreaterThanOrEqual(min);
      expect(r.wrong).toBe(0);
    });
  }

  it('60 秒純噪音（±0.1 均勻分布）誤報 0 次', () => {
    const rng = makeRng(99);
    const fs = 44100;
    let msgs = 0;
    const a = new AutoReceiver(fs, { opts, onEvent: (e) => e.ok && msgs++ });
    for (let s = 0; s < 60; s++) {
      const x = Float32Array.from({ length: fs }, () => (rng() * 2 - 1) * 0.1);
      for (let i = 0; i < x.length; i += 4096) a.push(x.subarray(i, i + 4096));
    }
    expect(msgs).toBe(0);
  });

  it('換設定後能重新鎖定', () => {
    const fs = 44100;
    const got: number[] = [];
    const locks: (ModemConfig | null)[] = [];
    const a = new AutoReceiver(fs, {
      opts,
      relockSec: 3,
      onEvent: (e) => e.ok && got.push(e.payload[0]),
      onLock: (c) => locks.push(c),
    });
    const feed = (x: Float32Array) => {
      for (let i = 0; i < x.length; i += 4096) a.push(x.subarray(i, i + 4096));
    };
    const c1 = CANDIDATES[2];
    const c2 = CANDIDATES[7];
    feed(resampleDoppler(synthesize([1, 2, 3, 4, 5, 6, 7, 8], c1, 48000), 48000, fs));
    feed(new Float32Array(fs * 5));
    feed(resampleDoppler(synthesize([9, 8, 7, 6, 5, 4, 3, 2], c2, 48000), 48000, fs));
    feed(new Float32Array(fs));
    expect(got).toEqual([1, 9]);
    const seq = locks.map((c) => (c ? `${c.f0}/${c.ts}` : '掃描'));
    expect(seq).toEqual(['掃描', `${c1.f0}/${c1.ts}`, '掃描', `${c2.f0}/${c2.ts}`]);
  });

  it('手動指定頻段：只用指定設定接收', () => {
    const fs = 48000;
    const cfg = CANDIDATES[5];
    let got = 0;
    const a = new AutoReceiver(fs, { opts, manual: cfg, onEvent: (e) => e.ok && got++ });
    const x = synthesize([1, 2, 3], cfg, fs);
    a.push(new Float32Array(fs / 2));
    for (let i = 0; i < x.length; i += 4096) a.push(x.subarray(i, i + 4096));
    a.push(new Float32Array(fs));
    expect(got).toBe(1);
    expect(a.receivers).toHaveLength(1);
  });
});
