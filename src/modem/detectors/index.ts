/**
 * 符號判定（SymbolDetector）。
 *
 * 這是預留給未來 AI 解調器的擴充點（README 6.1）：本版用「Goertzel 功率＋最大值判定」，
 * 未來可以換成以實際錄音資料訓練的神經網路，只要實作同一個介面即可。
 */

/** 一個資料符號的判定結果 */
export interface SymbolDecision {
  /** 判定的 nibble（0～15） */
  value: number;
  /** 第二可能的 nibble（重送合併、Chase 解碼可用） */
  second: number;
  /** 信心值 = 最大功率 / 第二大功率（≥ 1），越大越可靠 */
  confidence: number;
}

/** 符號判定器介面 */
export interface SymbolDetector {
  readonly name: string;
  /**
   * 由 16 個資料頻道的功率（或其他特徵）判定符號。
   * @param powers 長度 16，index = nibble
   */
  decide(powers: ArrayLike<number>): SymbolDecision;
}

/** 本版實作：取功率最大的頻道，並以「最大／第二大」作為軟判決信心值 */
export class MaxPowerDetector implements SymbolDetector {
  readonly name = 'max-power';

  decide(powers: ArrayLike<number>): SymbolDecision {
    let b = 0;
    let s = -1;
    for (let i = 1; i < powers.length; i++) {
      if (powers[i] > powers[b]) {
        s = b;
        b = i;
      } else if (s < 0 || powers[i] > powers[s]) {
        s = i;
      }
    }
    if (s < 0) s = b === 0 ? 1 : 0;
    const confidence = powers[b] / Math.max(powers[s], 1e-30);
    return { value: b, second: s, confidence };
  }
}

export const defaultDetector: SymbolDetector = new MaxPowerDetector();
