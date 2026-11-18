/**
 * 平台轉接層：麥克風、震動、螢幕常亮、語音合成、儲存。
 * 之後用 Capacitor 包成原生 App 時，只要替換這一層（例如改用 @capacitor/haptics、原生 TTS）。
 */

// ---------------- 麥克風 ----------------

/** 麥克風錯誤（已轉成可讀的中文訊息） */
export class MicError extends Error {}

/**
 * 取得麥克風串流：關閉回音消除、噪音抑制、自動增益（這些處理會把高頻訊號當成噪音濾掉）。
 */
export async function openMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicError(window.isSecureContext ? '這個瀏覽器不支援麥克風' : '麥克風需要 HTTPS 連線');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'NotAllowedError') throw new MicError('麥克風權限被拒絕，請在瀏覽器設定中允許使用麥克風');
    if (name === 'NotFoundError') throw new MicError('找不到麥克風');
    throw new MicError(`無法開啟麥克風：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------- 震動 ----------------

/** 震動（iPhone 不支援時靜默略過，不報錯） */
export function vibrate(pattern: number | number[]): boolean {
  try {
    return typeof navigator.vibrate === 'function' ? navigator.vibrate(pattern) : false;
  } catch {
    return false;
  }
}

export const VIBRATE_NORMAL = 120;
export const VIBRATE_EMERGENCY = [400, 200, 400, 200, 800];

// ---------------- 螢幕常亮 ----------------

/**
 * 接收中保持螢幕常亮；切回頁面時自動重新取得。
 * @returns 釋放函式；不支援時回傳 null
 */
export async function keepScreenOn(): Promise<(() => void) | null> {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<WakeLockSentinel> } })
    .wakeLock;
  if (!wl) return null;
  let sentinel: WakeLockSentinel | null = null;
  const acquire = async () => {
    try {
      sentinel = await wl.request('screen');
    } catch {
      sentinel = null;
    }
  };
  const onVis = () => {
    if (document.visibilityState === 'visible') void acquire();
  };
  await acquire();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    void sentinel?.release().catch(() => {});
  };
}

// ---------------- 語音合成（TTS） ----------------

/** 語音合成結果 */
export type SpeakResult = 'done' | 'no-voice' | 'unsupported' | 'error';

/** 找出指定語言的語音（speechSynthesis 的語音清單可能延遲載入） */
export async function findVoice(lang: string): Promise<SpeechSynthesisVoice | null> {
  if (!('speechSynthesis' in window)) return null;
  const pick = () => {
    const vs = speechSynthesis.getVoices();
    const l = lang.toLowerCase();
    return (
      vs.find((v) => v.lang.toLowerCase() === l) ??
      vs.find((v) => v.lang.toLowerCase().startsWith(l.split('-')[0] + '-t')) ??
      null
    );
  };
  let v = pick();
  if (v || speechSynthesis.getVoices().length) return v;
  await new Promise<void>((res) => {
    const t = setTimeout(res, 1500);
    speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        clearTimeout(t);
        res();
      },
      { once: true },
    );
  });
  v = pick();
  return v;
}

/**
 * 唸出文字（預設 zh-TW）。TTS 只是讓展示更像真實車站，不是系統核心；
 * 瀏覽器的 TTS 無法指定輸出聲道。
 */
export async function speak(text: string, lang = 'zh-TW'): Promise<SpeakResult> {
  if (!('speechSynthesis' in window)) return 'unsupported';
  const voice = await findVoice(lang);
  if (!voice) return 'no-voice';
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 1;
    u.onend = () => resolve('done');
    u.onerror = () => resolve('error');
    speechSynthesis.speak(u);
  });
}

export function cancelSpeech(): void {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ---------------- 儲存 ----------------

/** 讀取 localStorage 設定（讀不到或格式錯誤時回傳預設值） */
export function loadSetting<T>(key: string, def: T): T {
  try {
    const s = localStorage.getItem('hb:' + key);
    return s === null ? def : { ...def, ...(JSON.parse(s) as T) };
  } catch {
    return def;
  }
}

export function saveSetting<T>(key: string, value: T): void {
  try {
    localStorage.setItem('hb:' + key, JSON.stringify(value));
  } catch {
    // 私密模式等情況寫不進去：設定只在本次有效
  }
}

/** 下載檔案（WAV、JSON） */
export function downloadFile(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
