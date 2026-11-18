// 測試 5-1：都卜勒（邊走邊收），自動偵測模式（8 組設定輪流發送）
import { describe, expect, it } from 'vitest';
import { makeRng, walkingVelocity } from '../bench/channel.ts';
import { candidateAt, runTrials } from '../bench/trial.ts';
import { DEFAULT_OPTIONS } from '../src/modem/config.ts';
import { SCENARIOS } from './helpers.ts';

const VELOCITIES = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 'walk'] as const;

describe('都卜勒：自動偵測模式', () => {
  for (const [label, ch, min] of [
    ['安靜', SCENARIOS.quiet, 0.95],
    ['中等噪音', SCENARIOS.medium, 0.85],
  ] as const) {
    for (const v of VELOCITIES) {
      const name = v === 'walk' ? '走路（0.5～1.5 m/s 緩慢變化）' : `${v} m/s`;
      it(`${label}、${name}：≥ ${min * 100}%`, () => {
        const r = runTrials(32, (i) => {
          const rng = makeRng(40_000 + i);
          return {
            cfg: candidateAt(i),
            ch: { ...ch, velocity: v === 'walk' ? walkingVelocity(rng) : v },
            opts: DEFAULT_OPTIONS,
            rng,
            mode: 'auto',
          };
        });
        expect(r.ok / 32).toBeGreaterThanOrEqual(min);
        expect(r.lock / 32).toBeGreaterThanOrEqual(min);
        expect(r.wrong).toBe(0);
      });
    }
  }
});
