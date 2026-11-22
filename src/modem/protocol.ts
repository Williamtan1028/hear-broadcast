/**
 * 協定 v2：封包 payload 格式。
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
 * | 文字 4～ | UTF-8 文字，最多 44 bytes |
 *
 * 防偽（廣播認證）本版不實作，評估紀錄見 docs/review.md。
 */
import { DEFAULTS } from './config.ts';

export const PROTOCOL_VERSION = 2;
export const TYPE_TEMPLATE = 1;
export const TYPE_TEXT = 2;
/** 標頭長度 */
export const HEADER_BYTES = 4;
/** 模板封包長度 */
export const TEMPLATE_BYTES = 8;
/** 自由文字最多幾個位元組 */
export const MAX_TEXT_BYTES = DEFAULTS.maxLen - HEADER_BYTES;
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
 * 編碼訊息為 payload 位元組。
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
 * 解碼 payload。版本、型別、長度、UTF-8 都會驗證，可作為 RS 之外的額外完整性檢查。
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
 * packVersion 是否比本機的新（序號循環比較：255 之後回到 0 也能正確判斷）。
 * 差距在 1～127 之間視為較新，128～255 視為較舊。
 */
export function isNewerPack(remote: number, local: number): boolean {
  const d = (remote - local) & 0xff;
  return d >= 1 && d <= 127;
}
