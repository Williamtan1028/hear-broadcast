// 分段累積的合併方式：數學性質檢查
import { describe, expect, it } from 'vitest';
import { goertzel, segmentedPower } from '../src/modem/dsp.ts';

const fs = 44100;
const tone = (n: number, f: number, flipAt = -1) =>
  Float32Array.from(
    { length: n },
    (_, i) => (i >= flipAt && flipAt >= 0 ? -1 : 1) * Math.sin((2 * Math.PI * f * i) / fs + 0.3),
  );

describe('segmentedPower', () => {
  const f = 19800;
  const w = (2 * Math.PI * f) / fs;
  const x = tone(2400, f);

  it('coherent 合併等於整窗 Goertzel', () => {
    for (const segs of [2, 3, 4]) {
      const ref = goertzel(x, 2 * Math.cos(w));
      expect(segmentedPower(x, w, segs, 'coherent')).toBeCloseTo(ref, 3);
    }
  });

  it('segs = 1 時三種方式都等於 Goertzel', () => {
    const ref = goertzel(x, 2 * Math.cos(w));
    for (const m of ['split', 'egc', 'coherent'] as const)
      expect(segmentedPower(x, w, 1, m)).toBeCloseTo(ref, 6);
  });

  it('穩定的音：egc ≈ coherent ≈ 2 × split', () => {
    const coh = segmentedPower(x, w, 2, 'coherent');
    expect(segmentedPower(x, w, 2, 'egc') / coh).toBeCloseTo(1, 2);
    expect(segmentedPower(x, w, 2, 'split') / coh).toBeCloseTo(0.5, 2);
  });

  it('符號中途相位反轉：coherent 抵銷，egc 不受影響', () => {
    const y = tone(2400, f, 1200);
    const stable = segmentedPower(x, w, 2, 'egc');
    expect(segmentedPower(y, w, 2, 'coherent') / stable).toBeLessThan(0.01);
    expect(segmentedPower(y, w, 2, 'egc') / stable).toBeCloseTo(1, 2);
  });
});
