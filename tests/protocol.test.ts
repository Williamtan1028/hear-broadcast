// 測試 2：協定 v2
import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_BYTES,
  ProtocolError,
  decodeMessage,
  encodeMessage,
  truncateUtf8,
  utf8Length,
  type Message,
} from '../src/modem/protocol.ts';
import { DEFAULTS } from '../src/modem/config.ts';

const tpl = (o: Partial<Extract<Message, { type: 'template' }>>): Message => ({
  type: 'template',
  stationId: 0,
  platform: 0,
  seq: 0,
  packVersion: 0,
  templateId: 0,
  p1: 0,
  p2: 0,
  ...o,
});

describe('協定 v2', () => {
  it('模板封包：編碼為 8 bytes，解碼來回一致', () => {
    const m = tpl({ stationId: 1, platform: 2, seq: 77, packVersion: 3, templateId: 10, p1: 4 });
    const b = encodeMessage(m);
    expect(b.length).toBe(8);
    expect(b[0]).toBe(0x21);
    expect(decodeMessage(b)).toEqual(m);
  });

  it('文字封包：UTF-8 中文與表情符號來回一致', () => {
    for (const text of ['列車延誤5分鐘', 'Hello 月台 🚆', 'a']) {
      const m: Message = { type: 'text', stationId: 255, platform: 0, seq: 255, text };
      const b = encodeMessage(m);
      expect(b[0]).toBe(0x22);
      expect(b.length).toBe(4 + utf8Length(text));
      expect(decodeMessage(b)).toEqual(m);
    }
  });

  it('欄位邊界值', () => {
    for (const platform of [0, 15])
      for (const v of [0, 255]) {
        const m = tpl({ stationId: v, platform, seq: v, packVersion: v, templateId: v, p1: v, p2: v });
        expect(decodeMessage(encodeMessage(m))).toEqual(m);
      }
    expect(() => encodeMessage(tpl({ stationId: 256 }))).toThrow(ProtocolError);
    expect(() => encodeMessage(tpl({ platform: 16 }))).toThrow(ProtocolError);
    expect(() => encodeMessage(tpl({ seq: -1 }))).toThrow(ProtocolError);
    expect(() => encodeMessage(tpl({ p1: 1.5 }))).toThrow(ProtocolError);
  });

  it('文字長度：最多 44 bytes，整個 payload 不超過 maxLen', () => {
    expect(MAX_TEXT_BYTES).toBe(44);
    const max = 'a'.repeat(44);
    expect(encodeMessage({ type: 'text', stationId: 1, platform: 1, seq: 1, text: max }).length).toBe(
      DEFAULTS.maxLen,
    );
    expect(() => encodeMessage({ type: 'text', stationId: 1, platform: 1, seq: 1, text: max + 'b' })).toThrow(
      ProtocolError,
    );
    expect(() => encodeMessage({ type: 'text', stationId: 1, platform: 1, seq: 1, text: '' })).toThrow(
      ProtocolError,
    );
    // 中文 3 bytes：14 個字 = 42 bytes，第 15 個字會超過
    expect(utf8Length(truncateUtf8('測'.repeat(20)))).toBe(42);
    expect(truncateUtf8('ab測', 4)).toBe('ab');
  });

  it('解碼時拒絕錯誤的版本、型別、長度與 UTF-8', () => {
    expect(() => decodeMessage([0x11, 1, 1, 1, 1, 1, 1, 1])).toThrow(/版本/);
    expect(() => decodeMessage([0x23, 1, 1, 1, 1, 1, 1, 1])).toThrow(/型別/);
    expect(() => decodeMessage([0x21, 1, 1, 1, 1, 1, 1])).toThrow(/長度/);
    expect(() => decodeMessage([0x21, 1, 16, 1, 1, 1, 1, 1])).toThrow(/月台/);
    expect(() => decodeMessage([0x22, 1, 1, 1, 0xff, 0xfe])).toThrow(/UTF-8/);
    expect(() => decodeMessage([0x22, 1, 1])).toThrow(/太短/);
  });
});
