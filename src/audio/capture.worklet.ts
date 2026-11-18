/**
 * AudioWorklet：在音訊執行緒擷取麥克風樣本，每 2048 個樣本打包送到主執行緒（再轉給 DSP Worker）。
 * 這裡不做任何運算，避免音訊執行緒卡頓。
 */

// AudioWorkletGlobalScope 的型別（TypeScript 的 DOM lib 沒有內建）
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

const CHUNK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(CHUNK);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === CHUNK) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(CHUNK);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('hb-capture', CaptureProcessor);
