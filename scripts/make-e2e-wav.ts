/**
 * 產生 E2E 測試用的 WAV（當作 Chrome 的假麥克風輸入）：
 *   A：第 1 月台「列車即將進站」（強訊號，模擬手機靠近第 1 月台喇叭）
 *   B：第 2 月台「列車延誤」（弱訊號，模擬遠處第 2 月台的喇叭）
 *   C：全站緊急疏散（往 2 號出口）
 * 背景加上白噪音（σ = 0.01），讓遠處月台的訊號品質明顯較低。輸出 e2e/fixtures/broadcast.wav（48 kHz 單聲道 16-bit）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeRng, gauss } from '../bench/channel.ts';
import { encodeWav } from '../src/audio/signals.ts';
import { DEFAULTS } from '../src/modem/config.ts';
import { synthesize } from '../src/modem/fsk.ts';
import { encodeMessage, type Message } from '../src/modem/protocol.ts';

export const E2E_MESSAGES: { msg: Message; amp: number }[] = [
  {
    msg: {
      type: 'template',
      stationId: 1,
      platform: 1,
      seq: 11,
      packVersion: 1,
      templateId: 3,
      p1: 0,
      p2: 0,
    },
    amp: 0.3,
  },
  {
    msg: {
      type: 'template',
      stationId: 1,
      platform: 2,
      seq: 12,
      packVersion: 1,
      templateId: 1,
      p1: 7,
      p2: 10,
    },
    amp: 0.006,
  },
  {
    msg: {
      type: 'template',
      stationId: 1,
      platform: 0,
      seq: 13,
      packVersion: 1,
      templateId: 10,
      p1: 2,
      p2: 0,
    },
    amp: 0.3,
  },
];

export function makeE2eWav(): Uint8Array {
  const fs = 48000;
  const parts: Float32Array[] = [new Float32Array(fs)];
  for (const { msg, amp } of E2E_MESSAGES) {
    parts.push(synthesize(encodeMessage(msg), DEFAULTS, fs, amp));
    parts.push(new Float32Array(Math.round(fs * 1.5)));
  }
  parts.push(new Float32Array(fs * 2));
  const n = parts.reduce((s, p) => s + p.length, 0);
  const x = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    x.set(p, o);
    o += p.length;
  }
  const rng = makeRng(2024);
  // 背景噪音要夠明顯，遠處月台的弱訊號品質才會穩定低於近處月台（無噪音時兩者品質幾乎相同，判斷會因機器而異）
  for (let i = 0; i < n; i++) x[i] += 0.01 * gauss(rng);
  return encodeWav([x], fs);
}

if (process.argv[1]?.endsWith('make-e2e-wav.ts')) {
  mkdirSync('e2e/fixtures', { recursive: true });
  writeFileSync('e2e/fixtures/broadcast.wav', makeE2eWav());
  console.log('已產生 e2e/fixtures/broadcast.wav');
}
