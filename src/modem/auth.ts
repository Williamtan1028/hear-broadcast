// src/modem/auth.ts

export const AUTH_TRAILER_BYTES = 6; // 2 Bytes 時間戳記 + 4 Bytes 截斷式 HMAC
const TIMESTAMP_BYTES = 2;
const TAG_BYTES = 4;

const DB_NAME = 'HearBroadcastAuthDB';
const STORE_NAME = 'keys';
const KEY_ID = 'station-hmac-key-v1';

/**
 * 開發測試用預設金鑰（正式部署時應由站務後台透過 HTTPS 首次連線下發並寫入 IndexedDB）
 */
const DEV_FALLBACK_SECRET = new TextEncoder().encode('HearBroadcast-Station-Secret-Key-2026');

/**
 * 取得目前分鐘級時間戳記（16-bit 無號整數，約 45.5 天循環一次，足以覆蓋 ±2 分鐘視窗）
 */
export function getMinuteTimestamp(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 60_000) & 0xffff;
}

/**
 * 初始化並取得不可匯出 (extractable: false) 的 CryptoKey
 * 即使打開 DevTools 也無法呼叫 exportKey 讀取原始金鑰內容
 */
export async function getAuthKey(rawSecret?: Uint8Array): Promise<CryptoKey> {
  const existing = await loadKeyFromIndexedDB();
  if (existing) return existing;

  const secretMaterial = rawSecret ?? DEV_FALLBACK_SECRET;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    secretMaterial as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false, // extractable = false：禁止任何程式碼匯出原始金鑰
    ['sign', 'verify'],
  );

  await saveKeyToIndexedDB(cryptoKey);
  return cryptoKey;
}

/**
 * 發送端使用：為原始 Payload 產生 6 Bytes 驗證尾碼 [Timestamp(2B) + AuthTag(4B)]
 */
export async function createAuthTrailer(
  payload: Uint8Array,
  nowMs: number = Date.now(),
): Promise<Uint8Array> {
  const key = await getAuthKey();
  const minuteTs = getMinuteTimestamp(nowMs);

  const tsBytes = new Uint8Array(TIMESTAMP_BYTES);
  tsBytes[0] = (minuteTs >>> 8) & 0xff;
  tsBytes[1] = minuteTs & 0xff;

  // 將 payload 與 timestamp 串接後一起計算 HMAC，防止時間戳記被竄改嫁接
  const signedInput = new Uint8Array(payload.length + TIMESTAMP_BYTES);
  signedInput.set(payload, 0);
  signedInput.set(tsBytes, payload.length);

  const fullSignature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedInput));

  const trailer = new Uint8Array(AUTH_TRAILER_BYTES);
  trailer.set(tsBytes, 0);
  trailer.set(fullSignature.subarray(0, TAG_BYTES), TIMESTAMP_BYTES);
  return trailer;
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'INVALID_LENGTH' | 'EXPIRED_OR_INVALID_SIGNATURE';
}

/**
 * 接收端使用：離線驗證封包簽章與時間窗（預設容許手機時鐘誤差 ±2 分鐘）
 */
export async function verifyAuthTrailer(
  payload: Uint8Array,
  trailer: Uint8Array,
  windowMinutes: number = 2,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  if (trailer.length !== AUTH_TRAILER_BYTES) {
    return { valid: false, reason: 'INVALID_LENGTH' };
  }

  const receivedTs = (trailer[0] << 8) | trailer[1];
  const receivedTag = trailer.subarray(TIMESTAMP_BYTES, AUTH_TRAILER_BYTES);
  const currentTs = getMinuteTimestamp(nowMs);

  // 檢查 receivedTs 是否落在 [currentTs - windowMinutes, currentTs + windowMinutes] 範圍內
  let inWindow = false;
  for (let offset = -windowMinutes; offset <= windowMinutes; offset++) {
    const candidateTs = (currentTs + offset) & 0xffff;
    if (candidateTs === receivedTs) {
      inWindow = true;
      break;
    }
  }
  if (!inWindow) {
    return { valid: false, reason: 'EXPIRED_OR_INVALID_SIGNATURE' };
  }

  // 重新計算 HMAC 並進行常數時間比對
  const key = await getAuthKey();
  const signedInput = new Uint8Array(payload.length + TIMESTAMP_BYTES);
  signedInput.set(payload, 0);
  signedInput.set(trailer.subarray(0, TIMESTAMP_BYTES), payload.length);

  const expectedFullSig = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedInput));
  const expectedTag = expectedFullSig.subarray(0, TAG_BYTES);

  if (!constantTimeEqual(receivedTag, expectedTag)) {
    return { valid: false, reason: 'EXPIRED_OR_INVALID_SIGNATURE' };
  }

  return { valid: true };
}

/**
 * Platform = 0 全站緊急廣播雙包驗證鎖
 * 要求連續兩包（例如 Audio 1 與 Audio 2）在 20 秒內皆通過 HMAC 驗證，才允許觸發全螢幕紅光與震動
 */
export class EmergencyAlertGuard {
  private pendingEmergency: {
    seqId: number;
    templateId: number;
    firstSeenMs: number;
  } | null = null;

  private readonly confirmWindowMs: number;

  constructor(confirmWindowMs: number = 20_000) {
    this.confirmWindowMs = confirmWindowMs;
  }

  /**
   * @returns true 代表已確認為合法緊急廣播可觸發警報；false 代表尚在等待第二包確認
   */
  public confirmPacket(
    platformId: number,
    seqId: number,
    templateId: number,
    nowMs: number = Date.now(),
  ): boolean {
    // 非緊急廣播（一般月台資訊）通過單包 HMAC 驗證即可立即顯示
    if (platformId !== 0) {
      return true;
    }

    if (
      this.pendingEmergency &&
      nowMs - this.pendingEmergency.firstSeenMs <= this.confirmWindowMs &&
      this.pendingEmergency.seqId === seqId &&
      this.pendingEmergency.templateId === templateId
    ) {
      // 第二包確認吻合，解鎖緊急警報並重置狀態
      this.pendingEmergency = null;
      return true;
    }

    // 收到第一包合法緊急廣播，先暫存等待第二包確認
    this.pendingEmergency = { seqId, templateId, firstSeenMs: nowMs };
    return false;
  }
}

// --- 內部輔助函式 ---

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function openAuthDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadKeyFromIndexedDB(): Promise<CryptoKey | null> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await openAuthDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(KEY_ID);
    req.onsuccess = () => resolve((req.result as CryptoKey) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function saveKeyToIndexedDB(key: CryptoKey): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openAuthDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(key, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
