/**
 * DSP Web Worker：所有 Goertzel／FFT／解調都在這裡執行，不佔用主執行緒（介面不會卡）。
 */
import { AutoReceiver } from '../modem/autoReceiver.ts';
import { DEFAULT_OPTIONS } from '../modem/config.ts';
import { decodeMessage } from '../modem/protocol.ts';
import type { FeatureRow, FromWorker, ToWorker, WorkerFailure, WorkerMessage } from './protocol.ts';

// Worker 全域範圍（app 的 tsconfig 使用 DOM lib，這裡只宣告用到的部分）
declare const self: {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

let rx: AutoReceiver | null = null;
let fs = 48000;
let lastLevel = 0;
let featuresOn = false;
const MAX_ROWS = 20_000;
let rows: FeatureRow[] = [];
let decoded: (WorkerMessage | WorkerFailure)[] = [];
let level = { score: 0, powers: null as Float64Array | null, offsetHz: 0 };

const post = (m: FromWorker) => self.postMessage(m);
const toDb = (p: Float64Array | null) =>
  p ? Array.from(p, (v) => Math.round(10 * Math.log10(v + 1e-12) * 10) / 10) : null;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        fs = m.fs;
        rows = [];
        decoded = [];
        rx = new AutoReceiver(fs, {
          opts: { ...DEFAULT_OPTIONS, ...m.opts },
          manual: m.mode.kind === 'manual' ? m.mode.cfg : undefined,
          // 只有合法的協定 v2 封包才算成功、才會鎖定頻段
          accept: (p) => {
            try {
              decodeMessage(p);
              return true;
            } catch {
              return false;
            }
          },
          onEvent: (ev) => {
            const at = rx ? rx.buffer.total / fs : 0;
            const event: WorkerMessage | WorkerFailure = ev.ok
              ? {
                  ok: true,
                  payload: Array.from(ev.payload),
                  fixed: ev.fixed,
                  erasures: ev.erasures,
                  quality: ev.quality,
                  combined: ev.combined,
                  offsetHz: ev.offsetHz,
                  score: ev.score,
                  cfg: ev.cfg,
                  at,
                }
              : { ok: false, error: ev.error, stage: ev.stage, cfg: ev.cfg, at };
            if (featuresOn) decoded.push(event);
            post({ type: 'event', event });
          },
          onHop: (h) => {
            level = { score: h.score, powers: h.powers, offsetHz: h.offsetHz };
            if (featuresOn && rows.length < MAX_ROWS)
              rows.push({ t: h.t / fs, score: h.score, offsetHz: h.offsetHz, powersDb: toDb(h.powers) });
          },
          onLock: (cfg) => post({ type: 'lock', cfg }),
        });
        lastLevel = 0;
        break;
      }
      case 'samples': {
        if (!rx) return;
        rx.push(m.data);
        // 約每 100 ms 回報一次狀態
        if (rx.buffer.total - lastLevel >= fs / 10) {
          lastLevel = rx.buffer.total;
          post({
            type: 'level',
            level: {
              score: level.score,
              powersDb: toDb(level.powers),
              offsetHz: level.offsetHz,
              locked: rx.locked,
              stats: { ...rx.stats },
              seconds: rx.buffer.total / fs,
            },
          });
        }
        break;
      }
      case 'features':
        featuresOn = m.on;
        if (m.on) {
          rows = [];
          decoded = [];
        }
        break;
      case 'dumpFeatures':
        post({ type: 'features', rows, decoded });
        break;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
