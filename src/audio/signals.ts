/**
 * 站務端與診斷頁用的音訊產生器：叮咚提示音、掃頻、單一頻率音、WAV 編碼、雙聲道組合。
 * 純函式，不依賴 DOM，可在 Node 測試。
 */

/**
 * 叮咚提示音（E5 → C5，與 PoC 相同）。
 * @param fs 取樣率
 * @param gain 音量
 */
export function chime(fs: number, gain = 0.22): Float32Array {
  const n = Math.round(fs * 1.4);
  const y = new Float32Array(n);
  for (const [f, t0] of [
    [659.25, 0],
    [523.25, 0.55],
  ]) {
    const s = Math.round(t0 * fs);
    const L = Math.round(0.85 * fs);
    for (let i = 0; i < L && s + i < n; i++) {
      const t = i / fs;
      const e = Math.min(1, i / (0.005 * fs)) * Math.exp(-4 * t);
      y[s + i] += gain * e * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t));
    }
  }
  return y;
}

/**
 * 線性掃頻（相位連續），前後 50 ms 淡入淡出。診斷頁用來量測喇叭＋麥克風的頻率響應。
 * @param f1 起始頻率
 * @param f2 結束頻率
 * @param sec 長度（秒）
 */
export function sweep(fs: number, f1: number, f2: number, sec: number, amp: number): Float32Array {
  const n = Math.round(fs * sec);
  const y = new Float32Array(n);
  const fade = Math.round(0.05 * fs);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f1 + ((f2 - f1) * i) / n;
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    y[i] = amp * Math.sin(ph) * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, env)));
    ph += (2 * Math.PI * f) / fs;
  }
  return y;
}

/** 單一頻率音（前後 50 ms 淡入淡出） */
export function tone(fs: number, f: number, sec: number, amp: number): Float32Array {
  const n = Math.round(fs * sec);
  const y = new Float32Array(n);
  const fade = Math.round(0.05 * fs);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    y[i] = amp * Math.sin((2 * Math.PI * f * i) / fs) * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, env)));
  }
  return y;
}

/** 輸出聲道：left、right、both */
export type Route = 'left' | 'right' | 'both';

/** 雙聲道音訊 */
export interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

/**
 * 把單聲道訊號依路由放到雙聲道，並在 offset（樣本）處開始；長度不足會自動延長。
 */
export function mixInto(dst: Stereo | null, x: Float32Array, route: Route, offset = 0): Stereo {
  const need = offset + x.length;
  let out = dst;
  if (!out || out.left.length < need) {
    const n = Math.max(need, out?.left.length ?? 0);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    if (out) {
      left.set(out.left);
      right.set(out.right);
    }
    out = { left, right };
  }
  for (let i = 0; i < x.length; i++) {
    if (route !== 'right') out.left[offset + i] += x[i];
    if (route !== 'left') out.right[offset + i] += x[i];
  }
  return out;
}

/**
 * 編碼為 16-bit PCM WAV。
 * @param channels 各聲道樣本（長度相同）
 */
export function encodeWav(channels: Float32Array[], fs: number): Uint8Array {
  const nCh = channels.length;
  const n = channels[0].length;
  const dataBytes = n * nCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * nCh * 2, true);
  v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  return new Uint8Array(buf);
}

/** 解碼 16-bit PCM WAV（測試與 E2E 用） */
export function decodeWav(bytes: Uint8Array): { fs: number; channels: Float32Array[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nCh = v.getUint16(22, true);
  const fs = v.getUint32(24, true);
  let o = 12;
  while (o < bytes.length - 8) {
    const id = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const size = v.getUint32(o + 4, true);
    if (id === 'data') {
      const n = size / 2 / nCh;
      const ch = Array.from({ length: nCh }, () => new Float32Array(n));
      for (let i = 0; i < n; i++)
        for (let c = 0; c < nCh; c++) ch[c][i] = v.getInt16(o + 8 + (i * nCh + c) * 2, true) / 0x8000;
      return { fs, channels: ch };
    }
    o += 8 + size;
  }
  throw new Error('WAV 沒有 data 區塊');
}
