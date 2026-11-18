/**
 * 低頻洩漏檢查。
 *
 * 最高原則是「不打擾聽得到的人」：發送的高頻訊號不能把能量洩漏到人耳聽得到的頻率。
 * 對整段高頻訊號加 Hann 窗做 FFT，計算 16 kHz 以下、18 kHz 以下的能量占總能量的比例（dB）。
 * 站務端每次播放前都會執行，超過門檻就拒絕播放；測試也用同一個函式。
 */
import { LEAKAGE, LOW_BAND_F0 } from './config.ts';
import { FFT, hann, nextPow2, toDb } from './dsp.ts';

export interface LeakageReport {
  /** 16 kHz 以下的能量占比（dB） */
  below16kDb: number;
  /** 18 kHz 以下的能量占比（dB） */
  below18kDb: number;
  /** 是否通過門檻 */
  pass: boolean;
  /** 不通過的原因 */
  reasons: string[];
}

/**
 * 計算訊號在 cutoffs 以下的能量占比。
 * @param x 訊號
 * @param fs 取樣率
 * @param cutoffs 截止頻率（Hz）
 * @returns 每個截止頻率對應的能量占比（dB）
 */
export function lowBandEnergyDb(x: Float32Array, fs: number, cutoffs: number[]): number[] {
  const n = nextPow2(x.length);
  const w = hann(x.length);
  const xw = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) xw[i] = x[i] * w[i];
  const spec = new FFT(n).powerSpectrum(xw, new Float32Array(n / 2 + 1));
  let total = 0;
  for (let k = 0; k < spec.length; k++) total += spec[k];
  return cutoffs.map((fc) => {
    const kc = Math.floor((fc / fs) * n);
    let s = 0;
    for (let k = 0; k < kc && k < spec.length; k++) s += spec[k];
    return toDb(s / (total + 1e-30));
  });
}

/**
 * 洩漏檢查：16 kHz 以下 ≤ −100 dB、18 kHz 以下 ≤ −80 dB（18 kHz 頻段不檢查後者）。
 * @param x 高頻訊號（不含叮咚與語音）
 * @param fs 取樣率
 * @param f0 使用的頻段
 */
export function checkLeakage(x: Float32Array, fs: number, f0: number): LeakageReport {
  const [below16kDb, below18kDb] = lowBandEnergyDb(x, fs, [16000, 18000]);
  const reasons: string[] = [];
  if (below16kDb > LEAKAGE.below16k)
    reasons.push(`16 kHz 以下洩漏 ${below16kDb.toFixed(1)} dB 超過 ${LEAKAGE.below16k} dB`);
  if (f0 > LOW_BAND_F0 && below18kDb > LEAKAGE.below18k)
    reasons.push(`18 kHz 以下洩漏 ${below18kDb.toFixed(1)} dB 超過 ${LEAKAGE.below18k} dB`);
  return { below16kDb, below18kDb, pass: reasons.length === 0, reasons };
}
