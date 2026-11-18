/**
 * 預留給 AI／機器學習／語音辨識的擴充點（README「未來路線圖」）。
 * 本版因比賽組別限制不使用 AI：每個介面都只有非 AI 的實作，未來可直接替換。
 *
 * | 介面 | 本版實作（非 AI） | 未來可替換成 |
 * |---|---|---|
 * | AnnouncementSource | 模板＋參數、自由文字 | 語音辨識：站務員直接開口廣播，自動轉成文字封包 |
 * | Translator | 模板庫查表 | 機器翻譯：自由文字也能自動翻成多國語言 |
 * | SymbolDetector（src/modem/detectors） | Goertzel 功率＋最大值判定（含軟判決） | 神經網路解調器 |
 * | ChannelAdvisor | 診斷頁的掃頻規則 | 依現場噪音型態自動選頻段與速度的模型 |
 */
import { renderTemplate } from '../data/render.ts';
import type { Lang, Station, Template, TemplatePack } from '../data/schema.ts';
import { BANDS, type ModemConfig } from '../modem/config.ts';
import type { Message, MessageHeader } from '../modem/protocol.ts';

// ---------------- AnnouncementSource ----------------

/** 廣播內容來源：把站務人員的輸入變成協定 v2 訊息 */
export interface AnnouncementSource<Input> {
  readonly kind: string;
  build(input: Input, header: MessageHeader): Message;
}

/** 模板＋參數 */
export class TemplateSource implements AnnouncementSource<{ template: Template; p1: number; p2: number }> {
  readonly kind = 'template';
  constructor(private readonly packVersion: number) {}
  build(input: { template: Template; p1: number; p2: number }, header: MessageHeader): Message {
    return {
      type: 'template',
      ...header,
      packVersion: this.packVersion,
      templateId: input.template.id,
      p1: input.p1,
      p2: input.p2,
    };
  }
}

/** 自由文字 */
export class TextSource implements AnnouncementSource<{ text: string }> {
  readonly kind = 'text';
  build(input: { text: string }, header: MessageHeader): Message {
    return { type: 'text', ...header, text: input.text };
  }
}

// ---------------- Translator ----------------

export interface Translation {
  text: string;
  /** 這個語言的譯文是否待校對 */
  needsReview: boolean;
  /** 是否為原文（無法翻譯時顯示原文） */
  original: boolean;
}

/** 把訊息轉成指定語言的字幕 */
export interface Translator {
  translate(msg: Message, lang: Lang): Translation | null;
}

/** 本版實作：模板庫查表；自由文字直接顯示原文（未來可接機器翻譯） */
export class PackTranslator implements Translator {
  constructor(
    private readonly pack: TemplatePack,
    private readonly station: Station | undefined,
  ) {}

  template(id: number): Template | undefined {
    return this.pack.templates.find((t) => t.id === id);
  }

  translate(msg: Message, lang: Lang): Translation | null {
    if (msg.type === 'text') return { text: msg.text, needsReview: false, original: true };
    const t = this.template(msg.templateId);
    if (!t) return null;
    return {
      text: renderTemplate(t, msg, this.station, lang),
      needsReview: t.needsReview[lang],
      original: lang === 'zh',
    };
  }
}

// ---------------- ChannelAdvisor ----------------

export interface BandMeasurement {
  /** 頻率（Hz） */
  freq: number;
  /** 掃頻時的最大接收強度（dB） */
  levelDb: number;
  /** 掃頻前的背景噪音（dB） */
  noiseDb: number;
}

export interface ChannelAdvice {
  /** 建議的 f0；null = 沒有任何頻段可用 */
  f0: number | null;
  /** 各頻段是否可用 */
  bands: { f0: number; ok: boolean; worstMarginDb: number }[];
  reason: string;
}

/** 頻段與速度建議 */
export interface ChannelAdvisor {
  advise(measurements: BandMeasurement[], cfgTemplate: Pick<ModemConfig, 'df'>): ChannelAdvice;
}

/**
 * 本版實作：4 個可選頻段中，整個頻段（f0 ～ f0 + 17 × df）的接收強度都高於噪音 15 dB 以上的最高者。
 */
export class SweepRuleAdvisor implements ChannelAdvisor {
  constructor(private readonly minMarginDb = 15) {}

  advise(m: BandMeasurement[], cfg: Pick<ModemConfig, 'df'>): ChannelAdvice {
    const bands = BANDS.map((b) => {
      const lo = b.f0 - 125;
      const hi = b.f0 + 17 * cfg.df + 125;
      const inBand = m.filter((x) => x.freq >= lo && x.freq <= hi);
      const worst = inBand.length ? Math.min(...inBand.map((x) => x.levelDb - x.noiseDb)) : -Infinity;
      return { f0: b.f0, ok: inBand.length > 0 && worst >= this.minMarginDb, worstMarginDb: worst };
    });
    const best = bands.find((b) => b.ok) ?? null;
    return {
      f0: best?.f0 ?? null,
      bands,
      reason: best
        ? `${best.f0 / 1000} kHz 頻段全部高於噪音 ${this.minMarginDb} dB 以上（最低 ${best.worstMarginDb.toFixed(1)} dB）`
        : `沒有任何頻段全部高於噪音 ${this.minMarginDb} dB：請調高音量、換用高音較好的喇叭，或讓手機靠近一點`,
    };
  }
}
