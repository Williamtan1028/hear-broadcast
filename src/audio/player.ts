/**
 * 站務端播放器：雙聲道對應月台、播放佇列（同一時間只播一則）、播放前洩漏檢查、WAV 匯出。
 *
 * 一次廣播的流程：
 *   1. 叮咚提示音（可關閉）＋第一次高頻訊號，送到目標聲道
 *   2. speechSynthesis 唸出中文廣播（可關閉；TTS 無法指定聲道）
 *   3. 重送次數 2 時，再送一次相同 seq 的高頻訊號（語音關閉時兩次間隔 1 秒）
 */
import type { ModemConfig } from '../modem/config.ts';
import { synthesize } from '../modem/fsk.ts';
import { checkLeakage, type LeakageReport } from '../modem/leakage.ts';
import { cancelSpeech, speak, type SpeakResult } from '../platform/index.ts';
import { chime, encodeWav, mixInto, type Route, type Stereo } from './signals.ts';

export interface BroadcastJob {
  id: number;
  /** 顯示用標題 */
  label: string;
  payload: Uint8Array;
  route: Route;
  cfg: ModemConfig;
  amp: number;
  chime: boolean;
  /** 要唸的中文；null = 不唸 */
  speech: string | null;
  /** 高頻訊號送幾次（1 或 2） */
  repeats: number;
  /** 靜音模式：只送高頻，不播任何可聽見的聲音 */
  silent: boolean;
}

export type Phase = 'signal' | 'speech' | 'gap' | 'repeat';

export interface PlayerState {
  queue: BroadcastJob[];
  current: { job: BroadcastJob; phase: Phase; progress: number } | null;
  /** 最近一次的洩漏檢查結果 */
  leakage: LeakageReport | null;
  /** 最近一次的提示（例如找不到中文語音） */
  notice: string | null;
}

/** 產生並檢查高頻訊號；洩漏超過門檻時丟出錯誤，不得播放 */
export function buildSignal(job: BroadcastJob, fs: number): { signal: Float32Array; leakage: LeakageReport } {
  const signal = synthesize(job.payload, job.cfg, fs, job.amp);
  const leakage = checkLeakage(signal, fs, job.cfg.f0);
  // 最高原則「不打擾聽得到的人」：洩漏超過門檻一律拒絕播放（不可停用）
  if (!leakage.pass) throw new LeakageError(leakage);
  return { signal, leakage };
}

export class LeakageError extends Error {
  constructor(readonly report: LeakageReport) {
    super(`低頻洩漏超過門檻，已停止播放：${report.reasons.join('；')}`);
  }
}

/** 把整則廣播（不含 TTS）組成雙聲道，供下載 WAV */
export function renderBroadcastWav(job: BroadcastJob, fs = 48000): Uint8Array {
  const { signal } = buildSignal(job, fs);
  let st: Stereo | null = null;
  if (job.chime && !job.silent) st = mixInto(st, chime(fs), job.route, 0);
  st = mixInto(st, signal, job.route, 0);
  if (job.repeats > 1) {
    const start = st.left.length + fs; // 間隔 1 秒
    st = mixInto(st, signal, job.route, start);
  }
  const tail = Math.round(fs * 0.3);
  return encodeWav([padEnd(st.left, tail), padEnd(st.right, tail)], fs);
}

const padEnd = (x: Float32Array, n: number) => {
  const o = new Float32Array(x.length + n);
  o.set(x);
  return o;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 播放佇列。同一時間只播一則，避免兩個月台的訊號互相干擾。
 */
export class BroadcastPlayer {
  private ctx: AudioContext | null = null;
  private queue: BroadcastJob[] = [];
  private current: PlayerState['current'] = null;
  private leakage: LeakageReport | null = null;
  private notice: string | null = null;
  private busy = false;
  private stopRequested = false;
  private source: AudioBufferSourceNode | null = null;

  constructor(
    private readonly onChange: (s: PlayerState) => void,
    private readonly onDone: (job: BroadcastJob, error?: Error) => void,
  ) {}

  /** 取得（或建立）AudioContext；第一次必須在使用者手勢中呼叫 */
  audio(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback' });
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  get state(): PlayerState {
    return { queue: [...this.queue], current: this.current, leakage: this.leakage, notice: this.notice };
  }

  /** 加入佇列 */
  enqueue(job: BroadcastJob): void {
    this.audio();
    this.queue.push(job);
    this.emit();
    void this.pump();
  }

  /** 從佇列移除尚未播放的廣播 */
  remove(id: number): void {
    this.queue = this.queue.filter((j) => j.id !== id);
    this.emit();
  }

  /** 停止目前播放並清空佇列 */
  stopAll(): void {
    this.queue = [];
    this.stopRequested = true;
    try {
      this.source?.stop();
    } catch {
      /* 已停止 */
    }
    cancelSpeech();
    this.emit();
  }

  /** 播放一段雙聲道音訊並等它結束；過程中回報進度 */
  async playStereo(st: Stereo, onProgress?: (p: number) => void): Promise<void> {
    const ctx = this.audio();
    const buf = ctx.createBuffer(2, st.left.length, ctx.sampleRate);
    buf.copyToChannel(st.left as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(st.right as Float32Array<ArrayBuffer>, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.source = src;
    const t0 = ctx.currentTime;
    const dur = buf.duration;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => onProgress?.(Math.min(1, (ctx.currentTime - t0) / dur)), 100);
      src.onended = () => {
        clearInterval(timer);
        resolve();
      };
      src.start();
    });
    this.source = null;
  }

  private emit(): void {
    this.onChange(this.state);
  }

  private setPhase(job: BroadcastJob, phase: Phase, progress: number): void {
    this.current = { job, phase, progress };
    this.emit();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      this.stopRequested = false;
      this.notice = null;
      try {
        await this.playJob(job);
        this.onDone(job);
      } catch (e) {
        this.onDone(job, e instanceof Error ? e : new Error(String(e)));
      }
      this.current = null;
      this.emit();
    }
    this.busy = false;
  }

  private async playJob(job: BroadcastJob): Promise<void> {
    const ctx = this.audio();
    const fs = ctx.sampleRate;
    let built: ReturnType<typeof buildSignal>;
    try {
      built = buildSignal(job, fs);
    } catch (e) {
      if (e instanceof LeakageError) this.leakage = e.report;
      throw e;
    }
    this.leakage = built.leakage;
    const { signal } = built;
    // 1. 叮咚＋第一次高頻訊號
    let st = mixInto(null, signal, job.route, 0);
    if (job.chime && !job.silent) st = mixInto(st, chime(fs), job.route, 0);
    this.setPhase(job, 'signal', 0);
    await this.playStereo(st, (p) => this.setPhase(job, 'signal', p));
    if (this.stopRequested) return;
    // 2. 語音廣播
    let spoke = false;
    if (job.speech && !job.silent) {
      this.setPhase(job, 'speech', 0);
      const r: SpeakResult = await speak(job.speech, 'zh-TW');
      spoke = r === 'done';
      if (r === 'no-voice') this.notice = '找不到中文（zh-TW）語音，已略過語音廣播';
      else if (r === 'unsupported') this.notice = '這個瀏覽器不支援語音合成，已略過語音廣播';
      if (this.stopRequested) return;
    }
    // 3. 重送
    if (job.repeats < 2) return;
    if (!spoke) {
      this.setPhase(job, 'gap', 0);
      await sleep(1000);
      if (this.stopRequested) return;
    }
    this.setPhase(job, 'repeat', 0);
    await this.playStereo(mixInto(null, signal, job.route, 0), (p) => this.setPhase(job, 'repeat', p));
  }
}
