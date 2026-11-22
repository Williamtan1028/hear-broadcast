/**
 * 重送合併（diversity combining，3.5.2）。
 *
 * 站務端預設把同一則廣播（相同 seq）送兩次。若兩次都無法單獨解碼，就把兩次對應符號的
 * 16 個資料頻道功率（各自先正規化成總和 1，避免音量不同時其中一次主導）相加後再判定一次。
 * 噪音獨立、訊號相同，相加後訊噪比約提高 3 dB；多路徑造成的頻道衰落（fading）在兩次之間
 * 也不相同（20 kHz 波長只有 1.7 cm，手持手機些微移動就會改變），所以同時得到「分集增益」。
 *
 * 配對方式：解碼失敗的封包讀不到 seq，因此
 *   - 兩次 header 都正確：len 必須相同。
 *   - 任一次 header 壞掉：把兩次的 header 符號功率相加後再判定長度。
 * 合併後一定要通過 RS 驗證；長度是猜出來的時候保留偵錯餘量，配錯的組合會被 RS 擋下。
 */
import { NOISE } from './config.ts';

/** 失敗封包需要的最小資訊（Demod 的子集） */
export interface DemodLike {
  p: number;
  /** 每個符號的 18 頻道功率 */
  syms: Float64Array[];
}

/** 暫存的失敗封包 */
export interface FailedEntry<D extends DemodLike = DemodLike> {
  d: D;
  /** header 解出的長度；null = header 壞掉 */
  len: number | null;
  /** 長度是否靠軟判決猜出 */
  lenSoft: boolean;
  /** 前導碼對齊品質（4 個前導碼符號目標音占比之和，0～4） */
  quality: number;
}

/** 把一組功率正規化成總和 1 */
export function normalizePowers(p: ArrayLike<number>): Float64Array {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i];
  const out = new Float64Array(p.length);
  const inv = 1 / (s + 1e-30);
  for (let i = 0; i < p.length; i++) out[i] = p[i] * inv;
  return out;
}

/** 把兩次的符號功率（已正規化）逐一相加 */
export function combineSymbols(a: Float64Array[], b: Float64Array[]): Float64Array[] {
  const n = Math.min(a.length, b.length);
  const out: Float64Array[] = [];
  for (let j = 0; j < n; j++) {
    const s = new Float64Array(a[j].length);
    for (let i = 0; i < s.length; i++) s[i] = a[j][i] + b[j][i];
    out.push(s);
  }
  return out;
}

/**
 * 失敗封包暫存區：保留時間窗內品質最好的幾個。
 * 純噪音造成的假觸發品質很低，不會把真正的失敗封包擠掉。
 */
export class CombiningStore<D extends DemodLike = DemodLike> {
  private entries: FailedEntry<D>[] = [];

  /**
   * @param fs 取樣率
   * @param windowSec 兩次傳送的最大間隔（秒）
   * @param maxEntries 最多保留幾個
   */
  constructor(
    private readonly fs: number,
    private readonly windowSec: number = NOISE.combineWindowSec,
    private readonly maxEntries: number = NOISE.combineMaxEntries,
  ) {}

  /** 移除過期的封包 */
  private expire(now: number): void {
    const limit = this.windowSec * this.fs;
    this.entries = this.entries.filter((e) => now - e.d.p <= limit);
  }

  /** 存入失敗封包（品質不足的不存） */
  put(e: FailedEntry<D>): void {
    if (e.quality < NOISE.combineMinQuality) return;
    this.expire(e.d.p);
    this.entries.push(e);
    this.entries.sort((x, y) => y.quality - x.quality);
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
  }

  /** 可以與起點為 now 的封包合併的候選（品質由高到低） */
  candidates(now: number): FailedEntry<D>[] {
    this.expire(now);
    return this.entries.filter((e) => e.d.p < now);
  }

  /** 目前暫存的所有失敗封包（不做過期處理） */
  all(): FailedEntry<D>[] {
    return this.entries.slice();
  }

  remove(d: D): void {
    this.entries = this.entries.filter((e) => e.d !== d);
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}
