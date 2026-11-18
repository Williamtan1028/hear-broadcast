/**
 * 單次傳輸試驗：產生隨機 payload → 調變 → 通道 → 接收，回傳是否正確解碼。
 * 測試（tests/）與基準評估（bench/）共用。
 */
import { AutoReceiver } from '../src/modem/autoReceiver.ts';
import { CANDIDATES, DEFAULTS, type ModemConfig, type RxOptions } from '../src/modem/config.ts';
import { synthesize } from '../src/modem/fsk.ts';
import { Receiver, type RxMessage } from '../src/modem/receiver.ts';
import { channel, type ChannelOptions, type Rng } from './channel.ts';

export interface TrialSpec {
  cfg?: ModemConfig;
  ch: ChannelOptions;
  opts: Partial<RxOptions>;
  rng: Rng;
  fsTx?: number;
  fsRx?: number;
  /** 發送振幅（第 8 節測試用 0.6） */
  amp?: number;
  /** payload 長度 */
  len?: number;
  /** 'manual' = 接收端已知設定；'auto' = AutoReceiver 自動偵測 */
  mode?: 'manual' | 'auto';
  /** 送幾次（重送合併評估用；兩次之間間隔 gapSec） */
  repeats?: number;
  gapSec?: number;
  chunk?: number;
}

export interface TrialResult {
  ok: boolean;
  /** 自動偵測時是否鎖定正確設定 */
  lockOk: boolean;
  msg: RxMessage | null;
  /** 收到的錯誤訊息數（解出內容與送出不同） */
  wrong: number;
}

export const randomPayload = (rng: Rng, len: number): Uint8Array =>
  Uint8Array.from({ length: len }, () => Math.floor(rng() * 256));

const eq = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 執行一次試驗 */
export function runTrial(spec: TrialSpec): TrialResult {
  const cfg = spec.cfg ?? DEFAULTS;
  const fsTx = spec.fsTx ?? 48000;
  const fsRx = spec.fsRx ?? 44100;
  const payload = randomPayload(spec.rng, spec.len ?? 8);
  const sig = synthesize(payload, cfg, fsTx, spec.amp ?? 0.6);
  const repeats = spec.repeats ?? 1;
  let y = channel(sig, fsTx, fsRx, spec.ch, spec.rng);
  if (repeats > 1) {
    // 每次重送使用獨立的通道實現：20 kHz 波長只有 1.7 cm，手持手機些微移動，多路徑的相位關係就完全不同
    const parts = [y];
    for (let r = 1; r < repeats; r++)
      parts.push(channel(sig, fsTx, fsRx, { ...spec.ch, lead: spec.gapSec ?? 1 }, spec.rng));
    const total = parts.reduce((s, p) => s + p.length, 0);
    y = new Float32Array(total);
    let off = 0;
    for (const p of parts) {
      y.set(p, off);
      off += p.length;
    }
  }
  let got: RxMessage | null = null;
  let wrong = 0;
  let lock: ModemConfig | null = null;
  const onEvent = (e: import('../src/modem/receiver.ts').RxEvent) => {
    if (!e.ok) return;
    if (eq(e.payload, payload)) got ??= e;
    else wrong++;
  };
  const chunk = spec.chunk ?? 2048;
  if ((spec.mode ?? 'manual') === 'manual') {
    const r = new Receiver(fsRx, { cfg, opts: spec.opts, onEvent });
    for (let i = 0; i < y.length; i += chunk) r.push(y.subarray(i, i + chunk));
  } else {
    const a = new AutoReceiver(fsRx, {
      opts: spec.opts,
      onEvent,
      onLock: (c) => {
        if (c) lock = c;
      },
    });
    for (let i = 0; i < y.length; i += chunk) a.push(y.subarray(i, i + chunk));
  }
  const l = lock as ModemConfig | null;
  return { ok: !!got, lockOk: !!l && l.f0 === cfg.f0 && l.ts === cfg.ts, msg: got, wrong };
}

/** 執行 n 次試驗並統計成功數 */
export function runTrials(
  n: number,
  mk: (i: number) => TrialSpec,
): { ok: number; lock: number; wrong: number; n: number } {
  let ok = 0;
  let lock = 0;
  let wrong = 0;
  for (let i = 0; i < n; i++) {
    const r = runTrial(mk(i));
    if (r.ok) ok++;
    if (r.lockOk) lock++;
    wrong += r.wrong;
  }
  return { ok, lock, wrong, n };
}

/** 自動偵測輪流使用的 8 組設定 */
export const candidateAt = (i: number): ModemConfig => CANDIDATES[i % CANDIDATES.length];
