import { resampleChunks } from "@/lib/edit";
import { encodeM4a } from "@/lib/m4a";
import { encodeMp3 } from "@/lib/mp3";
import { wavChunks } from "@/lib/wav";

type Kind = "wav" | "mp3" | "m4a";

const cancelled = new Set<number>();

function postProgress(id: number, progress: number) {
  self.postMessage({ id, progress });
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as {
    id?: number;
    kind: Kind | "cancel";
    samples?: Float32Array;
    right?: Float32Array;
    sampleRate?: number;
    targetRate?: number;
    bitrate?: number;
    dualMono?: boolean;
  };
  if (data.kind === "cancel" && data.id != null) {
    cancelled.add(data.id);
    return;
  }
  if (data.kind !== "wav" && data.kind !== "mp3" && data.kind !== "m4a") return;
  const id = data.id ?? 0;
  const samples = data.samples;
  const sampleRate = data.sampleRate ?? 44100;
  if (!samples) return;
  void run(id, data.kind, samples, sampleRate, data.right, data.targetRate, data.bitrate, data.dualMono === true);
};

async function run(
  id: number,
  kind: Kind,
  samples: Float32Array,
  sampleRate: number,
  right?: Float32Array,
  targetRate?: number,
  bitrate?: number,
  dualMono = false,
) {
  const rate = targetRate === 44100 || targetRate === 48000 ? targetRate : sampleRate;
  const stopped = () => cancelled.has(id);
  const left = await resampleChunks(samples, sampleRate, rate, {
    cancelled: stopped,
    progress: (ratio) => postProgress(id, ratio * 0.2),
  });
  if (!left) return;
  const other = right
    ? await resampleChunks(right, sampleRate, rate, {
        cancelled: stopped,
        progress: (ratio) => postProgress(id, 0.2 + ratio * 0.1),
      })
    : undefined;
  if (right && !other) return;
  const hooks = {
    progress: (ratio: number) => postProgress(id, 0.3 + ratio * 0.7),
    cancelled: stopped,
    bitrate,
    right: other ?? undefined,
    dualMono,
  };
  try {
    if (kind === "wav") {
      const blob = await wavChunks(other ? [left, other] : dualMono ? [left, left] : [left], rate, {
        cancelled: stopped,
        progress: (ratio) => postProgress(id, 0.3 + ratio * 0.7),
      });
      if (!blob || stopped()) return;
      const buffer = await blob.arrayBuffer();
      if (stopped()) return;
      postProgress(id, 1);
      self.postMessage({ id, ok: true, buffer, mime: "audio/wav" }, { transfer: [buffer] });
      return;
    }
    if (kind === "mp3") {
      const bytes = await encodeMp3(left, rate, hooks);
      if (!bytes || hooks.cancelled()) return;
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      self.postMessage({ id, ok: true, buffer, mime: "audio/mpeg" }, { transfer: [buffer] });
      return;
    }
    const buffer = await encodeM4a(left, rate, hooks);
    if (!buffer || hooks.cancelled()) return;
    self.postMessage({ id, ok: true, buffer, mime: "audio/mp4" }, { transfer: [buffer] });
  } catch (err) {
    if (cancelled.has(id)) return;
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : "export" });
  } finally {
    cancelled.delete(id);
  }
}
