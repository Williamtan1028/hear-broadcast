// 測試 7：模板
import { describe, expect, it } from 'vitest';
import { placeholdersOf, renderTemplate, validatePack, validateTemplate } from '../src/data/render.ts';
import { LANGS, parseWith, templatePackSchema, DataFormatError } from '../src/data/schema.ts';
import { loadPack, loadStations } from './data.ts';

const pack = loadPack();
const station = loadStations().stations[0];

describe('預設模板庫', () => {
  it('通過 schema 驗證，且至少 12 個模板、包含 3 個緊急模板', () => {
    expect(pack.templates.length).toBeGreaterThanOrEqual(12);
    expect(pack.templates.filter((t) => t.category === 'emergency').length).toBeGreaterThanOrEqual(3);
  });

  it('沒有驗證問題（佔位符都有對應參數、templateId 不重複）', () => {
    expect(validatePack(pack)).toEqual([]);
  });

  it('6 種語言都有文字；中文以外都標記待校對', () => {
    for (const t of pack.templates)
      for (const lang of LANGS) {
        expect(t.text[lang].trim().length, `${t.id}/${lang}`).toBeGreaterThan(0);
        expect(t.needsReview[lang]).toBe(lang !== 'zh');
      }
  });

  it('所有佔位符都能被正確替換', () => {
    for (const t of pack.templates)
      for (const lang of LANGS)
        for (const [p1, p2] of [
          [0, 1],
          [3, 2],
          [7, 30],
        ]) {
          const s = renderTemplate(t, { p1, p2 }, station, lang);
          expect(placeholdersOf(s), `${t.id}/${lang}: ${s}`).toEqual([]);
          expect(s).not.toContain('#'); // 找不到目的地時會顯示 #n
        }
  });

  it('替換內容正確', () => {
    const delay = pack.templates.find((t) => t.id === 1)!;
    expect(renderTemplate(delay, { p1: 7, p2: 15 }, station, 'zh')).toBe(
      '往高雄的列車延誤約 15 分鐘，造成不便，敬請見諒。',
    );
    expect(renderTemplate(delay, { p1: 0, p2: 5 }, station, 'en')).toContain('Taipei');
    const evac = pack.templates.find((t) => t.id === 10)!;
    expect(renderTemplate(evac, { p1: 2, p2: 0 }, station, 'ja')).toContain('2番出口');
  });

  it('驗證能抓出缺漏與錯誤的佔位符', () => {
    const t = structuredClone(pack.templates[0]);
    t.text.ko = '';
    t.text.en = 'Train {p3}';
    const issues = validateTemplate(t).map((i) => `${i.lang}:${i.message}`);
    expect(issues).toContain('ko:文字缺漏');
    expect(issues.some((s) => s.startsWith('en:未知的佔位符'))).toBe(true);
    const dup = { ...pack, templates: [...pack.templates, pack.templates[0]] };
    expect(validatePack(dup).some((i) => i.message === 'templateId 重複')).toBe(true);
  });

  it('格式錯誤時產生可讀的錯誤訊息', () => {
    expect(() =>
      parseWith(templatePackSchema, { packVersion: 'x', templates: [] }, 'template-pack.json'),
    ).toThrow(DataFormatError);
    try {
      parseWith(templatePackSchema, { packVersion: 1, templates: [{ id: 1 }] }, 'template-pack.json');
    } catch (e) {
      expect((e as Error).message).toContain('template-pack.json 格式錯誤');
      expect((e as Error).message).toContain('templates.0');
    }
  });
});
