import { decodeChannels } from "@/lib/edit";
import { streamWindows } from "@/lib/stream";

const CHUNK_SECONDS = 1;

type WavInfo = { channels: number; rate: number; bits: number; dataOffset: number; dataBytes: number };

function text(view: DataView, offset: number, length: number) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

function parseWav(buffer: ArrayBuffer): WavInfo | null {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44 || text(view, 0, 4) !== "RIFF" || text(view, 8, 4) !== "WAVE") return null;
  let offset = 12;
  let channels = 1;
  let rate = 44100;
  let bits = 16;
  while (offset + 8 <= view.byteLength) {
    const id = text(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 24 <= view.byteLength) {
      channels = view.getUint16(offset + 10, true) || 1;
      rate = view.getUint32(offset + 12, true) || 44100;
      bits = view.getUint16(offset + 22, true) || 16;
    }
    if (id === "data") return { channels, rate, bits, dataOffset: offset + 8, dataBytes: size };
    offset += 8 + size + (size % 2);
  }
  return null;
}

function monoFrom(view: DataView, info: WavInfo, frames: number) {
  const width = info.bits / 8;
  const stride = info.channels * width;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let channel = 0; channel < info.channels; channel++) {
      const offset = i * stride + channel * width;
      if (info.bits === 16) sum += view.getInt16(offset, true) / 32768;
      else if (info.bits === 32) sum += view.getFloat32(offset, true);
      else sum += (view.getUint8(offset) - 128) / 128;
    }
    out[i] = sum / info.channels;
  }
  return out;
}

async function* readMono(blob: Blob): AsyncGenerator<{ samples: Float32Array; sampleRate: number; ratio: number; last: boolean }> {
  let streamed = false;
  for await (const window of streamWindows(blob)) {
    streamed = true;
    yield window;
  }
  if (streamed) return;
  const decoded = await decodeChannels(blob, "mono");
  const samples = decoded.channels[0] ?? new Float32Array();
  const block = Math.max(1, decoded.sampleRate * CHUNK_SECONDS);
  if (!samples.length) return;
  for (let offset = 0; offset < samples.length; offset += block) {
    const end = Math.min(samples.length, offset + block);
    yield {
      samples: samples.subarray(offset, end),
      sampleRate: decoded.sampleRate,
      ratio: end / samples.length,
      last: end >= samples.length,
    };
  }
}

function wavHeader(frames: number, sampleRate: number) {
  const dataBytes = frames * 2;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const mark = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  mark(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  mark(8, "WAVE");
  mark(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  mark(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

export function denoiseBlob(blob: Blob, amount: number, onProgress: (ratio: number) => void) {
  const id = Math.floor(Math.random() * 1e9);
  let worker: Worker | null = new Worker(new URL("../workers/denoise.worker.ts", import.meta.url), { type: "module" });
  let stopped = false;
  let rejectWait: ((err: Error) => void) | null = null;
  const done = (async () => {
    const parts: ArrayBuffer[] = [];
    const peaks: number[] = [];
    let frames = 0;
    let rate = 48000;
    for await (const chunk of readMono(blob)) {
      if (stopped) throw new Error("cancelled");
      if (!chunk.samples.length) continue;
      rate = chunk.sampleRate;
      const copy = chunk.samples.slice();
      const pcm = await new Promise<ArrayBuffer>((resolve, reject) => {
        rejectWait = reject;
        const onMessage = (event: MessageEvent) => {
          const data = event.data as { id?: number; ok?: boolean; pcm?: ArrayBuffer; error?: string };
          if (data.id !== id) return;
          worker?.removeEventListener("message", onMessage);
          rejectWait = null;
          if (data.ok && data.pcm) resolve(data.pcm);
          else reject(new Error(data.error || "denoise"));
        };
        worker?.addEventListener("message", onMessage);
        worker?.postMessage({ kind: "chunk", id, samples: copy, sampleRate: chunk.sampleRate, amount, last: chunk.last }, [copy.buffer]);
      });
      if (stopped) throw new Error("cancelled");
      const view = new Int16Array(pcm);
      let peak = 0;
      for (let i = 0; i < view.length; i += 32) peak = Math.max(peak, Math.abs(view[i] ?? 0) / 32768);
      peaks.push(peak);
      parts.push(pcm);
      frames += view.length;
      onProgress(Math.max(0.02, chunk.ratio));
    }
    if (!frames) throw new Error("empty");
    return { blob: new Blob([wavHeader(frames, rate), ...parts], { type: "audio/wav" }), sampleRate: rate, frames, peaks };
  })();
  return {
    done,
    cancel() {
      stopped = true;
      rejectWait?.(new Error("cancelled"));
      worker?.terminate();
      worker = null;
    },
  };
}
