/**
 * 對照組：ggwave 超音波模式（devDependency，只用在比較測試，不是本系統的依賴）。
 * 同一個通道模擬、相同峰值振幅（0.6）、相同噪音，比較成功率、速度、洩漏與都卜勒容忍度。
 */
import { createRequire } from 'node:module';
import { channel, type ChannelOptions, type Rng } from './channel.ts';

const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any */
type GG = any;

let gg: GG | null = null;
/** 載入 ggwave WASM 模組（只載入一次） */
export async function loadGgwave(): Promise<GG> {
  if (!gg) {
    const factory = require('ggwave');
    gg = await factory();
    gg.disableLog();
  }
  return gg;
}

export const GG_PROTOCOLS = ['ULTRASOUND_NORMAL', 'ULTRASOUND_FAST', 'ULTRASOUND_FASTEST'] as const;
export type GgProtocol = (typeof GG_PROTOCOLS)[number];

const toBytes = (x: Float32Array) => new Int8Array(x.buffer, x.byteOffset, x.byteLength);

/** 用 ggwave 產生音訊（48 kHz），並把峰值調到 amp */
export function ggEncode(g: GG, payload: string, protocol: GgProtocol, amp: number): Float32Array {
  const p = g.getDefaultParameters();
  p.sampleRateOut = 48000;
  const inst = g.init(p);
  try {
    const res = g.encode(inst, payload, g.ProtocolId['GGWAVE_PROTOCOL_' + protocol], 25);
    const raw = new Float32Array(res.buffer, res.byteOffset, res.byteLength / 4);
    let peak = 0;
    for (const v of raw) peak = Math.max(peak, Math.abs(v));
    return Float32Array.from(raw, (v) => (v / peak) * amp);
  } finally {
    g.free(inst);
  }
}

/** 用 ggwave 串流解碼，回傳解出的字串（失敗為 null） */
export function ggDecode(g: GG, y: Float32Array, fsRx: number): string | null {
  const p = g.getDefaultParameters();
  p.sampleRateInp = fsRx;
  const inst = g.init(p);
  try {
    const frame = 1024;
    for (let i = 0; i < y.length; i += frame) {
      const chunk = Float32Array.from(y.subarray(i, i + frame));
      const r = g.decode(inst, toBytes(chunk));
      if (r && r.length > 0) return new TextDecoder().decode(r);
    }
    return null;
  } finally {
    g.free(inst);
  }
}

/** 隨機可列印字元 payload（ggwave 的 JS 介面以字串傳入） */
export const randomText = (rng: Rng, len: number) =>
  String.fromCharCode(...Array.from({ length: len }, () => 33 + Math.floor(rng() * 94)));

/** 一次 ggwave 試驗 */
export function ggTrial(g: GG, protocol: GgProtocol, ch: ChannelOptions, rng: Rng, fsRx = 44100): boolean {
  const text = randomText(rng, 8);
  const sig = ggEncode(g, text, protocol, 0.6);
  const y = channel(sig, 48000, fsRx, ch, rng);
  return ggDecode(g, y, fsRx) === text;
}
