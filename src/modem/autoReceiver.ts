/**
 * 自動偵測頻段（AutoReceiver）。
 *
 * 車站喇叭的高頻表現各不相同，站務端會依現場選擇頻段與模式；乘客手機無法回傳，所以由接收端自己找：
 *   1. 掃描：8 組候選設定（4 個頻段 × 標準／穩定）共用一個 16 秒環形緩衝區，每組只算 6 個頻道
 *      （同步音 A、B 與 4 個參考頻道），以這 6 個頻道的總功率正規化。
 *      ⚠ 不可用整個高頻段的總能量正規化：強寬頻噪音下成功率會從 22/24 掉到 0/24。
 *   2. 鎖定：第一則成功解碼後只保留該組，切回完整模式（18 頻道）。
 *   3. 重新掃描：鎖定後 60 秒沒有成功解碼、且接收器處於搜尋狀態時，回到 8 組掃描。
 * 輸入先經過兩級 Butterworth 高通（14.5 kHz），去掉人聲與列車噪音。
 * 也支援手動指定頻段（manual）。
 */
import { SampleBuffer, SpectrumCache } from './buffer.ts';
import { AUTO, BASELINE_OPTIONS, CANDIDATES, type ModemConfig, type RxOptions } from './config.ts';
import { biquadHighpass, type SampleFilter } from './dsp.ts';
import { Receiver, type HopInfo, type RxEvent, type RxStats } from './receiver.ts';

export interface AutoReceiverInit {
  /** 候選設定（預設 8 組） */
  candidates?: readonly ModemConfig[];
  /** 手動指定設定：只跑這一組、不掃描 */
  manual?: ModemConfig;
  opts?: Partial<RxOptions>;
  /** 鎖定後多久沒成功就重新掃描（秒） */
  relockSec?: number;
  onEvent?: (e: RxEvent) => void;
  onHop?: (h: HopInfo) => void;
  /** 鎖定設定改變時（null = 掃描中） */
  onLock?: (cfg: ModemConfig | null) => void;
}

export class AutoReceiver {
  readonly fs: number;
  readonly buffer: SampleBuffer;
  readonly spectra: SpectrumCache;
  readonly stats: RxStats = { ok: 0, fail: 0, combined: 0 };
  readonly opts: RxOptions;
  /** 目前鎖定的設定（null = 掃描中） */
  locked: ModemConfig | null = null;
  receivers: Receiver[] = [];

  private readonly cands: readonly ModemConfig[];
  private readonly manual: ModemConfig | null;
  private readonly relock: number;
  private readonly hp: SampleFilter[];
  private readonly onEvent: (e: RxEvent) => void;
  private readonly onHop: (h: HopInfo) => void;
  private readonly onLock: (cfg: ModemConfig | null) => void;
  private pending = -1;
  private lastOk = 0;
  private scores: number[] = [];

  /**
   * @param fs 取樣率
   * @param init 候選設定、優化選項與回呼
   */
  constructor(fs: number, init: AutoReceiverInit = {}) {
    this.fs = fs;
    this.cands = init.candidates ?? CANDIDATES;
    this.manual = init.manual ?? null;
    this.opts = { ...BASELINE_OPTIONS, ...init.opts };
    this.relock = (init.relockSec ?? AUTO.relockSec) * fs;
    this.onEvent = init.onEvent ?? (() => {});
    this.onHop = init.onHop ?? (() => {});
    this.onLock = init.onLock ?? (() => {});
    this.buffer = new SampleBuffer(fs);
    this.spectra = new SpectrumCache(this.buffer, fs);
    this.hp = [biquadHighpass(fs, AUTO.highpassHz), biquadHighpass(fs, AUTO.highpassHz)];
    if (this.manual) {
      this.receivers = [this.make(this.manual, 0, false)];
      this.locked = this.manual;
    } else {
      this.scanAll();
    }
  }

  /** 是否在掃描 */
  get scanning(): boolean {
    return this.locked === null;
  }

  private make(c: ModemConfig, i: number, scan: boolean): Receiver {
    return new Receiver(this.fs, {
      cfg: c,
      opts: this.opts,
      buffer: this.buffer,
      spectra: this.spectra,
      scan,
      onEvent: (e) => this.handle(i, e),
      onHop: (h) => this.level(i, h),
    });
  }

  /** 回到 8 組掃描 */
  scanAll(): void {
    if (this.manual) return;
    this.locked = null;
    this.pending = -1;
    this.receivers = this.cands.map((c, i) => this.make(c, i, true));
    this.scores = this.cands.map(() => 0);
    this.onLock(null);
  }

  private handle(i: number, e: RxEvent): void {
    if (e.ok) {
      this.stats.ok++;
      if (e.combined) this.stats.combined++;
      this.lastOk = this.buffer.total;
      if (this.locked === null && this.pending < 0) this.pending = i;
    } else {
      this.stats.fail++;
    }
    this.onEvent(e);
  }

  private level(i: number, h: HopInfo): void {
    if (this.locked) {
      this.onHop(h);
      return;
    }
    this.scores[i] = h.score;
    if (i === 0) this.onHop({ ...h, powers: null, score: Math.max(...this.scores) });
  }

  /** 推入麥克風樣本 */
  push(chunk: ArrayLike<number>): void {
    const [h1, h2] = this.hp;
    this.buffer.write(chunk, (v) => h2(h1(v)));
    for (const r of this.receivers) r.run();
    if (this.pending >= 0) {
      const i = this.pending;
      this.pending = -1;
      const r = this.receivers.find((x) => x.cfg === this.cands[i]) ?? this.receivers[i];
      r.setFullMode();
      this.receivers = [r];
      this.locked = this.cands[i];
      this.onLock(this.locked);
    } else if (
      !this.manual &&
      this.locked &&
      this.buffer.total - this.lastOk > this.relock &&
      this.receivers[0].state === 'search'
    ) {
      this.scanAll();
    }
  }
}
