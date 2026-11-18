/**
 * 都卜勒補償（3.5.1 邊走邊收）。
 *
 * 乘客以徑向速度 v 靠近（v > 0）或遠離喇叭時，收到的訊號是 r(t) = s(α t)，α = 1 + v / c。
 *   - 所有頻率乘上 α：19.5～20.35 kHz 在 1.5 m/s 時偏移約 85～89 Hz，比 50 Hz 的頻道間距還大。
 *   - 時間軸除以 α：2.4 秒的封包約差 10 ms。
 * 做法：
 *   1. 偵測：對每個 hop 做一次 FFT（同符號長度的頻段共用），在 ±120 Hz 內以 FFT bin 為步長搜尋頻偏，
 *      每個頻偏都算一次前導碼分數，取最大者。
 *   2. 同步：在前導碼上精細搜尋時間與頻偏，得到 α。
 *   3. 解調：所有頻道頻率乘 α、符號長度除以 α；每判定一個高信心符號，就以三點拋物線內插估計
 *      實際頻率，更新 α（決策導向追蹤），支援一則廣播中速度緩慢變化。
 */
import { DOPPLER } from './config.ts';

/** 速度（m/s，靠近為正）對應的伸縮比例 α */
export const dopplerFactor = (v: number): number => 1 + v / DOPPLER.soundSpeed;

/** 頻偏（Hz，於參考頻率 fRef）換算成 α */
export const offsetToAlpha = (offsetHz: number, fRef: number): number => 1 + offsetHz / fRef;

/**
 * 頻偏搜尋表：每個候選頻偏下，各頻道對應的 FFT bin。
 */
export interface OffsetTable {
  /** 候選頻偏（Hz） */
  offsets: Float64Array;
  /** bins[o * nIdx + j] = 頻偏 o 時第 j 個頻道的 bin */
  bins: Int32Array;
  nIdx: number;
}

/**
 * 建立頻偏搜尋表。
 * @param freqs 要計算的頻道頻率（Hz）
 * @param binHz FFT bin 寬度
 * @param maxShiftHz 搜尋範圍 ±Hz
 * @param fRef 頻偏所對應的參考頻率（頻偏與頻率成正比，高頻道偏移略大）
 */
export function buildOffsetTable(
  freqs: number[],
  binHz: number,
  maxShiftHz: number,
  fRef: number,
): OffsetTable {
  const step = Math.min(binHz, DOPPLER.coarseStepHz);
  const n = Math.floor(maxShiftHz / step);
  const offsets = new Float64Array(2 * n + 1);
  for (let i = -n; i <= n; i++) offsets[i + n] = i * step;
  const nIdx = freqs.length;
  const bins = new Int32Array(offsets.length * nIdx);
  for (let o = 0; o < offsets.length; o++) {
    const alpha = offsetToAlpha(offsets[o], fRef);
    for (let j = 0; j < nIdx; j++) bins[o * nIdx + j] = Math.round((freqs[j] * alpha) / binHz);
  }
  return { offsets, bins, nIdx };
}

/**
 * 三點拋物線內插（以 dB 計算），回傳峰值相對於中點的位置（−1～1，單位為探測間距）。
 * @param pm 中點左側的功率
 * @param p0 中點功率
 * @param pp 中點右側的功率
 */
export function parabolicPeak(pm: number, p0: number, pp: number): number {
  const a = Math.log(pm + 1e-30);
  const b = Math.log(p0 + 1e-30);
  const c = Math.log(pp + 1e-30);
  const den = a - 2 * b + c;
  if (den >= 0) return 0; // 不是峰值（凹向上），不更新
  const d = (0.5 * (a - c)) / den;
  return Math.max(-1, Math.min(1, d));
}
