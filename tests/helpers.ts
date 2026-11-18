import { makeRng, SCENARIOS, type ChannelOptions } from '../bench/channel.ts';
import { runTrials, type TrialSpec } from '../bench/trial.ts';
import type { ModemConfig, RxOptions } from '../src/modem/config.ts';

/** 跑 n 次試驗並回傳成功率；每次試驗的種子不同但固定 */
export function successRate(
  n: number,
  cfg: ModemConfig,
  ch: ChannelOptions,
  opts: Partial<RxOptions>,
  seed: number,
  extra: Partial<TrialSpec> = {},
): number {
  return runTrials(n, (i) => ({ cfg, ch, opts, rng: makeRng(seed + i), ...extra })).ok / n;
}

export { SCENARIOS };
