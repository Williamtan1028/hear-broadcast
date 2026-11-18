/**
 * 主執行緒 ↔ DSP Worker 的訊息格式。
 */
import type { ModemConfig, RxOptions } from '../modem/config.ts';

/** 接收模式：自動偵測，或手動指定頻段與模式 */
export type RxMode = { kind: 'auto' } | { kind: 'manual'; cfg: ModemConfig };

export type ToWorker =
  | { type: 'init'; fs: number; mode: RxMode; opts?: Partial<RxOptions> }
  | { type: 'samples'; data: Float32Array }
  | { type: 'features'; on: boolean }
  | { type: 'dumpFeatures' };

/** 可在執行緒間傳遞的解碼結果 */
export interface WorkerMessage {
  ok: true;
  payload: number[];
  fixed: number;
  erasures: number;
  quality: number;
  combined: boolean;
  offsetHz: number;
  score: number;
  cfg: ModemConfig;
  /** 接收端時間（秒，從開始接收算起） */
  at: number;
}

export interface WorkerFailure {
  ok: false;
  error: string;
  stage: 'header' | 'body';
  cfg: ModemConfig;
  at: number;
}

/** 診斷與未來訓練用的頻道特徵（不含原始音訊） */
export interface FeatureRow {
  /** 時間（秒） */
  t: number;
  score: number;
  offsetHz: number;
  /** 18 頻道功率（dB） */
  powersDb: number[] | null;
}

export interface LevelInfo {
  score: number;
  /** 18 頻道功率（dB），掃描中為 null */
  powersDb: number[] | null;
  offsetHz: number;
  locked: ModemConfig | null;
  stats: { ok: number; fail: number; combined: number };
  /** 每秒處理的 hop 數（效能監控） */
  seconds: number;
}

export type FromWorker =
  | { type: 'event'; event: WorkerMessage | WorkerFailure }
  | { type: 'level'; level: LevelInfo }
  | { type: 'lock'; cfg: ModemConfig | null }
  | { type: 'features'; rows: FeatureRow[]; decoded: (WorkerMessage | WorkerFailure)[] }
  | { type: 'error'; message: string };
