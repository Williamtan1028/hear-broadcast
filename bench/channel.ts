/**
 * 通道模擬（移植自 PoC 的 channel()，並加上高頻衰減、都卜勒、窄頻干擾）。
 * 所有隨機數都來自可指定種子的 PRNG，測試結果可重現。
 */
import { biquadLowpass } from '../src/modem/dsp.ts';
import { DOPPLER } from '../src/modem/config.ts';

/** mulberry32：簡單、快速、可重現的 32-bit PRNG */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

/** 標準常態分布（Box-Muller） */
export function gauss(rng: Rng): number {
  let u = 0;
  while (!u) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface ChannelOptions {
  /** 訊號增益（喇叭到手機的衰減） */
  gain: number;
  /** 白噪音標準差 */
  noise: number;
  /** 回音強度 */
  rev: number;
  /** 回音長度（秒） */
  rt: number;
  /** 高頻衰減：發送訊號先經過兩級 Butterworth 低通（fc = 19 kHz） */
  hfLoss?: boolean;
  /**
   * 都卜勒：徑向速度（m/s，靠近為正）。可為常數或時間函數 v(t)（t 為秒，從封包開始算）。
   */
  velocity?: number | ((t: number) => number);
  /** 窄頻干擾：[頻率 Hz, 振幅]（模擬設備的高頻嘯叫，用於頻道白化評估） */
  tones?: [number, number][];
  /** 前置靜音（秒）；不給就隨機 0.3～1.3 秒 */
  lead?: number;
  /** 是否加入 300 Hz 低頻干擾（PoC 預設有） */
  lowHum?: boolean;
  /**
   * 多路徑各自的都卜勒（移動造成的衰落）：每條反射路徑有隨機入射角 θ，手機移動時
   * 反射路徑長度的變化是直達路徑的 cos θ 倍。20 kHz 波長只有 1.7 cm，移動幾公釐
   * 直達與反射的相位關係就改變，形成符號內的振幅起伏與相位反轉（駐波節點）。
   * 不給或 false 時所有路徑共用同一個都卜勒（舊模型，數字與之前相同）。
   */
  multipathMotion?: boolean;
}

/** 線性內插重新取樣（PoC 相同的做法），pos(i) 給出輸出第 i 點在輸入中的位置 */
function warp(x: Float32Array, n: number, pos: (i: number) => number): Float32Array {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = pos(i);
    const a = Math.floor(s);
    const f = s - a;
    o[i] = (x[a] || 0) * (1 - f) + (x[a + 1] || 0) * f;
  }
  return o;
}

/**
 * 依取樣率與都卜勒伸縮重新取樣。
 * r(t) = s(τ(t))，τ(t) = ∫ α(u) du，α = 1 + v/c。
 */
export function resampleDoppler(
  x: Float32Array,
  fsTx: number,
  fsRx: number,
  velocity: number | ((t: number) => number) = 0,
): Float32Array {
  const r = fsRx / fsTx;
  if (typeof velocity === 'number') {
    const alpha = 1 + velocity / DOPPLER.soundSpeed;
    if (r === 1 && alpha === 1) return x;
    const n = Math.floor((x.length * r) / alpha);
    return warp(x, n, (i) => (i / r) * alpha);
  }
  // 時變速度：逐點積分 τ
  const n = Math.floor((x.length * r) / (1 + 2 / DOPPLER.soundSpeed));
  const taus = new Float64Array(n);
  let tau = 0;
  for (let i = 0; i < n; i++) {
    taus[i] = tau;
    tau += (1 + velocity(i / fsRx) / DOPPLER.soundSpeed) / r;
  }
  let m = n;
  while (m > 0 && taus[m - 1] >= x.length - 1) m--;
  return warp(x, m, (i) => taus[i]);
}

/**
 * 模擬喇叭 → 空氣 → 手機麥克風。
 * 隨機前置靜音、直達＋300 個稀疏反射（指數衰減）、白噪音、300 Hz 低頻干擾、取樣率轉換。
 */
export function channel(
  sig: Float32Array,
  fsTx: number,
  fsRx: number,
  o: ChannelOptions,
  rng: Rng,
): Float32Array {
  let s = sig;
  if (o.hfLoss) {
    const f1 = biquadLowpass(fsTx, 19000);
    const f2 = biquadLowpass(fsTx, 19000);
    s = s.map((v) => f2(f1(v)));
  }
  const x = resampleDoppler(s, fsTx, fsRx, o.velocity ?? 0);
  // 手機沿直達路徑的累積位移（公尺），用來計算各反射路徑相對直達路徑的延遲變化
  const disp = o.multipathMotion && o.velocity ? displacement(o.velocity, x.length, fsRx) : null;
  const lead = Math.round(fsRx * (o.lead ?? 0.3 + rng()));
  const tail = Math.round(fsRx * 0.5);
  const y = new Float32Array(lead + x.length + tail + Math.round(fsRx * o.rt));
  const taps: [number, number][] = [[0, 1]];
  for (let i = 0; i < 300; i++) {
    const d = rng() * o.rt;
    taps.push([
      Math.round((0.003 + d) * fsRx),
      (o.rev * gauss(rng) * Math.exp((-6.9 * d) / o.rt)) / Math.sqrt(30),
    ]);
  }
  for (let k = 0; k < taps.length; k++) {
    const [d, g] = taps[k];
    if (g === 0) continue;
    const gg = g * o.gain;
    const off = lead + d;
    if (!disp || k === 0) {
      for (let i = 0; i < x.length; i++) y[off + i] += x[i] * gg;
      continue;
    }
    // 反射路徑：入射角 θ 隨機，相對直達路徑多出 disp × (1 − cos θ) / c 的延遲
    const scale = ((1 - Math.cos(rng() * Math.PI)) * fsRx) / DOPPLER.soundSpeed;
    for (let i = 0; i < x.length; i++) {
      const pos = i - disp[i] * scale;
      const a = Math.floor(pos);
      if (a < 0 || a + 1 >= x.length) continue;
      const f = pos - a;
      y[off + i] += (x[a] * (1 - f) + x[a + 1] * f) * gg;
    }
  }
  const hum = o.lowHum ?? true;
  for (let i = 0; i < y.length; i++) {
    y[i] += o.noise * gauss(rng);
    if (hum)
      y[i] += 0.3 * Math.sin((2 * Math.PI * 300 * i) / fsRx) * Math.sin((2 * Math.PI * 1.3 * i) / fsRx);
  }
  if (o.tones) {
    for (const [f, a] of o.tones) {
      const ph = rng() * 2 * Math.PI;
      for (let i = 0; i < y.length; i++) y[i] += a * Math.sin((2 * Math.PI * f * i) / fsRx + ph);
    }
  }
  return y;
}

/** 速度 v(t) 積分得到每個樣本時的累積位移（公尺） */
function displacement(velocity: number | ((t: number) => number), n: number, fs: number): Float64Array {
  const p = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    p[i] = acc;
    acc += (typeof velocity === 'number' ? velocity : velocity(i / fs)) / fs;
  }
  return p;
}

/** 標準情境（第 8 節） */
export const SCENARIOS = {
  quiet: { gain: 0.05, noise: 0.002, rev: 0, rt: 0.05 },
  medium: { gain: 0.05, noise: 0.02, rev: 0.5, rt: 0.4 },
  strong: { gain: 0.05, noise: 0.05, rev: 0.7, rt: 0.8 },
  extreme: { gain: 0.05, noise: 0.1, rev: 1.0, rt: 1.2 },
  hfQuiet: { gain: 0.05, noise: 0.002, rev: 0, rt: 0.05, hfLoss: true },
  hfMedium: { gain: 0.05, noise: 0.02, rev: 0.5, rt: 0.4, hfLoss: true },
  hfStrong: { gain: 0.05, noise: 0.05, rev: 0.7, rt: 0.8, hfLoss: true },
} satisfies Record<string, ChannelOptions>;

export type ScenarioName = keyof typeof SCENARIOS;

export const SCENARIO_LABELS: Record<ScenarioName, string> = {
  quiet: '安靜',
  medium: '中等（噪音 0.02、回音 0.4 s）',
  strong: '強（噪音 0.05、回音 0.8 s）',
  extreme: '極強（噪音 0.1、回音 1.2 s）',
  hfQuiet: '高頻衰減＋安靜',
  hfMedium: '高頻衰減＋中等',
  hfStrong: '高頻衰減＋強',
};

/**
 * 手持微動：站著拿手機，手的晃動約 ±0.05～0.15 m/s、週期 0.8～2 秒。
 * 一個符號（60 ms）內移動數公釐，接近 20 kHz 的半個波長，足以讓多路徑相位反轉。
 */
export function handJitter(rng: Rng): (t: number) => number {
  const a1 = 0.05 + 0.1 * rng();
  const a2 = 0.03 + 0.05 * rng();
  const p1 = 0.8 + 1.2 * rng();
  const p2 = 0.3 + 0.4 * rng();
  const ph1 = rng() * 2 * Math.PI;
  const ph2 = rng() * 2 * Math.PI;
  return (t: number) =>
    a1 * Math.sin((2 * Math.PI * t) / p1 + ph1) + a2 * Math.sin((2 * Math.PI * t) / p2 + ph2);
}

/** 走路情境：速度在 0.5～1.5 m/s 之間緩慢變化（週期約 3～5 秒），方向隨機 */
export function walkingVelocity(rng: Rng): (t: number) => number {
  const sign = rng() < 0.5 ? -1 : 1;
  const period = 3 + 2 * rng();
  const ph = rng() * 2 * Math.PI;
  return (t: number) => sign * (1 + 0.5 * Math.sin((2 * Math.PI * t) / period + ph));
}
