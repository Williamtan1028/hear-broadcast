/**
 * 調變（發送端）：連續相位 FSK。
 *
 * 封包格式（符號序列）：
 *   前導碼 A B A B ｜ len ｜ (~len)&0xFF ｜ RS(payload, nsym)
 * 每個位元組拆成高 4 bits、低 4 bits 兩個符號，資料音 index = 2 + nibble。
 */
import { DATA_BASE, NT, PREAMBLE, SYNTH, type ModemConfig } from './config.ts';
import { rsEncode } from './rs.ts';

/** 18 個頻道的頻率（Hz） */
export const channelFreqs = (c: ModemConfig): number[] =>
  Array.from({ length: NT }, (_, i) => c.f0 + i * c.df);

/** 符號長度（樣本數） */
export const symbolSamples = (c: ModemConfig, fs: number): number => Math.round(c.ts * fs);

/**
 * 把 payload 組成符號序列（前導碼＋長度＋反相長度＋RS 碼字）。
 * @param payload 1～maxLen 位元組
 */
export function frameSymbols(payload: ArrayLike<number>, c: ModemConfig): number[] {
  if (payload.length < 1 || payload.length > c.maxLen) throw new Error(`payload 長度必須是 1～${c.maxLen}`);
  const bytes = [payload.length, ~payload.length & 0xff, ...rsEncode(payload, c.nsym)];
  const sym = PREAMBLE.slice();
  for (const b of bytes) sym.push(DATA_BASE + (b >> 4), DATA_BASE + (b & 15));
  return sym;
}

/** payload 長度對應的符號總數 */
export const packetSymbols = (len: number, c: ModemConfig): number =>
  PREAMBLE.length + 2 * (2 + len + c.nsym);

/** 封包播放秒數（含前後延長音與靜音） */
export const packetDuration = (len: number, c: ModemConfig): number =>
  packetSymbols(len, c) * c.ts + 2 * (SYNTH.edge + SYNTH.pad);

/**
 * 產生柔和版音訊。
 *  1. 連續相位：切換頻率時相位不跳，避免寬頻雜音。
 *  2. 每個符號前 15% 以升餘弦曲線從前一個頻率滑到新頻率（接收端只看符號 20%～95%，不受影響）。
 *  3. 封包前後各 100 ms 延長音，在延長音內升餘弦淡入／淡出；再前後各留 30 ms 靜音。
 * 這樣落在 16 kHz 以下的洩漏能量比瞬間切換低約 60 dB。
 * @param payload 封包內容
 * @param c 調變設定
 * @param fs 取樣率
 * @param amp 振幅（0～SYNTH.maxAmp）
 */
export function synthesize(
  payload: ArrayLike<number>,
  c: ModemConfig,
  fs: number,
  amp: number = SYNTH.defaultAmp,
): Float32Array {
  return synthesizeSymbols(frameSymbols(payload, c), c, fs, amp);
}

/** 由符號序列產生柔和版音訊（見 synthesize） */
export function synthesizeSymbols(sym: number[], c: ModemConfig, fs: number, amp: number): Float32Array {
  const F = channelFreqs(c);
  const N = symbolSamples(c, fs);
  const E = Math.round(SYNTH.edge * fs);
  const G = Math.max(1, Math.round(SYNTH.glide * N));
  const pad = Math.round(SYNTH.pad * fs);
  const total = pad * 2 + E * 2 + N * sym.length;
  const out = new Float32Array(total);
  let ph = 0;
  let k = pad;
  let prev = F[sym[0]];
  const tone = (f: number, n: number, env: (i: number) => number) => {
    const w = (2 * Math.PI * f) / fs;
    for (let i = 0; i < n; i++) {
      out[k++] = Math.sin(ph) * env(i) * amp;
      ph += w;
    }
  };
  tone(prev, E, (i) => 0.5 - 0.5 * Math.cos((Math.PI * i) / E)); // 淡入
  for (const s of sym) {
    const f1 = F[s];
    for (let i = 0; i < N; i++) {
      const f = i < G ? prev + (f1 - prev) * (0.5 - 0.5 * Math.cos((Math.PI * i) / G)) : f1;
      out[k++] = Math.sin(ph) * amp;
      ph += (2 * Math.PI * f) / fs;
    }
    ph %= 2 * Math.PI;
    prev = f1;
  }
  tone(prev, E, (i) => 0.5 + 0.5 * Math.cos((Math.PI * i) / E)); // 淡出
  return out;
}

/**
 * 舊版波形（頻率瞬間切換、20 ms 淡入淡出），只保留給洩漏檢查的反向測試與比較用。
 * 這種波形會有可聽見的喀喀聲。
 */
export function synthesizeHard(
  payload: ArrayLike<number>,
  c: ModemConfig,
  fs: number,
  amp = 0.6,
): Float32Array {
  const sym = frameSymbols(payload, c);
  const F = channelFreqs(c);
  const N = symbolSamples(c, fs);
  const ramp = Math.round(0.02 * fs);
  const pad = Math.round(0.05 * fs);
  const out = new Float32Array(pad * 2 + N * sym.length);
  let ph = 0;
  let k = pad;
  for (const s of sym) {
    const w = (2 * Math.PI * F[s]) / fs;
    for (let i = 0; i < N; i++) {
      out[k++] = Math.sin(ph);
      ph += w;
    }
    ph %= 2 * Math.PI;
  }
  const a = pad;
  const b = pad + N * sym.length;
  for (let i = a; i < b; i++) {
    let g = 1;
    if (i - a < ramp) g = 0.5 - 0.5 * Math.cos((Math.PI * (i - a)) / ramp);
    else if (b - i < ramp) g = 0.5 - 0.5 * Math.cos((Math.PI * (b - i)) / ramp);
    out[i] *= g * amp;
  }
  return out;
}

/**
 * 「瞬間切換、沒有淡入淡出」的訊號，給洩漏檢查的反向測試（應判定不合格）。
 */
export function synthesizeAbrupt(
  payload: ArrayLike<number>,
  c: ModemConfig,
  fs: number,
  amp = 0.3,
): Float32Array {
  const sym = frameSymbols(payload, c);
  const F = channelFreqs(c);
  const N = symbolSamples(c, fs);
  const out = new Float32Array(N * sym.length);
  let k = 0;
  for (const s of sym) {
    const w = (2 * Math.PI * F[s]) / fs;
    for (let i = 0; i < N; i++) out[k++] = Math.sin(w * i) * amp; // 相位不連續
  }
  return out;
}
