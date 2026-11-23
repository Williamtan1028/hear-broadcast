// 回歸測試：docs/review.md 中修正的問題
import { describe, expect, it } from 'vitest';
import { SCENARIOS, channel, makeRng, resampleDoppler } from '../bench/channel.ts';
import { randomPayload } from '../bench/trial.ts';
import { AutoReceiver } from '../src/modem/autoReceiver.ts';
import { CANDIDATES, DEFAULT_OPTIONS, DEFAULTS, type ModemConfig } from '../src/modem/config.ts';
import { synthesize } from '../src/modem/fsk.ts';
import { decodeMessage, encodeMessage } from '../src/modem/protocol.ts';
import { Receiver, type RxMessage } from '../src/modem/receiver.ts';

const concat = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('回歸測試', () => {
  it('自動偵測只在 payload 通過協定檢查時才鎖定頻段', () => {
    const fs = 44100;
    const locks: (ModemConfig | null)[] = [];
    let ok = 0;
    let rejected = 0;
    const a = new AutoReceiver(fs, {
      opts: DEFAULT_OPTIONS,
      onLock: (c) => locks.push(c),
      onEvent: (e) => (e.ok ? ok++ : e.error === 'payload 格式不符' && rejected++),
      accept: (p) => {
        try {
          decodeMessage(p);
          return true;
        } catch {
          return false;
        }
      },
    });
    const feed = (x: Float32Array) => {
      for (let i = 0; i < x.length; i += 4096) a.push(x.subarray(i, i + 4096));
    };
    const good = encodeMessage({
      type: 'template',
      stationId: 1,
      platform: 1,
      seq: 5,
      packVersion: 1,
      templateId: 3,
      p1: 0,
      p2: 0,
    });
    // 先在 18 kHz 頻段收到「RS 正確但不是協定 v2」的封包，不可鎖定
    feed(resampleDoppler(synthesize([0x99, 1, 2, 3, 4, 5, 6, 7], CANDIDATES[6], 48000), 48000, fs));
    feed(new Float32Array(fs));
    // 再在 19.5 kHz 收到合法封包：應鎖定 19.5 kHz
    feed(resampleDoppler(synthesize(good, CANDIDATES[0], 48000), 48000, fs));
    feed(new Float32Array(fs));
    expect(rejected).toBe(1);
    expect(ok).toBe(1);
    expect(locks.filter(Boolean)).toEqual([CANDIDATES[0]]);
  });

  it('重送合併：兩次傳送之間有另一則廣播解碼成功，合併效果與中間靜音時相同', () => {
    // A 在極強噪音下送兩次（單次多半失敗），中間穿插一則清楚的 B（另一個月台）或同長度的靜音
    const run = (withB: boolean) => {
      let combinedA = 0;
      let wrong = 0;
      for (let i = 0; i < 20; i++) {
        const rng = makeRng(90_100 + i);
        const A = randomPayload(rng, 8);
        const B = randomPayload(rng, 8);
        const sigA = synthesize(A, DEFAULTS, 48000, 0.6);
        const a1 = channel(sigA, 48000, 44100, SCENARIOS.extreme, rng);
        const b = channel(
          synthesize(B, DEFAULTS, 48000, 0.6),
          48000,
          44100,
          { ...SCENARIOS.quiet, lead: 0.5 },
          rng,
        );
        const a2 = channel(sigA, 48000, 44100, { ...SCENARIOS.extreme, lead: 0.5 }, rng);
        const y = concat([a1, withB ? b : new Float32Array(b.length), a2]);
        const r = new Receiver(44100, {
          cfg: DEFAULTS,
          opts: DEFAULT_OPTIONS,
          onEvent: (e) => {
            if (!e.ok) return;
            const m = e as RxMessage;
            const isA = m.payload.every((v, k) => v === A[k]);
            const isB = m.payload.every((v, k) => v === B[k]);
            if (!isA && !isB) wrong++;
            if (isA && m.combined) combinedA++;
          },
        });
        for (let k = 0; k < y.length; k += 2048) r.push(y.subarray(k, k + 2048));
      }
      return { combinedA, wrong };
    };
    const silent = run(false);
    const withB = run(true);
    console.log(`A 靠合併解出：中間靜音 ${silent.combinedA}/20、中間穿插 B ${withB.combinedA}/20`);
    expect(silent.combinedA).toBeGreaterThan(0);
    expect(withB.combinedA).toBe(silent.combinedA);
    expect(silent.wrong + withB.wrong).toBe(0);
  });
});
