/**
 * 接收端（串流處理）。
 *
 * 流程：
 *   1. 偵測：每個 hop（N/12）對結尾在 t、長度 0.75N 的視窗加 Hann 窗，算同步音 A、B 的分數，
 *      偵測分數 = min(rb(t), ra(t−k), rb(t−2k), ra(t−3k))，超過 0.3 觸發。
 *      （不用幾何平均：前導碼只收到一半時會誤觸發，使起點提早兩個符號。）
 *   2. 找峰值：觸發後再追蹤 N 個樣本，取分數最高點，粗估封包起點。
 *   3. 精細對齊：在 ±N/4 內以 1 ms 步長搜尋，讓 4 個前導碼符號的目標音占比總和最大。
 *      開啟都卜勒補償時，同時估計頻偏（α）。
 *   4. 解 header（len 與 ~len），不合法就放棄，從 p + 4N 之後重新搜尋。
 *   5. 收完整個封包後判定每個資料符號，RS 解碼；失敗時依序嘗試抹除解碼、重送合併。
 *
 * baseline（BASELINE_OPTIONS）與 PoC 的 modem.js 行為完全相同，作為 A/B 比較的基準。
 */
import { CombiningStore, combineSymbols, normalizePowers, type FailedEntry } from './combining.ts';
import {
  AUTO,
  BASELINE_OPTIONS,
  DATA_BASE,
  DEFAULTS,
  DOPPLER,
  HEADER_SYMBOLS,
  NOISE,
  NT,
  PREAMBLE,
  RX,
  type ModemConfig,
  type RxOptions,
} from './config.ts';
import { defaultDetector, type SymbolDecision, type SymbolDetector } from './detectors/index.ts';
import { buildOffsetTable, offsetToAlpha, parabolicPeak, type OffsetTable } from './doppler.ts';
import { SampleBuffer, SpectrumCache } from './buffer.ts';
import { goertzel, goertzelCoef } from './dsp.ts';
import { channelFreqs, symbolSamples } from './fsk.ts';
import { RsError, rsDecode, type RsDecodeResult } from './rs.ts';

/** 成功解碼的訊息 */
export interface RxMessage {
  ok: true;
  payload: Uint8Array;
  /** RS 自動修正的位元組數 */
  fixed: number;
  /** 使用的抹除數 */
  erasures: number;
  /** 訊號品質：解碼符號的目標音功率占 18 頻道總功率的平均值（0～1） */
  quality: number;
  /** 是否靠重送合併才解出 */
  combined: boolean;
  /** 估計的頻偏（Hz，於同步音頻率） */
  offsetHz: number;
  /** 偵測分數 */
  score: number;
  cfg: ModemConfig;
  /** 封包起點、終點（絕對樣本索引） */
  start: number;
  end: number;
}

/** 解碼失敗 */
export interface RxFailure {
  ok: false;
  error: string;
  stage: 'header' | 'body';
  cfg: ModemConfig;
  start: number;
}

export type RxEvent = RxMessage | RxFailure;

/** 每個 hop 的狀態（給 UI 顯示與「匯出頻道特徵」用） */
export interface HopInfo {
  t: number;
  score: number;
  /** 18 頻道功率（掃描模式時為 null） */
  powers: Float64Array | null;
  /** 目前最佳頻偏（Hz） */
  offsetHz: number;
}

export interface ReceiverInit {
  cfg?: Partial<ModemConfig>;
  opts?: Partial<RxOptions>;
  /** 共用的緩衝區（AutoReceiver 使用），不給就自己建立 */
  buffer?: SampleBuffer;
  /** 共用的頻譜快取 */
  spectra?: SpectrumCache;
  /** 掃描模式：只算同步音與 4 個參考頻道 */
  scan?: boolean;
  detector?: SymbolDetector;
  onEvent?: (e: RxEvent) => void;
  onHop?: (h: HopInfo) => void;
}

export interface RxStats {
  ok: number;
  fail: number;
  combined: number;
}

const ALL = Array.from({ length: NT }, (_, i) => i);

type State = 'search' | 'peak' | 'header' | 'body';

/** 解調中封包的狀態 */
interface Demod {
  /** 封包起點 */
  p: number;
  /** 目前的伸縮比例 */
  alpha: number;
  /** 下一個符號的起點（浮點，絕對樣本索引） */
  pos: number;
  /** 已解調符號的 18 頻道功率 */
  syms: Float64Array[];
  /** 已解調符號的判定（前導碼為 null） */
  dec: (SymbolDecision | null)[];
  /** 前導碼對齊品質（0～4） */
  quality: number;
  /** 偵測分數 */
  score: number;
  /** 背景持續解調的目標符號數（失敗封包供合併用） */
  target: number;
}

/** 重送合併工作：等兩個封包都解調到 S 個符號後合併 */
interface CombineJob {
  cur: Demod;
  other: Demod;
  len: number;
  reserve: number;
}

/** 低 SNR 偵測：把「同步音 / 噪音」倍數 z 映射到 0～1，使 z = snrThreshold 時恰為 RX.threshold */
const SNR_MAP = (RX.snrThreshold * (1 - RX.threshold)) / RX.threshold;

export class Receiver {
  readonly fs: number;
  readonly cfg: ModemConfig;
  readonly opts: RxOptions;
  readonly N: number;
  readonly hop: number;
  readonly k: number;
  readonly Wd: number;
  readonly F: number[];
  /** 同步音的參考頻率（頻偏換算 α 用） */
  readonly fRef: number;
  readonly buffer: SampleBuffer;
  readonly stats: RxStats = { ok: 0, fail: 0, combined: 0 };
  scan: boolean;
  state: State = 'search';
  nextHop: number;
  quietUntil = 0;
  onEvent: (e: RxEvent) => void;
  onHop: ((h: HopInfo) => void) | null;
  /** 最近一次的偵測分數 */
  lastScore = 0;

  private readonly ownsBuffer: boolean;
  private readonly spectra: SpectrumCache | null;
  private readonly detector: SymbolDetector;
  private readonly coefAll: number[];
  private readonly win: Float32Array;
  private readonly symWin: Float32Array;
  private readonly symLen: number;
  private readonly symOff: number;
  /** 解碼窗分幾段累積（1 = 整窗，PoC） */
  private readonly segments: number;
  private readonly maxSymbols: number;
  private hist: { a: Float64Array[]; b: Float64Array[]; za: Float64Array[]; zb: Float64Array[] } = {
    a: [],
    b: [],
    za: [],
    zb: [],
  };
  private trigScore = 0;
  private best = { s: 0, t: 0, o: 0 };
  private peakUntil = 0;
  private demod: Demod | null = null;
  private len = 0;
  private lenSoft = false;
  private S = 0;
  private readonly store: CombiningStore<Demod>;
  /** 背景持續解調的失敗封包 */
  private background: Demod[] = [];
  private jobs: CombineJob[] = [];
  private table: OffsetTable | null = null;
  private lastOffsetIdx = 0;

  /**
   * @param fs 取樣率
   * @param init 設定、優化選項、共用緩衝區與回呼
   */
  constructor(fs: number, init: ReceiverInit = {}) {
    this.fs = fs;
    this.cfg = { ...DEFAULTS, ...init.cfg };
    this.opts = { ...BASELINE_OPTIONS, ...init.opts };
    this.scan = !!init.scan;
    this.detector = init.detector ?? defaultDetector;
    this.onEvent = init.onEvent ?? (() => {});
    this.onHop = init.onHop ?? null;
    this.F = channelFreqs(this.cfg);
    this.fRef = this.cfg.f0 + this.cfg.df / 2;
    this.N = symbolSamples(this.cfg, fs);
    this.hop = Math.max(1, Math.round(this.N / RX.hopDiv));
    this.k = Math.round(this.N / this.hop);
    this.Wd = Math.round(this.N * RX.detectWin);
    this.symLen = Math.round((this.opts.accumulation ? RX.symWinLenAccum : RX.symWinLen) * this.N);
    this.symOff = Math.round(RX.symWinStart * this.N);
    this.segments = this.opts.accumulation ? RX.accumSegments : 1;
    this.maxSymbols = HEADER_SYMBOLS + 2 * (this.cfg.maxLen + this.cfg.nsym);
    this.ownsBuffer = !init.buffer;
    this.buffer = init.buffer ?? new SampleBuffer(fs);
    this.coefAll = this.F.map((f) => goertzelCoef(f, fs));
    this.win = new Float32Array(this.Wd);
    this.symWin = new Float32Array(this.symLen);
    this.nextHop = this.buffer.total + this.Wd;
    this.store = new CombiningStore<Demod>(fs);
    if (this.opts.doppler || this.opts.snrDetect) {
      // FFT 前端：一次 FFT 得到所有頻道、所有頻偏的功率
      this.spectra = init.spectra ?? new SpectrumCache(this.buffer, fs);
      const binHz = this.spectra.binHz(this.Wd);
      const maxShift = this.opts.doppler ? DOPPLER.maxShiftHz : 0;
      this.table = buildOffsetTable(this.F, binHz, maxShift, this.fRef);
      this.lastOffsetIdx = (this.table.offsets.length - 1) / 2;
    } else {
      this.spectra = null;
    }
  }

  /** 推入新的音訊樣本（自己擁有緩衝區時使用） */
  push(chunk: ArrayLike<number>): void {
    if (!this.ownsBuffer) throw new Error('共用緩衝區的接收器請由 AutoReceiver 推入');
    this.buffer.write(chunk);
    this.run();
  }

  /** 處理緩衝區中所有新的 hop，並推進解碼狀態機 */
  run(): void {
    const total = this.buffer.total;
    while (total >= this.nextHop) {
      this.onHopAt(this.nextHop);
      this.nextHop += this.hop;
    }
    this.advance();
  }

  /** 切換成完整模式（自動偵測鎖定後） */
  setFullMode(): void {
    this.scan = false;
    this.hist = { a: [], b: [], za: [], zb: [] };
  }

  // ---------------- 偵測 ----------------

  private onHopAt(t: number): void {
    let a: Float64Array;
    let b: Float64Array;
    let za: Float64Array | null = null;
    let zb: Float64Array | null = null;
    let powers: Float64Array | null = null;
    if (!this.table) {
      // baseline：Goertzel 直接算（掃描模式只算 6 個頻道）
      const x = this.buffer.windowed(t - this.Wd, this.Wd, this.win);
      const idx = this.scan ? AUTO.scanChannels : ALL;
      const P = new Float64Array(idx.length);
      let sum = 1e-12;
      for (let j = 0; j < idx.length; j++) sum += P[j] = goertzel(x, this.coefAll[idx[j]]);
      a = new Float64Array([P[0] / sum]);
      b = new Float64Array([P[1] / sum]);
      if (!this.scan) powers = P;
    } else {
      ({ a, b, za, zb, powers } = this.fftHop(t));
    }
    const H = this.hist;
    H.a.push(a);
    H.b.push(b);
    if (za && zb) {
      H.za.push(za);
      H.zb.push(zb);
    }
    if (H.a.length > 6 * this.k) {
      H.a.shift();
      H.b.shift();
      if (H.za.length) {
        H.za.shift();
        H.zb.shift();
      }
    }
    // 比例分數：決定峰值位置（尖銳）；低 SNR 分數：只用來觸發（在強訊號時會飽和成平台）
    const ratio = this.patternScore(H.a, H.b);
    const trig = za ? this.patternScore(H.za, H.zb) : ratio;
    this.lastScore = trig.score;
    if (this.onHop) this.onHop({ t, score: trig.score, powers, offsetHz: this.offsetHzOf(trig.o) });
    if (t < this.quietUntil) return;
    // 低 SNR 觸發仍要求比例分數不能太低：安靜時噪音底極低，旁瓣洩漏也會被當成「高 SNR」而提早觸發
    const fire = za ? trig.score > RX.threshold && ratio.score > RX.snrRatioFloor : trig.score > RX.threshold;
    if (this.state === 'search' && fire) {
      this.state = 'peak';
      this.best = { s: ratio.score, t, o: za ? trig.o : ratio.o };
      this.trigScore = trig.score;
      this.peakUntil = t + this.N;
    } else if (this.state === 'peak') {
      if (ratio.score > this.best.s) {
        this.best = { s: ratio.score, t, o: ratio.o };
        // 低 SNR 觸發可能比真正的峰值早：只要分數還在上升就延長搜尋
        if (za) this.peakUntil = Math.max(this.peakUntil, t + (this.N >> 1));
      }
      this.trigScore = Math.max(this.trigScore, trig.score);
      if (t >= this.peakUntil) {
        this.state = 'header';
        const p = Math.round(this.best.t + (this.N - this.Wd) / 2 - 4 * this.N);
        const alpha = offsetToAlpha(this.offsetHzOf(this.best.o), this.fRef);
        this.demod = { p, alpha, pos: p, syms: [], dec: [], quality: 0, score: this.trigScore, target: 0 };
      }
    }
  }

  /** 前導碼樣式分數：所有頻偏中 min(b(t), a(t−k), b(t−2k), a(t−3k)) 的最大值 */
  private patternScore(A: Float64Array[], B: Float64Array[]): { score: number; o: number } {
    const n = A.length;
    const k = this.k;
    let score = 0;
    let bestO = 0;
    if (n > 3 * k) {
      const b0 = B[n - 1];
      const a1 = A[n - 1 - k];
      const b2 = B[n - 1 - 2 * k];
      const a3 = A[n - 1 - 3 * k];
      for (let o = 0; o < b0.length; o++) {
        const m = Math.min(b0[o], a1[o], b2[o], a3[o]);
        if (m > score) {
          score = m;
          bestO = o;
        }
      }
    }
    return { score, o: bestO };
  }

  /**
   * FFT 前端的一個 hop：對每個候選頻偏算同步音 A、B 的分數。
   * - 比例模式：占所選頻道（掃描 6 個／完整 18 個）總功率的比例（與 PoC 相同）。
   * - 低 SNR 模式：除以「18 頻道去掉最大兩個後的平均」（背景噪音估計），再映射到 0～1。
   */
  private fftHop(t: number): {
    a: Float64Array;
    b: Float64Array;
    za: Float64Array | null;
    zb: Float64Array | null;
    powers: Float64Array | null;
  } {
    const tb = this.table!;
    const spec = this.spectra!.get(t, this.Wd);
    const nOff = tb.offsets.length;
    const bins = tb.bins;
    const lim = spec.length - 1;
    const a = new Float64Array(nOff);
    const b = new Float64Array(nOff);
    const snr = this.opts.snrDetect;
    const za = snr ? new Float64Array(nOff) : null;
    const zb = snr ? new Float64Array(nOff) : null;
    const scanIdx = AUTO.scanChannels;
    // 整個搜尋頻帶（含所有頻偏）中最強的 bin：低 SNR 偵測時，目標頻道必須是主導者
    let peak = 0;
    if (snr) {
      const lo = Math.max(0, bins[0] - 2);
      const hi = Math.min(lim, bins[(nOff - 1) * NT + NT - 1] + 2);
      for (let i = lo; i <= hi; i++) if (spec[i] > peak) peak = spec[i];
    }
    for (let o = 0; o < nOff; o++) {
      const base = o * NT;
      const pa = spec[Math.min(bins[base], lim)];
      const pb = spec[Math.min(bins[base + 1], lim)];
      let sum = 0;
      let m1 = 0;
      let m2 = 0;
      for (let j = 0; j < NT; j++) {
        const v = spec[Math.min(bins[base + j], lim)];
        sum += v;
        if (v > m1) {
          m2 = m1;
          m1 = v;
        } else if (v > m2) m2 = v;
      }
      if (this.scan && !snr) {
        let s6 = 1e-12;
        for (const j of scanIdx) s6 += spec[Math.min(bins[base + j], lim)];
        a[o] = pa / s6;
        b[o] = pb / s6;
      } else {
        a[o] = pa / (sum + 1e-12);
        b[o] = pb / (sum + 1e-12);
      }
      if (za && zb) {
        // 參考值 = 背景噪音 + 「整個搜尋頻帶最強的 bin 比目標強多少」的一部分：頻偏搜尋時，
        // 錯誤頻偏下的頻道可能只收到強音的洩漏，若只除以噪音，安靜環境下洩漏也會變成「高 SNR」。
        // 目標本身就是最強者時這一項為 0，所以真正的弱訊號不受影響。
        const noise = (sum - m1 - m2) / (NT - 2) + 1e-20;
        const x = pa / (noise + RX.snrDominance * Math.max(0, peak - pa));
        const y = pb / (noise + RX.snrDominance * Math.max(0, peak - pb));
        za[o] = x / (x + SNR_MAP);
        zb[o] = y / (y + SNR_MAP);
      }
    }
    let powers: Float64Array | null = null;
    if (!this.scan) {
      powers = new Float64Array(NT);
      const base = this.lastOffsetIdx * NT;
      for (let j = 0; j < NT; j++) powers[j] = spec[Math.min(bins[base + j], lim)];
    }
    return { a, b, za, zb, powers };
  }

  private offsetHzOf(o: number): number {
    return this.table ? (this.table.offsets[o] ?? 0) : 0;
  }

  // ---------------- 解調 ----------------

  /** 將視窗切成多段各自計算 Goertzel 功率並累加（避免移動跨越駐波死角時相位反轉自我抵銷） */
  private slicedGoertzel(x: Float32Array, coef: number, slices: number): number {
    if (slices <= 1) return goertzel(x, coef);
    const subLen = Math.floor(x.length / slices);
    let sum = 0;
    for (let s = 0; s < slices; s++) {
      sum += goertzel(x.subarray(s * subLen, (s + 1) * subLen), coef);
    }
    return sum;
  }

  /** 計算從 start 開始一個解碼窗內，在伸縮比例 alpha 下 18 個頻道的功率 */
  private symbolPowersAt(start: number, alpha: number): Float64Array {
    const x = this.buffer.windowed(start, this.symLen, this.symWin);
    const P = new Float64Array(NT);
    const slices = this.segments;
    if (alpha === 1) for (let i = 0; i < NT; i++) P[i] = this.slicedGoertzel(x, this.coefAll[i], slices);
    else
      for (let i = 0; i < NT; i++)
        P[i] = this.slicedGoertzel(x, goertzelCoef(this.F[i] * alpha, this.fs), slices);
    return P;
  }

  /** 符號 j 在起點 p、伸縮比例 alpha 下的解碼窗起點 */
  private symStart(p: number, j: number, alpha: number): number {
    if (alpha === 1) return p + j * this.N + this.symOff;
    return Math.round(p + (j * this.N + this.symOff) / alpha);
  }

  /** 前導碼對齊分數：4 個前導碼符號「目標音占 18 頻道總功率比例」之和 */
  private preambleMetric(p: number, alpha: number): number {
    let s = 0;
    for (let j = 0; j < PREAMBLE.length; j++) {
      const P = this.symbolPowersAt(this.symStart(p, j, alpha), alpha);
      let sum = 1e-12;
      for (let i = 0; i < NT; i++) sum += P[i];
      s += P[PREAMBLE[j]] / sum;
    }
    return s;
  }

  /** 在 ±range 內以 1 ms 步長搜尋最佳起點，回傳 [起點, 分數] */
  private alignTime(p0: number, alpha: number, range: number): [number, number] {
    const step = Math.max(1, Math.round(this.fs * RX.alignStep));
    let best = p0;
    let bs = -1;
    for (let d = -range; d <= range; d += step) {
      const s = this.preambleMetric(p0 + d, alpha);
      if (s > bs) {
        bs = s;
        best = p0 + d;
      }
    }
    return [best, bs];
  }

  /** 在前導碼上精細估計頻偏 */
  private alignFreq(p: number, alpha0: number): number {
    const off0 = (alpha0 - 1) * this.fRef;
    let best = alpha0;
    let bs = -1;
    for (let d = -DOPPLER.fineRangeHz; d <= DOPPLER.fineRangeHz; d += DOPPLER.fineStepHz) {
      const alpha = offsetToAlpha(off0 + d, this.fRef);
      const s = this.preambleMetric(p, alpha);
      if (s > bs) {
        bs = s;
        best = alpha;
      }
    }
    return best;
  }

  /** 精細對齊：決定封包起點 p 與初始 α */
  private align(d: Demod): void {
    const R = Math.round(this.N * RX.alignRange);
    if (!this.opts.doppler) {
      [d.p, d.quality] = this.alignTime(d.p, 1, R);
      d.alpha = 1;
    } else {
      [d.p] = this.alignTime(d.p, d.alpha, R);
      d.alpha = this.alignFreq(d.p, d.alpha);
      [d.p, d.quality] = this.alignTime(d.p, d.alpha, Math.round(R / 3));
    }
    d.pos = d.p;
  }

  /** 下一個符號的解碼窗是否已經收齊 */
  private ready(d: Demod): boolean {
    const a = this.opts.doppler ? d.alpha : 1;
    return d.pos + (this.symOff + this.symLen) / a + 2 <= this.buffer.total;
  }

  /**
   * 解調下一個符號。
   * @param known 已知的頻道（前導碼），用於追蹤；資料符號傳 -1
   */
  private demodNext(d: Demod, known: number): void {
    const doppler = this.opts.doppler;
    const start = doppler ? Math.round(d.pos + this.symOff / d.alpha) : d.pos + this.symOff;
    const P = this.symbolPowersAt(start, doppler ? d.alpha : 1);
    let dec: SymbolDecision | null = null;
    let ch = known;
    let conf = Infinity;
    if (known < 0) {
      dec = this.detector.decide(P.subarray(DATA_BASE));
      ch = DATA_BASE + dec.value;
      conf = dec.confidence;
    }
    d.syms.push(P);
    d.dec.push(dec);
    if (doppler && this.opts.tracking && conf >= DOPPLER.trackMinConfidence) {
      // 決策導向追蹤：在判定的頻道兩側各探測一次，以拋物線內插估計實際頻率
      const x = this.symWin; // symbolPowersAt 剛填好的視窗
      const fc = this.F[ch] * d.alpha;
      const h = DOPPLER.trackProbeHz;
      const pm = this.slicedGoertzel(x, goertzelCoef(fc - h, this.fs), this.segments);
      const pp = this.slicedGoertzel(x, goertzelCoef(fc + h, this.fs), this.segments);
      const delta = parabolicPeak(pm, P[ch], pp) * h;
      const measured = (fc + delta) / this.F[ch];
      d.alpha += DOPPLER.trackGain * (measured - d.alpha);
      const lim = DOPPLER.maxShiftHz / this.fRef;
      d.alpha = Math.min(1 + lim, Math.max(1 - lim, d.alpha));
    }
    d.pos += doppler ? this.N / d.alpha : this.N;
  }

  /** 封包最後一個符號解碼窗結束的估計位置（含都卜勒伸縮的最壞情況） */
  private endOf(d: Demod, symbols: number): number {
    const stretch = this.opts.doppler ? 1 + DOPPLER.maxShiftHz / this.fRef : 1;
    return d.p + symbols * this.N * stretch;
  }

  private advance(): void {
    const N = this.N;
    const margin = Math.round(N * RX.margin);
    const total = this.buffer.total;
    this.runBackground();
    if (this.state === 'header' && this.demod && total >= this.endOf(this.demod, HEADER_SYMBOLS) + margin) {
      const d = this.demod;
      this.align(d);
      for (let j = 0; j < HEADER_SYMBOLS; j++) this.demodNext(d, j < PREAMBLE.length ? PREAMBLE[j] : -1);
      const len = this.decodeHeader(d.dec, d.syms);
      if (len === 0) {
        this.headerFailed(d);
        return;
      }
      this.len = len;
      this.lenSoft = this.lastHeaderSoft;
      this.S = HEADER_SYMBOLS + 2 * (len + this.cfg.nsym);
      this.state = 'body';
    }
    if (this.state === 'body' && this.demod && total >= this.endOf(this.demod, this.S) + margin) {
      const d = this.demod;
      while (d.syms.length < this.S) this.demodNext(d, -1);
      this.finishBody(d);
    }
  }

  private lastHeaderSoft = false;

  /**
   * 解 header（len、~len 共 4 個符號）。
   * baseline：硬判決，len ^ ~len 必須等於 255。
   * 軟判決（erasure 選項）：硬判決不合法時，在所有合法長度中找「只差 1 個符號」者，
   * 以期望頻道的正規化功率（對數似然）排序取最可能的長度；此時 body 解碼改用較嚴格的 RS 餘量。
   * @param dec 符號判定（index 4～7 為 header）
   * @param syms 符號功率
   * @returns payload 長度；0 表示失敗
   */
  private decodeHeader(dec: (SymbolDecision | null)[], syms: Float64Array[]): number {
    const nib = [4, 5, 6, 7].map((j) => dec[j]!.value);
    const len = (nib[0] << 4) | nib[1];
    const nl = (nib[2] << 4) | nib[3];
    this.lastHeaderSoft = false;
    if ((len ^ nl) === 255 && len >= 1 && len <= this.cfg.maxLen) return len;
    if (!this.opts.erasure) return 0;
    const norm = [4, 5, 6, 7].map((j) => normalizePowers(syms[j].subarray(DATA_BASE)));
    let best = 0;
    let bestScore = -Infinity;
    for (let L = 1; L <= this.cfg.maxLen; L++) {
      const want = [L >> 4, L & 15, (~L & 0xff) >> 4, ~L & 15];
      let mism = 0;
      let score = 0;
      for (let i = 0; i < 4; i++) {
        if (want[i] !== nib[i]) mism++;
        score += Math.log(norm[i][want[i]] + 1e-9);
      }
      if (mism <= 1 && score > bestScore) {
        bestScore = score;
        best = L;
      }
    }
    this.lastHeaderSoft = best > 0;
    return best;
  }

  private headerFailed(d: Demod): void {
    this.stats.fail++;
    this.onEvent({ ok: false, error: 'header 不合法', stage: 'header', cfg: this.cfg, start: d.p });
    if (this.opts.combining) this.registerFailure(d, null, false);
    this.reset(d.p + 4 * this.N);
  }

  // ---------------- 重送合併 ----------------

  /**
   * 登記失敗封包：與暫存區中的候選配對成合併工作，並讓它在背景繼續解調（之後可能和下一次傳送合併）。
   */
  private registerFailure(d: Demod, len: number | null, lenSoft: boolean): void {
    const N = this.cfg.nsym;
    for (const e of this.store.candidates(d.p)) {
      if (this.jobs.length >= NOISE.combineMaxJobs) break;
      let L: number;
      let reserve: number = NOISE.erasureReserve;
      if (len !== null && e.len !== null) {
        if (len !== e.len) continue;
        L = len;
        if (!lenSoft && !e.lenSoft) reserve = 0;
      } else {
        // 至少一次 header 壞掉：兩次 header 功率相加後再判定
        const hs = combineSymbols(
          d.syms.slice(4, 8).map((P) => normalizePowers(P.subarray(DATA_BASE))),
          e.d.syms.slice(4, 8).map((P) => normalizePowers(P.subarray(DATA_BASE))),
        );
        const fake: Float64Array[] = [
          new Float64Array(0),
          new Float64Array(0),
          new Float64Array(0),
          new Float64Array(0),
        ];
        const decs: (SymbolDecision | null)[] = [null, null, null, null];
        for (const h of hs) {
          const P = new Float64Array(NT);
          P.set(h, DATA_BASE);
          fake.push(P);
          decs.push(this.detector.decide(h));
        }
        L = this.decodeHeader(decs, fake);
        if (!L && len !== null) L = len;
        if (!L && e.len !== null) L = e.len;
        if (!L) continue;
      }
      const S = HEADER_SYMBOLS + 2 * (L + N);
      if (e.d.target < S) e.d.target = S;
      if (e.d.syms.length < S && !this.background.includes(e.d)) this.background.push(e.d);
      this.jobs.push({ cur: d, other: e.d, len: L, reserve });
    }
    d.target = len !== null ? HEADER_SYMBOLS + 2 * (len + N) : this.maxSymbols;
    for (const j of this.jobs)
      if (j.cur === d) d.target = Math.max(d.target, HEADER_SYMBOLS + 2 * (j.len + N));
    if (!this.background.includes(d)) this.background.push(d);
    this.store.put({ d, len, lenSoft, quality: d.quality } satisfies FailedEntry<Demod>);
  }

  /** 背景解調失敗封包（樣本到了就算），並執行已就緒的合併工作 */
  private runBackground(): void {
    if (!this.background.length && !this.jobs.length) return;
    for (const d of this.background) while (d.syms.length < d.target && this.ready(d)) this.demodNext(d, -1);
    this.background = this.background.filter((d) => d.syms.length < d.target);
    if (!this.jobs.length) return;
    const left: CombineJob[] = [];
    for (const job of this.jobs) {
      const S = HEADER_SYMBOLS + 2 * (job.len + this.cfg.nsym);
      if (job.cur.syms.length < S || job.other.syms.length < S) {
        // 等不到樣本（緩衝區已覆蓋或目標不足）就放棄
        if (this.buffer.total - job.cur.p < this.buffer.cap * 0.9) left.push(job);
        continue;
      }
      const a = this.bodySymbols(job.cur, S).map(normalizePowers);
      const b = this.bodySymbols(job.other, S).map(normalizePowers);
      const r = this.tryRs(combineSymbols(a, b), job.reserve);
      if (r) {
        this.store.remove(job.cur);
        this.store.remove(job.other);
        // 同一對封包的其他工作取消
        const done = new Set([job.cur, job.other]);
        this.jobs = this.jobs.filter((j) => j !== job && !done.has(j.cur) && !done.has(j.other));
        this.emit(job.cur, S, r, true);
        return;
      }
    }
    this.jobs = left;
  }

  /** 取出 RS 碼字部分每個符號的 16 個資料頻道功率（可選擇白化） */
  private bodySymbols(d: Demod, S: number): Float64Array[] {
    const data = d.syms.slice(PREAMBLE.length, S).map((P) => P.slice(DATA_BASE));
    if (this.opts.whitening) whiten(data);
    return data.slice(HEADER_SYMBOLS - PREAMBLE.length);
  }

  /**
   * 判定符號並 RS 解碼；失敗時（開啟抹除時）以信心最低的位元組作為抹除再試。
   * @param reserve 一般解碼的偵錯餘量
   */
  private tryRs(symbols: Float64Array[], reserve: number): RsDecodeResult | null {
    const nsym = this.cfg.nsym;
    const decs = symbols.map((p) => this.detector.decide(p));
    const bytes: number[] = [];
    const conf: number[] = [];
    for (let i = 0; i + 1 < decs.length; i += 2) {
      bytes.push((decs[i].value << 4) | decs[i + 1].value);
      conf.push(Math.min(decs[i].confidence, decs[i + 1].confidence));
    }
    try {
      return rsDecode(bytes, nsym, { reserve });
    } catch (e) {
      if (!(e instanceof RsError)) throw e;
    }
    if (this.opts.erasure) {
      const res = Math.max(reserve, NOISE.erasureReserve);
      const order = conf.map((c, i) => [c, i] as const).sort((x, y) => x[0] - y[0]);
      for (const f of NOISE.erasureSteps) {
        if (f > nsym - res) break;
        const erasures = order.slice(0, f).map((x) => x[1]);
        try {
          return rsDecode(bytes, nsym, { erasures, reserve: res });
        } catch (e) {
          if (!(e instanceof RsError)) throw e;
        }
      }
    }
    return null;
  }

  private finishBody(d: Demod): void {
    const S = this.S;
    // header 是靠軟判決猜出來的：保留偵錯餘量，避免把雜訊「修」成假訊息
    const reserve = this.lenSoft ? NOISE.erasureReserve : 0;
    const r = this.tryRs(this.bodySymbols(d, S), reserve);
    if (r) {
      if (this.opts.combining) {
        // 成功了：暫存的失敗封包多半是同一則廣播的前一次傳送，不必再合併
        this.store.clear();
        this.jobs = [];
      }
      this.emit(d, S, r, false);
    } else {
      this.stats.fail++;
      this.onEvent({ ok: false, error: 'RS 無法修正', stage: 'body', cfg: this.cfg, start: d.p });
      if (this.opts.combining) this.registerFailure(d, this.len, this.lenSoft);
    }
    this.reset(Math.round(d.pos));
  }

  private emit(d: Demod, S: number, r: RsDecodeResult, combined: boolean): void {
    // 訊號品質：所有資料符號中，判定頻道功率占 18 頻道總功率的平均
    let q = 0;
    let n = 0;
    for (let j = PREAMBLE.length; j < S && j < d.syms.length; j++) {
      const P = d.syms[j];
      let sum = 1e-12;
      let mx = 0;
      for (let i = 0; i < NT; i++) {
        sum += P[i];
        if (i >= DATA_BASE && P[i] > mx) mx = P[i];
      }
      q += mx / sum;
      n++;
    }
    this.stats.ok++;
    if (combined) this.stats.combined++;
    const off = (d.alpha - 1) * this.fRef;
    if (this.table) {
      // UI 的頻道功率顯示跟隨最近一次的頻偏
      const offs = this.table.offsets;
      let bi = 0;
      for (let i = 1; i < offs.length; i++) if (Math.abs(offs[i] - off) < Math.abs(offs[bi] - off)) bi = i;
      this.lastOffsetIdx = bi;
    }
    this.onEvent({
      ok: true,
      payload: Uint8Array.from(r.data),
      fixed: r.fixed,
      erasures: r.erasures,
      quality: n ? q / n : 0,
      combined,
      offsetHz: off,
      score: d.score,
      cfg: this.cfg,
      start: d.p,
      end: Math.round(d.p + (S * this.N) / (this.opts.doppler ? d.alpha : 1)),
    });
  }

  private reset(until: number): void {
    this.state = 'search';
    this.quietUntil = until;
    this.hist = { a: [], b: [], za: [], zb: [] };
    this.demod = null;
  }
}

/**
 * 封包內頻道白化：以「該頻道在整個封包中功率的低百分位數」估計各頻道的背景（噪音＋持續性干擾），
 * 再把功率除以背景。資料音只在約 1/16 的符號出現，所以低百分位數幾乎不受訊號影響；
 * 某個頻率附近若有設備的持續性窄頻雜音，它的背景值會很高，因而被壓下來。
 */
export function whiten(data: Float64Array[], _detector?: SymbolDetector): void {
  if (data.length < 8) return;
  const nCh = data[0].length;
  const bg = new Float64Array(nCh);
  const q = Math.floor(data.length * NOISE.whitenPercentile);
  let floor = Infinity;
  const vals = new Float64Array(data.length);
  for (let i = 0; i < nCh; i++) {
    for (let j = 0; j < data.length; j++) vals[j] = data[j][i];
    vals.sort();
    bg[i] = vals[q];
    if (bg[i] > 0) floor = Math.min(floor, bg[i]);
  }
  if (!isFinite(floor)) return;
  // 扣除各頻道高出噪音底的背景（持續性干擾），而不是相除：
  // 相除會把「訊號剛好落在干擾頻道」的符號壓得太低，實測反而變差（見 docs/benchmarks.md）
  for (const p of data) for (let i = 0; i < nCh; i++) p[i] = Math.max(p[i] - (bg[i] - floor), floor * 0.01);
}
