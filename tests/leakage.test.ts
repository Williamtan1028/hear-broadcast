// 測試 4-1：低頻洩漏檢查
import { describe, expect, it } from 'vitest';
import { BANDS, LEAKAGE, MODES, SYNTH, makeConfig, type ModeName } from '../src/modem/config.ts';
import { synthesize, synthesizeAbrupt, synthesizeHard } from '../src/modem/fsk.ts';
import { checkLeakage } from '../src/modem/leakage.ts';
import { encodeMessage } from '../src/modem/protocol.ts';
import { defaultParam } from '../src/data/render.ts';
import { loadPack, loadStations } from './data.ts';

const pack = loadPack();
const station = loadStations().stations[0];
const fs = 48000;

describe('低頻洩漏（所有頻段 × 兩種模式 × 所有預設模板）', () => {
  for (const band of BANDS) {
    for (const mode of Object.keys(MODES) as ModeName[]) {
      it(`${band.f0} Hz／${mode}`, () => {
        const cfg = makeConfig(band.f0, mode);
        let worst16 = -Infinity;
        let worst18 = -Infinity;
        for (const t of pack.templates) {
          const payload = encodeMessage({
            type: 'template',
            stationId: station.stationId,
            platform: 1,
            seq: t.id,
            packVersion: pack.packVersion,
            templateId: t.id,
            p1: defaultParam(t, 'p1', station),
            p2: defaultParam(t, 'p2', station),
          });
          for (const amp of [SYNTH.defaultAmp, SYNTH.maxAmp]) {
            const r = checkLeakage(synthesize(payload, cfg, fs, amp), fs, band.f0);
            expect(r.pass, r.reasons.join('；')).toBe(true);
            worst16 = Math.max(worst16, r.below16kDb);
            worst18 = Math.max(worst18, r.below18kDb);
          }
        }
        expect(worst16).toBeLessThanOrEqual(LEAKAGE.below16k);
        if (band.f0 > 18000) expect(worst18).toBeLessThanOrEqual(LEAKAGE.below18k);
        console.log(
          `${band.f0}/${mode}：16k 以下 ${worst16.toFixed(1)} dB、18k 以下 ${worst18.toFixed(1)} dB`,
        );
      });
    }
  }

  it('反向測試：瞬間切換頻率、沒有淡入淡出的訊號必須判定不合格', () => {
    for (const band of BANDS) {
      const cfg = makeConfig(band.f0, 'standard');
      const r = checkLeakage(synthesizeAbrupt([1, 2, 3, 4, 5, 6, 7, 8], cfg, fs), fs, band.f0);
      expect(r.pass).toBe(false);
      expect(r.below16kDb).toBeGreaterThan(LEAKAGE.below16k);
    }
  });

  it('舊版硬切換波形（PoC synthesizeHard）在 19.5 kHz 也不合格', () => {
    const cfg = makeConfig(19500, 'standard');
    expect(checkLeakage(synthesizeHard([1, 2, 3, 4], cfg, fs), fs, 19500).pass).toBe(false);
  });
});
