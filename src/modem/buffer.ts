/**
 * 接收端共用的環形緩衝區與頻譜快取。
 */
import { RX } from './config.ts';
import { FFT, hann, nextPow2, type SampleFilter } from './dsp.ts';

/**
 * 以「絕對樣本索引」存取的環形緩衝區。
 * 多個接收器（自動偵測的 8 組設定）可以共用同一份緩衝區，避免重複複製音訊。
 */
export class SampleBuffer {
  readonly cap: number;
  readonly buf: Float32Array;
  /** 已寫入的樣本總數（下一個樣本的絕對索引） */
  total = 0;

  /**
   * @param fs 取樣率
   * @param seconds 緩衝區長度（秒），必須大於最長封包
   */
  constructor(fs: number, seconds: number = RX.bufferSec) {
    this.cap = Math.round(fs * seconds);
    this.buf = new Float32Array(this.cap);
  }

  /** 寫入一段樣本，可選擇先經過濾波器 */
  write(chunk: ArrayLike<number>, filter?: SampleFilter): void {
    const { buf, cap } = this;
    let w = this.total % cap;
    for (let i = 0; i < chunk.length; i++) {
      buf[w] = filter ? filter(chunk[i]) : chunk[i];
      if (++w === cap) w = 0;
    }
    this.total += chunk.length;
  }

  /**
   * 讀出 [start, start + L) 並乘上 Hann 窗。超出已寫入範圍或已被覆蓋的部分補 0。
   * @param out 可重複使用的輸出陣列
   */
  windowed(start: number, L: number, out: Float32Array = new Float32Array(L)): Float32Array {
    const w = hann(L);
    const { buf, cap, total } = this;
    const oldest = total - cap;
    let idx = (((start % cap) + cap) % cap) | 0;
    for (let i = 0; i < L; i++) {
      const a = start + i;
      out[i] = a >= 0 && a >= oldest && a < total ? buf[idx] * w[i] : 0;
      if (++idx === cap) idx = 0;
    }
    return out;
  }
}

/** FFT 長度相對於窗長的倍數（補零讓頻率格點更密，頻偏搜尋更準） */
const FFT_OVERSAMPLE = 1.5;

interface SpectrumGroup {
  fft: FFT;
  win: Float32Array;
  cache: Map<number, Float32Array>;
  order: number[];
}

/**
 * 頻譜快取：同一個時間點、同一個窗長的 FFT 只算一次。
 * 自動偵測時，符號長度相同的 4 個頻段共用同一份 FFT，這是都卜勒頻偏搜尋能在手機上跑得動的關鍵。
 */
export class SpectrumCache {
  private readonly groups = new Map<number, SpectrumGroup>();
  /** 已計算的 FFT 次數（效能統計用） */
  computed = 0;

  constructor(
    private readonly buffer: SampleBuffer,
    private readonly fs: number,
    private readonly maxEntries = 512,
  ) {}

  /** 窗長 L 對應的 FFT 長度 */
  fftSize(L: number): number {
    return nextPow2(Math.ceil(L * FFT_OVERSAMPLE));
  }

  /** 一個 FFT bin 的寬度（Hz） */
  binHz(L: number): number {
    return this.fs / this.fftSize(L);
  }

  /**
   * 取得結尾在 t、長度 L 的加窗功率譜。
   * @returns 長度 nfft/2 + 1 的功率譜
   */
  get(t: number, L: number): Float32Array {
    let g = this.groups.get(L);
    if (!g) {
      const n = this.fftSize(L);
      g = { fft: new FFT(n), win: new Float32Array(L), cache: new Map(), order: [] };
      this.groups.set(L, g);
    }
    const hit = g.cache.get(t);
    if (hit) return hit;
    let spec: Float32Array;
    if (g.order.length >= this.maxEntries) {
      const old = g.order.shift()!;
      spec = g.cache.get(old)!;
      g.cache.delete(old);
    } else {
      spec = new Float32Array(g.fft.n / 2 + 1);
    }
    this.buffer.windowed(t - L, L, g.win);
    g.fft.powerSpectrum(g.win, spec);
    this.computed++;
    g.cache.set(t, spec);
    g.order.push(t);
    return spec;
  }
}
