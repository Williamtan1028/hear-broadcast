/**
 * 數據機所有 DSP 參數集中在這裡，其他檔案不得寫死數值。
 *
 * 頻道配置：f(i) = f0 + i × df，i = 0..17
 *   i = 0 同步音 A、i = 1 同步音 B、i = 2..17 資料音（代表 0x0～0xF）。
 */

/** 一組調變設定 */
export interface ModemConfig {
  /** 第 0 個頻道（同步音 A）的頻率，Hz */
  f0: number;
  /** 頻道間距，Hz */
  df: number;
  /** 符號長度，秒 */
  ts: number;
  /** Reed-Solomon 檢查位元組數 */
  nsym: number;
  /** payload 最大長度（位元組） */
  maxLen: number;
}

/** 頻道總數 */
export const NT = 18;
/** 同步音 A、B 的頻道 index */
export const SYNC_A = 0;
export const SYNC_B = 1;
/** 資料音從第幾個頻道開始 */
export const DATA_BASE = 2;
/** 前導碼符號序列 */
export const PREAMBLE: readonly number[] = [SYNC_A, SYNC_B, SYNC_A, SYNC_B];
/** 前導碼 + len + ~len 的符號數 */
export const HEADER_SYMBOLS = PREAMBLE.length + 4;

/** 發送端波形參數 */
export const SYNTH = {
  /** 每個符號前多少比例的時間用升餘弦滑到新頻率（消除喀喀聲的關鍵） */
  glide: 0.15,
  /** 封包前後延長音的長度（秒），在其中淡入淡出 */
  edge: 0.1,
  /** 封包前後的靜音（秒） */
  pad: 0.03,
  /** 預設振幅 */
  defaultAmp: 0.3,
  /** 振幅上限（太大會讓喇叭失真、產生可聽雜音） */
  maxAmp: 0.8,
} as const;

/** 可選頻段（df 一律 50 Hz） */
export interface BandInfo {
  f0: number;
  /** 只能由站務人員手動選擇（可能被部分人聽見） */
  manualOnly: boolean;
  recommended: boolean;
}
export const BANDS: readonly BandInfo[] = [
  { f0: 19500, manualOnly: false, recommended: true },
  { f0: 19000, manualOnly: false, recommended: false },
  { f0: 18500, manualOnly: false, recommended: false },
  { f0: 18000, manualOnly: true, recommended: false },
];
/** 標記為「低頻段」的 f0（介面需加註警告） */
export const LOW_BAND_F0 = 18000;

/** 傳輸模式：符號長度（秒） */
export const MODES = { standard: 0.06, stable: 0.08 } as const;
export type ModeName = keyof typeof MODES;

/** 預設設定：19.5 kHz、50 Hz 間距、標準模式 */
export const DEFAULTS: ModemConfig = { f0: 19500, df: 50, ts: MODES.standard, nsym: 6, maxLen: 48 };

/** 自動偵測的候選設定：4 個頻段 × 2 種模式 */
export const CANDIDATES: readonly ModemConfig[] = BANDS.flatMap((b) =>
  Object.values(MODES).map((ts) => ({ ...DEFAULTS, f0: b.f0, ts })),
);

/** 依頻段與模式建立設定 */
export const makeConfig = (f0: number, mode: ModeName): ModemConfig => ({ ...DEFAULTS, f0, ts: MODES[mode] });

/** 接收端（PoC 驗證過的參數） */
export const RX = {
  /** hop = N / hopDiv */
  hopDiv: 12,
  /** 偵測窗長 = detectWin × N */
  detectWin: 0.75,
  /** 偵測分數門檻 */
  threshold: 0.3,
  /** 解碼窗起點（符號內比例） */
  symWinStart: 0.2,
  /** 解碼窗長度（符號比例，PoC） */
  symWinLen: 0.75,
  /** 分段累積時的解碼窗長度（符號比例；窗尾延伸到下一個符號的滑音區前段） */
  symWinLenAccum: 0.9,
  /** 分段累積：解碼窗切成幾段各自算功率再相加 */
  accumSegments: 2,
  /**
   * 分段累積的窗函數：'whole' = 整窗套 Hann 後再切段（每段是半個 Hann，不對稱）；
   * 'segment' = 每段各自套 Hann（對稱，旁瓣較低）。依 docs/benchmarks.md 的 A/B 結果選擇。
   */
  accumWindow: 'whole' as 'whole' | 'segment',
  /** 精細對齊搜尋範圍（±符號比例） */
  alignRange: 0.25,
  /** 精細對齊步長（秒） */
  alignStep: 0.001,
  /** 低 SNR 偵測：同步音功率 / 背景噪音的門檻（倍數）；換算後與 threshold 0.3 對應 */
  snrThreshold: 3,
  /** 低 SNR 偵測時，比例分數的最低要求（避免安靜環境下被旁瓣洩漏提早觸發） */
  snrRatioFloor: 0.12,
  /** 低 SNR 偵測時，目標頻道比最強頻道弱的部分以此比例計入參考值（抵抗相鄰頻道的主瓣洩漏） */
  snrDominance: 0.5,
  /** 等待額外樣本的餘量（符號比例） */
  margin: 0.3,
  /** 環形緩衝區長度（秒） */
  bufferSec: 16,
} as const;

/** 自動偵測（AutoReceiver） */
export const AUTO = {
  /** 掃描模式只計算的頻道 */
  scanChannels: [0, 1, 3, 7, 11, 15] as readonly number[],
  /** 前置高通濾波器截止頻率 */
  highpassHz: 14500,
  /** 鎖定後多久沒有成功解碼就回到掃描（秒） */
  relockSec: 60,
} as const;

/** 都卜勒補償（3.5.1） */
export const DOPPLER = {
  /** 聲速 m/s */
  soundSpeed: 343,
  /** 偵測階段的頻偏搜尋範圍 ±Hz（150 Hz 在 19.5 kHz 約對應 2.6 m/s 快走） */
  maxShiftHz: 150,
  /** 偵測階段頻偏搜尋的步長上限（Hz）；實際步長是 FFT bin 寬度 */
  coarseStepHz: 12,
  /** 精細估計頻偏時的搜尋半徑與步長（Hz） */
  fineRangeHz: 18,
  fineStepHz: 2,
  /** 解調時頻偏追蹤的更新比例（折衷調高至 0.45，兼顧快走加減速與抗噪穩定度） */
  trackGain: 0.45,
  /** 只有信心值（最大/第二大）高於此值的符號才用來更新追蹤 */
  trackMinConfidence: 2.5,
  /** 追蹤時估計頻率用的偏移量（Hz），以三點拋物線內插求峰值 */
  trackProbeHz: 12,
} as const;

/** 吵雜環境優化（3.5.2） */
export const NOISE = {
  /** 抹除解碼保留的偵錯餘量（2e + f ≤ nsym − reserve） */
  erasureReserve: 2,
  /** 依序嘗試的抹除數量 */
  erasureSteps: [2, 4] as readonly number[],
  /** 重送合併：兩次失敗封包的最大間隔（秒；兩次之間有語音廣播，約 5～12 秒） */
  combineWindowSec: 20,
  /** 重送合併：最多暫存幾個失敗封包 */
  combineMaxEntries: 4,
  /** 重送合併：前導碼品質（0～4）低於此值的失敗封包不暫存（多半是噪音假觸發） */
  combineMinQuality: 1.2,
  /** 同時進行中的合併工作上限 */
  combineMaxJobs: 6,
  /** 頻道白化（解碼）：以封包內各頻道功率的這個百分位數作為背景 */
  whitenPercentile: 0.25,
} as const;

/** 低頻洩漏檢查門檻（dB，能量占比） */
export const LEAKAGE = {
  /** 16 kHz 以下 */
  below16k: -100,
  /** 18 kHz 以下（18 kHz 頻段不檢查） */
  below18k: -80,
} as const;

/** 接收端可開關的優化選項 */
export interface RxOptions {
  /**
   * 分段累積：解碼窗加長並切成 2 段，各段 Goertzel 功率相加（非同調累積）。
   * 手機移動穿過駐波節點時，前後兩段的相位可能相反，整窗同調計算會互相抵銷；分段相加則不會。
   */
  accumulation: boolean;
  /**
   * 低 SNR 偵測：以「同步音功率 / 頻道背景噪音」取代「同步音占 18 頻道總功率的比例」，
   * 讓訊號弱、只比噪音高幾 dB 時也能觸發（需要 FFT 前端）
   */
  snrDetect: boolean;
  /** 都卜勒補償：偵測時搜尋頻偏、解調時修正頻率與符號時間 */
  doppler: boolean;
  /** 解調過程中持續追蹤頻偏（需 doppler） */
  tracking: boolean;
  /** 軟判決＋抹除解碼 */
  erasure: boolean;
  /** 頻道白化 */
  whitening: boolean;
  /** 重送合併 */
  combining: boolean;
}

/** PoC 基準版本：全部關閉 */
export const BASELINE_OPTIONS: RxOptions = {
  accumulation: false,
  snrDetect: false,
  doppler: false,
  tracking: false,
  erasure: false,
  whitening: false,
  combining: false,
};

/** 預設採用的優化（依 docs/benchmarks.md 的數據決定） */
export const DEFAULT_OPTIONS: RxOptions = {
  accumulation: true,
  snrDetect: true,
  doppler: true,
  tracking: true,
  erasure: true,
  whitening: true,
  combining: true,
};
