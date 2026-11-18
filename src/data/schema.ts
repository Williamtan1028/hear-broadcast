/**
 * 模板庫與站點設定的資料格式（zod schema）。載入時驗證，格式錯誤會產生可讀的錯誤訊息。
 */
import { z } from 'zod';

/** 支援的字幕語言 */
export const LANGS = ['zh', 'en', 'ja', 'ko', 'nan', 'hak'] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_LABELS: Record<Lang, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  nan: '台語',
  hak: '客語',
};

/** speechSynthesis / Intl 用的語言標籤 */
export const LANG_TAGS: Record<Lang, string> = {
  zh: 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  nan: 'nan-TW',
  hak: 'hak-TW',
};

const localized = z.object({
  zh: z.string(),
  en: z.string(),
  ja: z.string(),
  ko: z.string(),
  nan: z.string(),
  hak: z.string(),
});
export type Localized = z.infer<typeof localized>;

const flags = z.object({
  zh: z.boolean(),
  en: z.boolean(),
  ja: z.boolean(),
  ko: z.boolean(),
  nan: z.boolean(),
  hak: z.boolean(),
});

/** 模板參數：p1、p2 各一個位元組 */
export const paramSchema = z.discriminatedUnion('type', [
  z.object({
    key: z.enum(['p1', 'p2']),
    type: z.literal('number'),
    label: z.string(),
    min: z.number().int().min(0).max(255),
    max: z.number().int().min(0).max(255),
  }),
  z.object({ key: z.enum(['p1', 'p2']), type: z.literal('station'), label: z.string() }),
  z.object({ key: z.enum(['p1', 'p2']), type: z.literal('exit'), label: z.string() }),
  z.object({ key: z.enum(['p1', 'p2']), type: z.literal('platform'), label: z.string() }),
]);
export type TemplateParam = z.infer<typeof paramSchema>;
export type ParamType = TemplateParam['type'];

export const templateSchema = z.object({
  id: z.number().int().min(0).max(255),
  name: z.string().min(1),
  category: z.enum(['general', 'emergency']),
  params: z.array(paramSchema).max(2),
  text: localized,
  needsReview: flags,
});
export type Template = z.infer<typeof templateSchema>;

export const templatePackSchema = z.object({
  packVersion: z.number().int().min(0).max(255),
  templates: z.array(templateSchema),
});
export type TemplatePack = z.infer<typeof templatePackSchema>;

const namedItem = z.object({ id: z.number().int().min(0).max(255), name: localized });

export const stationSchema = z.object({
  stationId: z.number().int().min(0).max(255),
  name: localized,
  platforms: z.number().int().min(1).max(15),
  exits: z.array(namedItem),
  destinations: z.array(namedItem),
});
export type Station = z.infer<typeof stationSchema>;

export const stationsFileSchema = z.object({ stations: z.array(stationSchema).min(1) });
export type StationsFile = z.infer<typeof stationsFileSchema>;

/** 匯出／匯入的完整資料包 */
export const bundleSchema = z.object({ pack: templatePackSchema, stations: stationsFileSchema });
export type DataBundle = z.infer<typeof bundleSchema>;

/** 把 zod 錯誤轉成可讀的繁體中文訊息 */
export function formatZodError(err: z.ZodError, file: string): string {
  const lines = err.issues.slice(0, 8).map((i) => `・${i.path.join('.') || '(根)'}：${i.message}`);
  const more = err.issues.length > 8 ? `\n…另有 ${err.issues.length - 8} 個錯誤` : '';
  return `${file} 格式錯誤：\n${lines.join('\n')}${more}`;
}

/** 資料格式錯誤 */
export class DataFormatError extends Error {}

/** 驗證並回傳資料，失敗時丟出可讀的 DataFormatError */
export function parseWith<T>(schema: z.ZodType<T>, data: unknown, file: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new DataFormatError(formatZodError(r.error, file));
  return r.data;
}
