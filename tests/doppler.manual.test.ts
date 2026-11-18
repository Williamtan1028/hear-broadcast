// 測試 5-1：都卜勒（邊走邊收），接收端已知頻段
import { describe, expect, it } from 'vitest';
import { makeRng, walkingVelocity } from '../bench/channel.ts';
import { runTrials } from '../bench/trial.ts';
import { DEFAULT_OPTIONS, makeConfig, type ModeName } from '../src/modem/config.ts';
import { SCENARIOS } from './helpers.ts';

const VELOCITIES = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 'walk'] as const;

for (const mode of ['standard', 'stable'] as ModeName[]) {
  describe(`都卜勒：手動頻段、${mode} 模式`, () => {
    for (const [label, ch, min] of [
      ['安靜', SCENARIOS.quiet, 0.95],
      ['中等噪音', SCENARIOS.medium, 0.85],
    ] as const) {
      for (const v of VELOCITIES) {
        const name = v === 'walk' ? '走路（0.5～1.5 m/s 緩慢變化）' : `${v} m/s`;
        it(`${label}、${name}：≥ ${min * 100}%`, () => {
          const r = runTrials(30, (i) => {
            const rng = makeRng(30_000 + i);
            return {
              cfg: makeConfig(19500, mode),
              ch: { ...ch, velocity: v === 'walk' ? walkingVelocity(rng) : v },
              opts: DEFAULT_OPTIONS,
              rng,
            };
          });
          expect(r.ok / 30).toBeGreaterThanOrEqual(min);
          expect(r.wrong).toBe(0);
        });
      }
    }
  });
}
