/**
 * Reed-Solomon 錯誤更正碼（GF(256)、本原多項式 0x11d、fcr = 0、generator α = 2）。
 *
 * 編碼：在訊息後面加上 nsym 個檢查位元組，產生的碼字 c(x) 會被生成多項式
 *   g(x) = (x − α^0)(x − α^1)…(x − α^(nsym−1)) 整除。
 * 解碼：
 *   1. 計算 syndrome S_i = r(α^i)；全為 0 表示沒有錯誤。
 *   2. 若有抹除（已知位置、未知數值的錯誤），先用 Forney syndrome 把抹除的影響消掉。
 *   3. Berlekamp-Massey 找出錯誤定位多項式。
 *   4. Chien search 找出錯誤位置（必須全部落在碼字長度內，否則判定無法修正）。
 *   5. Forney 演算法算出每個錯誤（含抹除）的數值並修正。
 *   6. 修正後重新計算 syndrome，不為 0 就丟棄，避免「修成錯的」。
 * 修正能力：2 × 錯誤數 + 抹除數 ≤ nsym。
 *
 * 實作參考 Wikiversity「Reed–Solomon codes for coders」的演算法架構，以 TypeScript 重寫，
 * 並修正其中抹除＋錯誤混合時的容量檢查。
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mod255 = (a: number): number => ((a % 255) + 255) % 255;

/** GF(256) 乘法 */
export const gfMul = (x: number, y: number): number => (x === 0 || y === 0 ? 0 : EXP[LOG[x] + LOG[y]]);
/** GF(256) 除法 */
export const gfDiv = (x: number, y: number): number => {
  if (y === 0) throw new Error('GF 除以 0');
  return x === 0 ? 0 : EXP[mod255(LOG[x] + 255 - LOG[y])];
};
/** GF(256) 次方（x ≠ 0，p 可為負數） */
export const gfPow = (x: number, p: number): number => EXP[mod255(LOG[x] * p)];
/** GF(256) 乘法反元素 */
export const gfInv = (x: number): number => EXP[255 - LOG[x]];

type Poly = number[];

const polyScale = (p: Poly, x: number): Poly => p.map((c) => gfMul(c, x));
const polyAdd = (p: Poly, q: Poly): Poly => {
  const n = Math.max(p.length, q.length);
  const r = new Array<number>(n).fill(0);
  for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
  return r;
};
const polyMul = (p: Poly, q: Poly): Poly => {
  const r = new Array<number>(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= gfMul(p[i], q[j]);
  return r;
};
/** 以 Horner 法求多項式在 x 的值（係數由高次到低次） */
const polyEval = (p: Poly, x: number): number => {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
  return y;
};
const polyDiv = (a: Poly, b: Poly): [Poly, Poly] => {
  const o = a.slice();
  for (let i = 0; i < a.length - (b.length - 1); i++) {
    const c = o[i];
    if (c !== 0) for (let j = 1; j < b.length; j++) if (b[j] !== 0) o[i + j] ^= gfMul(b[j], c);
  }
  const s = o.length - (b.length - 1);
  return [o.slice(0, s), o.slice(s)];
};

const genCache = new Map<number, Poly>();
/** 生成多項式 g(x) = Π (x − α^i)，i = 0..nsym−1 */
export function generatorPoly(nsym: number): Poly {
  const hit = genCache.get(nsym);
  if (hit) return hit;
  let g: Poly = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, gfPow(2, i)]);
  genCache.set(nsym, g);
  return g;
}

/**
 * RS 編碼：回傳「原訊息 + nsym 個檢查位元組」。
 * @param msg 原始位元組（長度 + nsym 不可超過 255）
 * @param nsym 檢查位元組數
 */
export function rsEncode(msg: ArrayLike<number>, nsym: number): number[] {
  if (msg.length + nsym > 255) throw new Error('訊息太長');
  const g = generatorPoly(nsym);
  const out = Array.from(msg).concat(new Array<number>(nsym).fill(0));
  for (let i = 0; i < msg.length; i++) {
    const c = out[i];
    if (c !== 0) for (let j = 1; j < g.length; j++) out[i + j] ^= gfMul(g[j], c);
  }
  for (let i = 0; i < msg.length; i++) out[i] = msg[i];
  return out;
}

/** 計算 syndrome（第 0 項固定補 0，與參考實作的索引一致） */
function syndromes(msg: Poly, nsym: number): Poly {
  const s: Poly = [0];
  for (let i = 0; i < nsym; i++) s.push(polyEval(msg, gfPow(2, i)));
  return s;
}

/** 由已知錯誤位置（以碼字反向索引表示）建立錯誤定位多項式 Λ(x) = Π (1 − X_i x) */
function errataLocator(coefPos: number[]): Poly {
  let e: Poly = [1];
  for (const i of coefPos) e = polyMul(e, polyAdd([1], [gfPow(2, i), 0]));
  return e;
}

/** 錯誤數值多項式 Ω(x) = S(x)Λ(x) mod x^(n+1) */
function errorEvaluator(s: Poly, errLoc: Poly, n: number): Poly {
  return polyDiv(polyMul(s, errLoc), [1].concat(new Array<number>(n + 1).fill(0)))[1];
}

/** Forney 演算法：已知所有錯誤（含抹除）的位置，算出數值並修正 */
function correctErrata(msg: Poly, synd: Poly, pos: number[]): Poly {
  const coefPos = pos.map((p) => msg.length - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = errorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).reverse();
  const X = coefPos.map((c) => gfPow(2, c));
  const E = new Array<number>(msg.length).fill(0);
  const evalRev = errEval.slice().reverse();
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = gfInv(Xi);
    let locPrime = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) locPrime = gfMul(locPrime, 1 ^ gfMul(XiInv, X[j]));
    if (locPrime === 0) throw new Error('Forney 失敗');
    const y = gfMul(Xi, polyEval(evalRev, XiInv));
    E[pos[i]] = gfDiv(y, locPrime);
  }
  return polyAdd(msg, E);
}

/** Forney syndrome：把抹除位置的影響從 syndrome 中消去，剩下的只反映未知錯誤 */
function forneySyndromes(synd: Poly, erasePos: number[], nmess: number): Poly {
  const fsynd = synd.slice(1);
  for (const p of erasePos) {
    const x = gfPow(2, nmess - 1 - p);
    for (let j = 0; j < fsynd.length - 1; j++) fsynd[j] = gfMul(fsynd[j], x) ^ fsynd[j + 1];
  }
  return fsynd;
}

/**
 * Berlekamp-Massey：由（Forney）syndrome 求錯誤定位多項式。
 * @param synd syndrome（不含第 0 個補位）
 * @param iterations 迭代次數 = nsym − 抹除數
 */
function errorLocator(synd: Poly, iterations: number): Poly {
  let errLoc: Poly = [1];
  let oldLoc: Poly = [1];
  for (let i = 0; i < iterations; i++) {
    const K = i;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length && K - j >= 0; j++)
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  return errLoc;
}

/** Chien search：逐一代入找出錯誤位置；找到的根數必須等於多項式次數 */
function findErrors(errLocRev: Poly, nmess: number): number[] | null {
  const errs = errLocRev.length - 1;
  const pos: number[] = [];
  for (let i = 0; i < nmess; i++) if (polyEval(errLocRev, gfPow(2, i)) === 0) pos.push(nmess - 1 - i);
  return pos.length === errs ? pos : null;
}

export interface RsDecodeResult {
  /** 修正後的原訊息（不含檢查位元組） */
  data: number[];
  /** 實際被改動的位元組數（錯誤＋抹除中數值真的不同者） */
  fixed: number;
  /** 解碼時找到的未知錯誤數 */
  errors: number;
  /** 使用的抹除數 */
  erasures: number;
}

export interface RsDecodeOptions {
  /** 抹除位置（碼字索引，0 起算） */
  erasures?: number[];
  /**
   * 保留的偵錯餘量：要求 2e + f ≤ nsym − reserve。
   * 0 = 用盡全部更正能力；數值越大，「修成錯的」機率越低。
   */
  reserve?: number;
}

/** 解碼失敗時丟出的錯誤 */
export class RsError extends Error {}

/**
 * RS 解碼（支援抹除）。
 * @param codeword 收到的碼字（訊息 + nsym 個檢查位元組）
 * @param nsym 檢查位元組數
 * @param opts 抹除位置與偵錯餘量
 * @throws RsError 錯誤超過更正能力或驗證失敗
 */
export function rsDecode(
  codeword: ArrayLike<number>,
  nsym: number,
  opts: RsDecodeOptions = {},
): RsDecodeResult {
  const erasePos = opts.erasures ?? [];
  const reserve = opts.reserve ?? 0;
  const received = Array.from(codeword);
  const msg = received.slice();
  if (erasePos.length > nsym - reserve) throw new RsError('抹除數太多');
  for (const p of erasePos) msg[p] = 0;
  let synd = syndromes(msg, nsym);
  let errPos: number[] = [];
  if (Math.max(...synd) !== 0) {
    const fsynd = forneySyndromes(synd, erasePos, msg.length);
    const errLoc = errorLocator(fsynd, nsym - erasePos.length);
    const errs = errLoc.length - 1;
    if (2 * errs + erasePos.length > nsym - reserve) throw new RsError('錯誤太多，超過更正能力');
    if (errs > 0) {
      const found = findErrors(errLoc.slice().reverse(), msg.length);
      if (!found) throw new RsError('無法定位錯誤');
      errPos = found;
    }
    const all = erasePos.concat(errPos);
    if (all.length > 0) {
      const out = correctErrata(msg, synd, all);
      synd = syndromes(out, nsym);
      if (Math.max(...synd) !== 0) throw new RsError('修正後驗證失敗');
      for (let i = 0; i < out.length; i++) msg[i] = out[i];
    } else {
      throw new RsError('syndrome 不為 0 但找不到錯誤');
    }
  }
  let fixed = 0;
  for (let i = 0; i < msg.length; i++) if (msg[i] !== received[i]) fixed++;
  return { data: msg.slice(0, msg.length - nsym), fixed, errors: errPos.length, erasures: erasePos.length };
}
