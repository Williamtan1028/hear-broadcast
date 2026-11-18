// 測試 3：通道模擬（stable 模式）。預設設定 19500 Hz／50 Hz，每種情境 30 次。
import { describe, expect, it } from 'vitest';
import { BASELINE_OPTIONS, DEFAULT_OPTIONS, makeConfig } from '../src/modem/config.ts';
import { SCENARIOS, successRate } from './helpers.ts';

const cfg = makeConfig(19500, 'stable');
// 門檻（第 8 節）：安靜 100%、中等 95%、強 80%、高頻衰減＋安靜 95%、高頻衰減＋中等 75%
const CASES = [
  ['安靜', SCENARIOS.quiet, 1.0],
  ['中等（噪音 0.02、回音 0.4 s）', SCENARIOS.medium, 0.95],
  ['強（噪音 0.05、回音 0.8 s）', SCENARIOS.strong, 0.8],
  ['高頻衰減＋安靜', SCENARIOS.hfQuiet, 0.95],
  ['高頻衰減＋中等', SCENARIOS.hfMedium, 0.75],
] as const;

describe('通道模擬：stable 模式（gain 0.05、振幅 0.6、8 bytes 隨機 payload）', () => {
  for (const [name, ch, min] of CASES) {
    for (const fsRx of [44100, 48000]) {
      it(`預設接收器 ${name}，48 kHz → ${fsRx / 1000} kHz：≥ ${min * 100}%`, () => {
        expect(successRate(30, cfg, ch, DEFAULT_OPTIONS, 10_000, { fsRx })).toBeGreaterThanOrEqual(min);
      });
    }
    it(`baseline（PoC 移植）${name}，48 kHz → 44.1 kHz：≥ ${min * 100}%`, () => {
      expect(successRate(30, cfg, ch, BASELINE_OPTIONS, 10_000)).toBeGreaterThanOrEqual(min);
    });
  }
});
