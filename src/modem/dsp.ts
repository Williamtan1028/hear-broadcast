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
 * 分段累積的合併方式（解碼窗切成 S 段，各段 Goertzel 的複數輸出 y_m）：
 *  - 'split'：Σ|y_m|²，平方律（非同調）合併，各段相位完全不管
 *  - 'egc'：(Σ|y_m|)²，等增益合併＝在「各段之間相位任意」假設下的最大似然（GLRT）；
 *    訊號穩定時與整窗同調只差約 2.5 dB（split 差 3 dB），相位反轉時與 split 一樣不會抵銷
 *  - 'coherent'：|Σ y_m e^{jωL(S−1−m)}|²，等同整窗 Goertzel（同調）
 *  - 'mix'：(coherent + egc) / 2。訊號穩定時兩者相同（同調的積分增益），符號中途相位反轉時
 *    同調項抵銷、egc 項保留一半；實測在強噪音與移動衰落下都最好（docs/benchmarks.md 3.6）
 */
export type AccumMetric = 'split' | 'egc' | 'coherent' | 'mix';

/**
 * 分段 Goertzel：把 x 切成 segs 段，依 metric 合併各段在角頻率 w（rad/樣本）的功率。
 * segs = 1 時就是一般的 Goertzel。
 */
export function segmentedPower(x: Float32Array, w: number, segs: number, metric: AccumMetric): number {
  const c = Math.cos(w);
  const coef = 2 * c;
  if (segs <= 1) return goertzel(x, coef);
  const sn = Math.sin(w);
  const L = Math.floor(x.length / segs);
  const rc = Math.cos(w * L);
  const rs = Math.sin(w * L);
  let sumP = 0;
  let sumA = 0;
  let Yr = 0;
  let Yi = 0;
  for (let m = 0; m < segs; m++) {
    let s1 = 0;
    let s2 = 0;
    for (let i = m * L, e = i + L; i < e; i++) {
      const s0 = x[i] + coef * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    // y = s1 − e^{−jw}·s2 = Σ x[k]·e^{jw(段尾 − k)}
    const yr = s1 - c * s2;
    const yi = sn * s2;
    const p = yr * yr + yi * yi;
    sumP += p;
    sumA += Math.sqrt(p);
    // Horner：Y ← Y·e^{jwL} + y_m（以整窗窗尾為相位參考）
    const t = Yr * rc - Yi * rs + yr;
    Yi = Yr * rs + Yi * rc + yi;
    Yr = t;
  }
  if (metric === 'split') return sumP;
  if (metric === 'egc') return sumA * sumA;
  if (metric === 'mix') return (Yr * Yr + Yi * Yi + sumA * sumA) / 2;
  return Yr * Yr + Yi * Yi;
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
