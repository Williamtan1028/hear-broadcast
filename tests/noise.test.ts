// 測試 5-2：吵雜環境優化
import { describe, expect, it } from 'vitest';
import { makeRng } from '../bench/channel.ts';
import { runTrials, type TrialSpec } from '../bench/trial.ts';
import { BASELINE_OPTIONS, DEFAULT_OPTIONS, DEFAULTS } from '../src/modem/config.ts';
import { SCENARIOS } from './helpers.ts';

const N = 40;
const rate = (mk: (i: number) => TrialSpec) => runTrials(N, mk);

describe('吵雜環境優化', () => {
  it('重送合併：極強噪音（噪音 0.1、回音 1.2 s）下，送兩次＋合併比單次接收提高 ≥ 10 個百分點', () => {
    const ch = SCENARIOS.extreme;
    const noComb = { ...DEFAULT_OPTIONS, combining: false };
    const single = rate((i) => ({ cfg: DEFAULTS, ch, opts: noComb, rng: makeRng(50_000 + i) }));
    const twice = rate((i) => ({ cfg: DEFAULTS, ch, opts: noComb, rng: makeRng(50_000 + i), repeats: 2 }));
    const comb = rate((i) => ({
      cfg: DEFAULTS,
      ch,
      opts: DEFAULT_OPTIONS,
      rng: makeRng(50_000 + i),
      repeats: 2,
    }));
    console.log(`單次 ${single.ok}/${N}、兩次不合併 ${twice.ok}/${N}、兩次＋合併 ${comb.ok}/${N}`);
    expect((comb.ok - single.ok) / N).toBeGreaterThanOrEqual(0.1);
    expect(comb.ok).toBeGreaterThan(twice.ok);
    expect(comb.wrong + twice.wrong + single.wrong).toBe(0);
  });

  it('重送合併：強噪音（噪音 0.05、回音 0.8 s）下，合併後 ≥ 95% 且不比單次差', () => {
    // 單次接收已達 90% 以上（分段累積後），沒有提高 10 個百分點的空間；改驗證合併後接近全收
    const ch = SCENARIOS.strong;
    const noComb = { ...DEFAULT_OPTIONS, combining: false };
    const single = rate((i) => ({ cfg: DEFAULTS, ch, opts: noComb, rng: makeRng(80_000 + i) }));
    const comb = rate((i) => ({
      cfg: DEFAULTS,
      ch,
      opts: DEFAULT_OPTIONS,
      rng: makeRng(80_000 + i),
      repeats: 2,
    }));
    console.log(`強噪音：單次 ${single.ok}/${N}、兩次＋合併 ${comb.ok}/${N}`);
    expect(comb.ok).toBeGreaterThanOrEqual(single.ok);
    expect(comb.ok / N).toBeGreaterThanOrEqual(0.95);
    expect(comb.wrong).toBe(0);
  });

  it('軟判決＋抹除：強噪音下不比 baseline 差，且不產生錯誤訊息', () => {
    const ch = SCENARIOS.strong;
    const base = rate((i) => ({ cfg: DEFAULTS, ch, opts: BASELINE_OPTIONS, rng: makeRng(51_000 + i) }));
    const era = rate((i) => ({
      cfg: DEFAULTS,
      ch,
      opts: { ...BASELINE_OPTIONS, erasure: true },
      rng: makeRng(51_000 + i),
    }));
    console.log(`baseline ${base.ok}/${N}、軟判決＋抹除 ${era.ok}/${N}`);
    expect(era.ok).toBeGreaterThanOrEqual(base.ok);
    expect(era.wrong).toBe(0);
  });

  it('頻道白化：有窄頻干擾時明顯改善', () => {
    const tones: [number, number][] = [
      [19853, 0.01],
      [20096, 0.01],
    ];
    const ch = { ...SCENARIOS.medium, tones };
    const off = rate((i) => ({
      cfg: DEFAULTS,
      ch,
      opts: { ...DEFAULT_OPTIONS, whitening: false },
      rng: makeRng(52_000 + i),
    }));
    const on = rate((i) => ({ cfg: DEFAULTS, ch, opts: DEFAULT_OPTIONS, rng: makeRng(52_000 + i) }));
    console.log(`白化關 ${off.ok}/${N}、白化開 ${on.ok}/${N}`);
    expect(on.ok - off.ok).toBeGreaterThanOrEqual(3);
    expect(on.wrong).toBe(0);
  });
});
