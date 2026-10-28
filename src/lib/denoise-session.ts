import createRNNWasmModuleSync from "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js";
import { isLightDevice } from "@/lib/device";

const FRAME = 480;
const MODEL_RATE = 48000;

type Rnnoise = {
  _rnnoise_create: () => number;
  _rnnoise_destroy: (state: number) => void;
  _rnnoise_process_frame: (state: number, outPtr: number, inPtr: number) => number;
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
};

let modulePromise: Promise<Rnnoise> | null = null;

function loadModule() {
  modulePromise ??= createRNNWasmModuleSync() as Promise<Rnnoise>;
  return modulePromise;
}

class StreamResample {
  private hold = new Float32Array(0);
  private pos = 0;
  private readonly from: number;
  private readonly to: number;

  constructor(from: number, to: number) {
    this.from = from;
    this.to = to;
  }

  process(input: Float32Array, last: boolean) {
    if (!input.length && !this.hold.length) return input;
    if (this.from === this.to) return input;
    const data = new Float32Array(this.hold.length + input.length);
    data.set(this.hold);
    data.set(input, this.hold.length);
    const step = this.from / this.to;
    const maxOut = Math.max(0, Math.floor((Math.max(0, data.length - 1) - this.pos) / step));
    const out = new Float32Array(maxOut + (last ? 1 : 0));
    let pos = this.pos;
    let written = 0;
    while (written < maxOut && pos + 1 < data.length) {
      const index = Math.floor(pos);
      const mix = pos - index;
      const a = data[Math.max(0, index - 1)] ?? 0;
      const b = data[index] ?? 0;
      const c = data[Math.min(data.length - 1, index + 1)] ?? b;
      const d = data[Math.min(data.length - 1, index + 2)] ?? c;
      const t = mix;
      const t2 = t * t;
      const t3 = t2 * t;
      out[written] =
        0.5 *
        (2 * b +
          (-a + c) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (-a + 3 * b - 3 * c + d) * t3);
      written += 1;
      pos += step;
    }
    const keep = Math.min(data.length, Math.max(0, Math.floor(pos)));
    this.hold = data.slice(keep);
    this.pos = pos - keep;
    if (last && this.hold.length) {
      out[written] = this.hold[this.hold.length - 1] ?? 0;
      written += 1;
      this.hold = new Float32Array(0);
      this.pos = 0;
    }
    return out.subarray(0, written);
  }
}

export type DenoiseSession = {
  push: (samples: Float32Array, last: boolean) => Int16Array;
  close: () => void;
};

export async function createDenoiseSession(sampleRate: number, amount: number): Promise<DenoiseSession> {
  const mod = await loadModule();
  const state = mod._rnnoise_create();
  const second = !isLightDevice() && amount >= 0.7 ? mod._rnnoise_create() : 0;
  const ptr = mod._malloc(FRAME * 4);
  const wet = Math.max(0, Math.min(1, amount));
  const up = new StreamResample(sampleRate, MODEL_RATE);
  const down = new StreamResample(MODEL_RATE, sampleRate);
  let rest = new Float32Array(0);
  let closed = false;
  let smooth = 0;
  let warmed = 0;

  function denoise(input: Float32Array, last: boolean) {
    const data = new Float32Array(rest.length + input.length);
    data.set(rest);
    data.set(input, rest.length);
    const whole = Math.floor(data.length / FRAME);
    const frames = last ? Math.ceil(data.length / FRAME) : whole;
    const out = new Float32Array(frames * FRAME);
    const base = ptr >> 2;
    for (let frame = 0; frame < frames; frame++) {
      const offset = frame * FRAME;
      const heap = mod.HEAPF32.subarray(base, base + FRAME);
      for (let i = 0; i < FRAME; i++) heap[i] = (data[offset + i] ?? 0) * 32768;
      const voiceRaw = Number(mod._rnnoise_process_frame(state, ptr, ptr));
      const voice = Number.isFinite(voiceRaw) ? Math.max(0, Math.min(1, voiceRaw)) : 0;
      if (warmed < 2) {
        warmed += 1;
        for (let i = 0; i < FRAME; i++) out[offset + i] = data[offset + i] ?? 0;
        continue;
      }
      const protect = voice * voice;
      const target = Math.min(1, wet * (wet < 0.5 ? 1 : 1.2)) * (1 - protect * 0.9);
      smooth += (target - smooth) * 0.35;
      const nextHeap = mod.HEAPF32.subarray(base, base + FRAME);
      for (let i = 0; i < FRAME; i++) {
        const dry = data[offset + i] ?? 0;
        const cleaned = Math.max(-1, Math.min(1, (nextHeap[i] ?? 0) / 32768));
        out[offset + i] = dry * (1 - smooth) + cleaned * smooth;
      }
      if (second && voice < 0.5) {
        const again = mod.HEAPF32.subarray(base, base + FRAME);
        for (let i = 0; i < FRAME; i++) again[i] = (out[offset + i] ?? 0) * 32768;
        mod._rnnoise_process_frame(second, ptr, ptr);
        const secondHeap = mod.HEAPF32.subarray(base, base + FRAME);
        const extra = wet * (1 - voice);
        for (let i = 0; i < FRAME; i++) {
          const current = out[offset + i] ?? 0;
          const cleaned = Math.max(-1, Math.min(1, (secondHeap[i] ?? 0) / 32768));
          out[offset + i] = current * (1 - extra) + cleaned * extra;
        }
      } else if (second) {
        const keep = mod.HEAPF32.subarray(base, base + FRAME);
        for (let i = 0; i < FRAME; i++) keep[i] = (out[offset + i] ?? 0) * 32768;
        mod._rnnoise_process_frame(second, ptr, ptr);
      }
    }
    if (last) {
      rest = new Float32Array(0);
      return out.subarray(0, data.length);
    }
    rest = data.slice(whole * FRAME);
    return out.subarray(0, whole * FRAME);
  }

  return {
    push(samples, last) {
      if (closed) return new Int16Array();
      const model = up.process(samples, last);
      const cleaned = denoise(model, last);
      const back = down.process(cleaned, last);
      const pcm = new Int16Array(back.length);
      for (let i = 0; i < back.length; i++) {
        const sample = Math.max(-1, Math.min(1, back[i] ?? 0));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      return pcm;
    },
    close() {
      if (closed) return;
      closed = true;
      mod._free(ptr);
      mod._rnnoise_destroy(state);
      if (second) mod._rnnoise_destroy(second);
    },
  };
}
