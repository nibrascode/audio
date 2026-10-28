export type ExportFormat = "wav" | "mp3" | "m4a";
export type ExportRate = 44100 | 48000;

type Pending = {
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
  onProgress: (ratio: number) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/audio.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as { id: number; progress?: number; ok?: boolean; buffer?: ArrayBuffer; mime?: string; error?: string };
    const job = pending.get(data.id);
    if (!job) return;
    if (typeof data.progress === "number") job.onProgress(data.progress);
    if (data.ok === true && data.buffer) {
      pending.delete(data.id);
      job.resolve(new Blob([data.buffer], { type: data.mime || "application/octet-stream" }));
    } else if (data.ok === false) {
      pending.delete(data.id);
      job.reject(new Error(data.error || "export"));
    }
  };
  worker.onerror = () => {
    for (const job of pending.values()) job.reject(new Error("export"));
    pending.clear();
  };
  return worker;
}

export function encodeInBackground(
  samples: Float32Array,
  sampleRate: number,
  format: ExportFormat,
  onProgress: (ratio: number) => void,
  options?: { targetRate?: ExportRate; bitrate?: number; right?: Float32Array; dualMono?: boolean; transfer?: boolean },
) {
  const id = nextId++;
  const copy = options?.transfer ? samples : samples.slice();
  const right = options?.right ? (options.transfer ? options.right : options.right.slice()) : undefined;
  const done = new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    const transfer: Transferable[] = [copy.buffer];
    if (right && right.buffer !== copy.buffer) transfer.push(right.buffer);
    getWorker().postMessage(
      { id, kind: format, samples: copy, right, dualMono: options?.dualMono, sampleRate, targetRate: options?.targetRate, bitrate: options?.bitrate },
      transfer,
    );
  });
  return {
    done,
    cancel() {
      const job = pending.get(id);
      pending.delete(id);
      worker?.postMessage({ kind: "cancel", id });
      job?.reject(new Error("cancelled"));
    },
  };
}
