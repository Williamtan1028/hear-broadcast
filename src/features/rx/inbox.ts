/**
 * 乘客端的訊息處理：去重、月台判斷與篩選、車站鎖定。不依賴 React，可直接測試。
 *
 * - 去重：同一組 (stationId, platform, seq, 內容) 在 30 秒內只顯示一次（站務端會送兩次）。
 *   比對內容是因為同一站可能有兩台站務筆電，各自的 seq 可能剛好相同。
 * - 月台自動判斷：最近 20 秒內收到的訊息中，訊號品質最高者的月台即「目前所在月台」；
 *   只顯示該月台與全站（platform 0）的廣播。聲音天生帶有位置資訊：離喇叭越近、品質越高。
 * - 全站廣播與緊急廣播一律顯示。
 * - 車站：鎖定第一個收到的 stationId；收到其他站的訊號時提示，不顯示內容。
 */
import type { Message } from '../../modem/protocol.ts';

export const DEDUPE_MS = 30_000;
export const PLATFORM_WINDOW_MS = 20_000;
/** 歷史紀錄最多保留幾則（長時間開著時避免無限累積） */
export const HISTORY_LIMIT = 200;

/** 訊息內容的指紋（去重用） */
const fingerprint = (m: Message): string =>
  m.type === 'template' ? `t${m.templateId}:${m.p1}:${m.p2}` : `x${m.text}`;

export interface ReceiveMeta {
  /** 訊號品質（0～1） */
  quality: number;
  /** RS 修正的位元組數 */
  fixed: number;
  /** 是否靠重送合併解出 */
  combined: boolean;
  /** 是否為緊急類模板 */
  emergency: boolean;
}

export interface Announcement {
  /** 唯一 id（去重鍵＋時間） */
  id: string;
  msg: Message;
  meta: ReceiveMeta;
  /** 收到時間（ms） */
  at: number;
  /** 是否顯示在看板上（月台篩選後） */
  shown: boolean;
}

export type ReceiveStatus = 'new' | 'duplicate' | 'other-station';

export interface ReceiveResult {
  status: ReceiveStatus;
  announcement: Announcement | null;
}

interface Observation {
  platform: number;
  quality: number;
  at: number;
}

export class Inbox {
  /** 鎖定的車站 */
  stationId: number | null = null;
  /** 月台模式 */
  platformMode: 'auto' | 'manual' = 'auto';
  manualPlatform = 1;
  /** 本次接收的所有廣播（新的在前） */
  history: Announcement[] = [];
  /** 最近一次收到的其他車站 id */
  otherStation: number | null = null;

  private seen = new Map<string, number>();
  private obs: Observation[] = [];

  /** 處理一則解碼成功的訊息 */
  receive(msg: Message, meta: ReceiveMeta, now: number): ReceiveResult {
    if (this.stationId === null) this.stationId = msg.stationId;
    if (msg.stationId !== this.stationId) {
      this.otherStation = msg.stationId;
      return { status: 'other-station', announcement: null };
    }
    // 月台觀測：重複的第二次傳送也算，品質資訊越多判斷越準
    if (msg.platform > 0) this.obs.push({ platform: msg.platform, quality: meta.quality, at: now });
    this.obs = this.obs.filter((o) => now - o.at <= PLATFORM_WINDOW_MS);

    const key = `${msg.stationId}/${msg.platform}/${msg.seq}/${fingerprint(msg)}`;
    for (const [k, t] of this.seen) if (now - t > DEDUPE_MS) this.seen.delete(k);
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev <= DEDUPE_MS) return { status: 'duplicate', announcement: null };
    this.seen.set(key, now);

    const a: Announcement = {
      id: `${key}@${now}`,
      msg,
      meta,
      at: now,
      shown: this.isVisible(msg, meta, now),
    };
    this.history.unshift(a);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
    return { status: 'new', announcement: a };
  }

  /** 設定月台判斷方式 */
  setPlatformMode(mode: 'auto' | 'manual', manualPlatform: number): void {
    this.platformMode = mode;
    this.manualPlatform = manualPlatform;
  }

  /** 目前判斷的月台（自動：最近 20 秒品質最高者；沒有資料時為 null） */
  currentPlatform(now: number): number | null {
    if (this.platformMode === 'manual') return this.manualPlatform;
    let best: Observation | null = null;
    for (const o of this.obs)
      if (now - o.at <= PLATFORM_WINDOW_MS && (!best || o.quality > best.quality)) best = o;
    return best ? best.platform : null;
  }

  /** 這則訊息是否應該顯示 */
  isVisible(msg: Message, meta: ReceiveMeta, now: number): boolean {
    if (meta.emergency || msg.platform === 0) return true;
    const p = this.currentPlatform(now);
    return p === null || p === msg.platform;
  }

  /** 重新開始（換站或使用者清除） */
  reset(): void {
    this.stationId = null;
    this.otherStation = null;
    this.history = [];
    this.seen.clear();
    this.obs = [];
  }
}
