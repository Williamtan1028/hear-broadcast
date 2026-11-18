/**
 * 模板文字的佔位符替換與驗證。
 * 佔位符：{p1}、{p2}（依參數型別解讀：數字、目的地站名、出口、月台）、{station}（目前車站名稱）。
 */
import { LANGS, type Lang, type Station, type Template, type TemplatePack } from './schema.ts';

/** 模板文字中所有佔位符名稱 */
export const placeholdersOf = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

/** 參數值在指定語言下的顯示文字 */
export function paramText(
  t: Template,
  key: 'p1' | 'p2',
  value: number,
  station: Station | undefined,
  lang: Lang,
): string {
  const def = t.params.find((p) => p.key === key);
  if (!def) return String(value);
  switch (def.type) {
    case 'station': {
      const d = station?.destinations.find((x) => x.id === value);
      return d ? d.name[lang] : `#${value}`;
    }
    case 'exit': {
      const e = station?.exits.find((x) => x.id === value);
      return e ? e.name[lang] : `${value}`;
    }
    case 'platform':
    case 'number':
      return String(value);
  }
}

/**
 * 產生某語言的字幕文字。
 * @param t 模板
 * @param params p1、p2 的數值
 * @param station 車站（用於站名、出口、目的地）
 * @param lang 語言
 */
export function renderTemplate(
  t: Template,
  params: { p1: number; p2: number },
  station: Station | undefined,
  lang: Lang,
): string {
  return t.text[lang].replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name === 'p1' || name === 'p2') return paramText(t, name, params[name], station, lang);
    if (name === 'station') return station ? station.name[lang] : '';
    return whole;
  });
}

/** 參數的可選值（給站務端產生輸入欄位） */
export function paramChoices(
  t: Template,
  key: 'p1' | 'p2',
  station: Station | undefined,
): { value: number; label: string }[] | null {
  const def = t.params.find((p) => p.key === key);
  if (!def) return null;
  if (def.type === 'station')
    return (station?.destinations ?? []).map((d) => ({ value: d.id, label: d.name.zh }));
  if (def.type === 'exit') return (station?.exits ?? []).map((e) => ({ value: e.id, label: e.name.zh }));
  if (def.type === 'platform')
    return Array.from({ length: station?.platforms ?? 2 }, (_, i) => ({
      value: i + 1,
      label: `第 ${i + 1} 月台`,
    }));
  return null;
}

/** 參數的預設值 */
export function defaultParam(t: Template, key: 'p1' | 'p2', station: Station | undefined): number {
  const def = t.params.find((p) => p.key === key);
  if (!def) return 0;
  if (def.type === 'number') return def.min;
  return paramChoices(t, key, station)?.[0]?.value ?? 0;
}

export interface TemplateIssue {
  templateId: number;
  lang?: Lang;
  message: string;
}

/**
 * 驗證單一模板：佔位符是否都有對應參數、文字有沒有缺漏、參數定義是否合理。
 */
export function validateTemplate(t: Template): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const keys = t.params.map((p) => p.key);
  if (new Set(keys).size !== keys.length) issues.push({ templateId: t.id, message: '參數 key 重複' });
  for (const p of t.params)
    if (p.type === 'number' && p.min > p.max)
      issues.push({ templateId: t.id, message: `${p.key} 最小值大於最大值` });
  for (const lang of LANGS) {
    const text = t.text[lang]?.trim();
    if (!text) {
      issues.push({ templateId: t.id, lang, message: '文字缺漏' });
      continue;
    }
    for (const ph of placeholdersOf(text)) {
      if (ph === 'station') continue;
      if (ph !== 'p1' && ph !== 'p2')
        issues.push({ templateId: t.id, lang, message: `未知的佔位符 {${ph}}` });
      else if (!keys.includes(ph))
        issues.push({ templateId: t.id, lang, message: `佔位符 {${ph}} 沒有對應參數` });
    }
    for (const k of keys)
      if (!placeholdersOf(text).includes(k))
        issues.push({ templateId: t.id, lang, message: `參數 ${k} 沒有出現在文字中` });
  }
  return issues;
}

/** 驗證整個模板庫（含 templateId 重複） */
export function validatePack(pack: TemplatePack): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const seen = new Set<number>();
  for (const t of pack.templates) {
    if (seen.has(t.id)) issues.push({ templateId: t.id, message: 'templateId 重複' });
    seen.add(t.id);
    issues.push(...validateTemplate(t));
  }
  return issues;
}
