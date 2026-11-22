/**
 * 協定 v2：封包 payload 格式（含 6 Bytes 離線防偽造驗證尾碼）。
 *
 * | 位元組 | 欄位 |
 * |---|---|
 * | 0 | (version << 4) | type；version = 2；type 1 = 模板、2 = 自由文字 |
 * | 1 | stationId（0～255） |
 * | 2 | platform（0 = 全站，含緊急廣播；1～15 = 月台） |
 * | 3 | seq（0～255 循環，用於去重） |
 * | 模板 4 | packVersion（模板庫版本） |
 * | 模板 5 | templateId |
 * | 模板 6～7 | p1, p2 |
 * | 文字 4～ | UTF-8 文字，最多 38 bytes |
 * | 尾碼倒數 6～5 | 2-Byte 分鐘級時間戳記（16-bit） |
 * | 尾碼倒數 4～1 | 4-Byte 截斷式 HMAC-SHA256 防偽指紋 |
 */
import {
  AUTH_TRAILER_BYTES,
  createAuthTrailer,
  EmergencyAlertGuard,
  verifyAuthTrailer,
} from './auth.ts';
import { DEFAULTS } from './config.ts';

export { EmergencyAlertGuard };

export const PROTOCOL_VERSION = 2;
export const TYPE_TEMPLATE = 1;
export const TYPE_TEXT = 2;
/** 標頭長度 */
export const HEADER_BYTES = 4;
/** 模板封包長度（未含防偽尾碼） */
export const TEMPLATE_BYTES = 8;
/** 自由文字最多幾個位元組（預留 6 Bytes 給時間戳記＋HMAC） */
export const MAX_TEXT_BYTES = DEFAULTS.maxLen - HEADER_BYTES - AUTH_TRAILER_BYTES;
/** 月台編號上限 */
export const MAX_PLATFORM = 15;

/** 所有訊息共有的欄位 */
export interface MessageHeader {
  stationId: number;
  /** 0 = 全站 */
  platform: number;
  seq: number;
}

export interface TemplateMessage extends MessageHeader {
  type: 'template';
  packVersion: number;
  templateId: number;
  p1: number;
  p2: number;
}

export interface TextMessage extends MessageHeader {
  type: 'text';
  text: string;
}

export type Message = TemplateMessage | TextMessage;

/** 協定格式錯誤 */
export class ProtocolError extends Error {}

const u8 = (v: number, name: string, max = 255): number => {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new ProtocolError(`${name} 必須是 0～${max} 的整數`);
  return v;
};

/** UTF-8 位元組數 */
export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/**
 * 把字串截到不超過 maxBytes 個 UTF-8 位元組（不會切斷多位元組字元）。
 */
export function truncateUtf8(s: string, maxBytes: number = MAX_TEXT_BYTES): string {
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = utf8Length(ch);
    if (n + b > maxBytes) break;
    out += ch;
    n += b;
  }
  return out;
}

/**
 * 編碼原始訊息為 payload 位元組（未含防偽尾碼）。
 * @throws ProtocolError 欄位超出範圍或文字太長
 */
export function encodeMessage(m: Message): Uint8Array {
  const head = [
    (PROTOCOL_VERSION << 4) | (m.type === 'template' ? TYPE_TEMPLATE : TYPE_TEXT),
    u8(m.stationId, 'stationId'),
    u8(m.platform, 'platform', MAX_PLATFORM),
    u8(m.seq, 'seq'),
  ];
  if (m.type === 'template') {
    return Uint8Array.from([
      ...head,
      u8(m.packVersion, 'packVersion'),
      u8(m.templateId, 'templateId'),
      u8(m.p1, 'p1'),
      u8(m.p2, 'p2'),
    ]);
  }
  const text = new TextEncoder().encode(m.text);
  if (text.length === 0) throw new ProtocolError('文字不可為空');
  if (text.length > MAX_TEXT_BYTES)
    throw new ProtocolError(`文字最多 ${MAX_TEXT_BYTES} bytes（目前 ${text.length}）`);
  return Uint8Array.from([...head, ...text]);
}

/**
 * 【發送端使用】編碼訊息並附上 6 Bytes 防偽尾碼 [Timestamp(2B) + HMAC(4B)]，準備交給 RS 編碼。
 */
export async function encodeSignedMessage(m: Message, nowMs?: number): Promise<Uint8Array> {
  const rawPayload = encodeMessage(m);
  const trailer = await createAuthTrailer(rawPayload, nowMs);
  const signed = new Uint8Array(rawPayload.length + AUTH_TRAILER_BYTES);
  signed.set(rawPayload, 0);
  signed.set(trailer, rawPayload.length);
  return signed;
}

/**
 * 解碼原始 payload（未含防偽尾碼）。
 * @throws ProtocolError 格式不符
 */
export function decodeMessage(p: ArrayLike<number>): Message {
  if (p.length < HEADER_BYTES + 1) throw new ProtocolError('封包太短');
  const version = p[0] >> 4;
  const type = p[0] & 15;
  if (version !== PROTOCOL_VERSION) throw new ProtocolError(`不支援的協定版本 ${version}`);
  const platform = p[2];
  if (platform > MAX_PLATFORM) throw new ProtocolError(`月台編號 ${platform} 超出範圍`);
  const head = { stationId: p[1], platform, seq: p[3] };
  if (type === TYPE_TEMPLATE) {
    if (p.length !== TEMPLATE_BYTES) throw new ProtocolError('模板封包長度必須是 8');
    return { type: 'template', ...head, packVersion: p[4], templateId: p[5], p1: p[6], p2: p[7] };
  }
  if (type === TYPE_TEXT) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(Array.from(p).slice(HEADER_BYTES)),
      );
    } catch {
      throw new ProtocolError('文字不是合法的 UTF-8');
    }
    return { type: 'text', ...head, text };
  }
  throw new ProtocolError(`未知的封包型別 ${type}`);
}

/**
 * 【接收端使用】驗證時間窗（預設 ±2 分鐘）與 HMAC 指紋後解碼訊息。
 * @throws ProtocolError 簽章無效、時間過期或格式不符
 */
export async function decodeSignedMessage(
  p: ArrayLike<number>,
  windowMinutes: number = 2,
  nowMs?: number,
): Promise<Message> {
  const bytes = p instanceof Uint8Array ? p : Uint8Array.from(p);
  if (bytes.length <= AUTH_TRAILER_BYTES) {
    throw new ProtocolError('封包缺少防偽驗證尾碼');
  }
  const payloadLen = bytes.length - AUTH_TRAILER_BYTES;
  const rawPayload = bytes.subarray(0, payloadLen);
  const trailer = bytes.subarray(payloadLen);

  const authResult = await verifyAuthTrailer(rawPayload, trailer, windowMinutes, nowMs);
  if (!authResult.valid) {
    throw new ProtocolError(
      authResult.reason === 'INVALID_LENGTH'
        ? '防偽驗證尾碼長度錯誤'
        : '廣播簽章無效或時間戳記已過期（疑似偽造或錄音重播）',
    );
  }

  return decodeMessage(rawPayload);
}