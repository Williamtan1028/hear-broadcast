// 測試 6：月台篩選與去重
import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, Inbox, type ReceiveMeta } from '../src/features/rx/inbox.ts';
import type { Message } from '../src/modem/protocol.ts';

const tpl = (platform: number, seq: number, templateId = 3, stationId = 1): Message => ({
  type: 'template',
  stationId,
  platform,
  seq,
  packVersion: 1,
  templateId,
  p1: 0,
  p2: 0,
});
const meta = (quality: number, emergency = false): ReceiveMeta => ({
  quality,
  fixed: 0,
  combined: false,
  emergency,
});

describe('月台篩選與去重', () => {
  it('兩個月台訊號品質不同時，自動判斷選品質較高的月台', () => {
    const inbox = new Inbox();
    // 手機靠近第 1 月台喇叭：第 1 月台的訊號品質高、第 2 月台（遠處喇叭）品質低
    inbox.receive(tpl(1, 10), meta(0.82), 0);
    const far = inbox.receive(tpl(2, 11), meta(0.41), 3_000);
    expect(inbox.currentPlatform(3_000)).toBe(1);
    expect(far.status).toBe('new');
    expect(far.announcement!.shown).toBe(false);
    const near = inbox.receive(tpl(1, 12), meta(0.79), 6_000);
    expect(near.announcement!.shown).toBe(true);
  });

  it('另一支手機在第 2 月台：結果相反', () => {
    const inbox = new Inbox();
    inbox.receive(tpl(1, 10), meta(0.35), 0);
    inbox.receive(tpl(2, 11), meta(0.88), 3_000);
    expect(inbox.currentPlatform(3_000)).toBe(2);
    expect(inbox.receive(tpl(1, 12), meta(0.33), 6_000).announcement!.shown).toBe(false);
    expect(inbox.receive(tpl(2, 13), meta(0.86), 9_000).announcement!.shown).toBe(true);
  });

  it('只使用最近 20 秒的訊息判斷月台', () => {
    const inbox = new Inbox();
    inbox.receive(tpl(1, 1), meta(0.9), 0);
    inbox.receive(tpl(2, 2), meta(0.5), 25_000);
    expect(inbox.currentPlatform(25_000)).toBe(2);
  });

  it('全站廣播與緊急廣播一律顯示', () => {
    const inbox = new Inbox();
    inbox.receive(tpl(1, 1), meta(0.9), 0);
    expect(inbox.receive(tpl(0, 2), meta(0.2), 1_000).announcement!.shown).toBe(true);
    expect(inbox.receive(tpl(2, 3, 10), meta(0.2, true), 2_000).announcement!.shown).toBe(true);
  });

  it('相同 seq 在 30 秒內不重複顯示；超過 30 秒視為新訊息', () => {
    const inbox = new Inbox();
    expect(inbox.receive(tpl(1, 7), meta(0.6), 0).status).toBe('new');
    expect(inbox.receive(tpl(1, 7), meta(0.7), 6_000).status).toBe('duplicate');
    expect(inbox.receive(tpl(2, 7), meta(0.7), 7_000).status).toBe('new'); // 不同月台不是重複
    expect(inbox.receive(tpl(1, 7), meta(0.7), 40_000).status).toBe('new');
    expect(inbox.history).toHaveLength(3);
  });

  it('同一個 seq 但內容不同（兩台站務筆電撞號）不視為重複', () => {
    const inbox = new Inbox();
    expect(inbox.receive(tpl(1, 9, 3), meta(0.6), 0).status).toBe('new');
    expect(inbox.receive(tpl(1, 9, 5), meta(0.6), 2_000).status).toBe('new');
    expect(inbox.receive(tpl(1, 9, 5), meta(0.6), 6_000).status).toBe('duplicate');
  });

  it('歷史紀錄有上限', () => {
    const inbox = new Inbox();
    for (let i = 0; i < HISTORY_LIMIT + 50; i++)
      inbox.receive(tpl(1, i % 256, 3 + (i >> 8)), meta(0.6), i * 40_000);
    expect(inbox.history).toHaveLength(HISTORY_LIMIT);
  });

  it('重複的第二次傳送仍納入月台判斷', () => {
    const inbox = new Inbox();
    inbox.receive(tpl(2, 1), meta(0.5), 0);
    inbox.receive(tpl(1, 2), meta(0.4), 1_000);
    inbox.receive(tpl(1, 2), meta(0.9), 6_000); // 第二次傳送收得更好
    expect(inbox.currentPlatform(6_000)).toBe(1);
  });

  it('手動月台', () => {
    const inbox = new Inbox();
    inbox.platformMode = 'manual';
    inbox.manualPlatform = 2;
    expect(inbox.receive(tpl(1, 1), meta(0.95), 0).announcement!.shown).toBe(false);
    expect(inbox.receive(tpl(2, 2), meta(0.1), 1_000).announcement!.shown).toBe(true);
  });

  it('鎖定第一個車站，其他車站只提示不顯示', () => {
    const inbox = new Inbox();
    inbox.receive(tpl(1, 1), meta(0.8), 0);
    const r = inbox.receive(tpl(1, 2, 3, 9), meta(0.8), 1_000);
    expect(r.status).toBe('other-station');
    expect(inbox.otherStation).toBe(9);
    expect(inbox.stationId).toBe(1);
  });
});
