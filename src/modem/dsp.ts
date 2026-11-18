/**
 * 基礎訊號處理工具：Goertzel、Hann 窗、FFT、Biquad 濾波器。
 * 全部自行實作，不依賴 DOM，可在 Node 與瀏覽器（含 Worker）執行。
 */

const hannCache = new Map<number, Float32Array>();
/**
 * 取得長度 L 的 Hann 窗（快取）。
 * Hann 窗可降低頻譜洩漏，讓相鄰 50 Hz 的頻道不會互相干擾。
 */
export function hann(L: number): Float32Array {
  let w = hannCache.get(L);
  if (!w) {
    w = new Float32Array(L);
    for (let i = 0; i < L; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1));
    hannCache.set(L, w);
  }
  return w;
}

/** Goertzel 係數：2cos(2πf/fs) */
export const goertzelCoef = (f: number, fs: number): number => 2 * Math.cos((2 * Math.PI * f) / fs);

/**
 * Goertzel 演算法：只計算單一頻率的功率，比整段 FFT 便宜。
 * 等同 DFT 在該頻率的 |X(f)|²（未正規化）。
 * @param x 已加窗的訊號
 * @param coef goertzelCoef(f, fs)
 */
export function goertzel(x: Float32Array, coef: number): number {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + coef * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coef * s1 * s2;
}

/**
 * 基 2 FFT（就地運算、複數）。用於都卜勒頻偏搜尋：一次 FFT 可同時得到所有頻偏下各頻道的功率，
 * 比對每個頻偏都跑 Goertzel 省下一個數量級的計算。
 */
export class FFT {
  readonly n: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  /** @param n FFT 長度，必須是 2 的次方 */
  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT 長度必須是 2 的次方');
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /**
   * 實數訊號的功率譜 |X[k]|²，k = 0..n/2。輸入不足 n 時補零。
   * @param x 輸入（已加窗）
   * @param out 輸出陣列（長度 n/2 + 1）
   */
  powerSpectrum(x: ArrayLike<number>, out: Float32Array): Float32Array {
    const { n, re, im, rev } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      re[j] = i < x.length ? x[i] : 0;
      im[j] = 0;
    }
    this.transform();
    for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
    return out;
  }

  private transform(): void {
    const { n, re, im, cos, sin } = this;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0, t = 0; j < half; j++, t += step) {
          const a = start + j;
          const b = a + half;
          const wr = cos[t];
          const wi = sin[t];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/** 大於等於 x 的最小 2 的次方 */
export const nextPow2 = (x: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, x)));

/** Biquad 濾波器（Direct Form I），回傳逐樣本處理函式 */
export type SampleFilter = (v: number) => number;

function biquad(b0: number, b1: number, b2: number, a1: number, a2: number): SampleFilter {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (v: number) => {
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/**
 * 二階 Butterworth 高通（Q = 0.707，RBJ Audio EQ Cookbook）。
 * 接收端用兩級串接，先濾掉人聲、列車等低頻強噪音。
 */
export function biquadHighpass(fs: number, fc: number, q = Math.SQRT1_2): SampleFilter {
  const w = (2 * Math.PI * fc) / fs;
  const al = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  const a0 = 1 + al;
  return biquad((1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0);
}

/** 二階 Butterworth 低通（測試中模擬喇叭／麥克風的高頻衰減） */
export function biquadLowpass(fs: number, fc: number, q = Math.SQRT1_2): SampleFilter {
  const w = (2 * Math.PI * fc) / fs;
  const al = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  const a0 = 1 + al;
  return biquad((1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0);
}

/** 功率比轉 dB */
export const toDb = (ratio: number): number => 10 * Math.log10(Math.max(ratio, 1e-30));
