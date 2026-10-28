import { createDenoiseSession, type DenoiseSession } from "@/lib/denoise-session";

type InMessage =
  | { kind: "chunk"; id: number; samples: Float32Array; sampleRate: number; amount: number; last: boolean }
  | { kind: "cancel"; id: number };

let session: DenoiseSession | null = null;
let sessionKey = "";
const cancelled = new Set<number>();

self.onmessage = (event: MessageEvent<InMessage>) => {
  const data = event.data;
  if (data.kind === "cancel") {
    cancelled.add(data.id);
    session?.close();
    session = null;
    sessionKey = "";
    return;
  }
  void run(data);
};

async function run(data: Extract<InMessage, { kind: "chunk" }>) {
  if (cancelled.has(data.id)) return;
  try {
    const key = `${data.sampleRate}:${data.amount}`;
    if (!session || sessionKey !== key) {
      session?.close();
      session = await createDenoiseSession(data.sampleRate, data.amount);
      sessionKey = key;
    }
    if (cancelled.has(data.id)) return;
    const pcm = session.push(data.samples, data.last);
    if (cancelled.has(data.id)) return;
    const copy = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    if (data.last) {
      session.close();
      session = null;
      sessionKey = "";
    }
    self.postMessage({ id: data.id, ok: true, pcm: copy, last: data.last }, { transfer: [copy] });
  } catch (err) {
    session?.close();
    session = null;
    sessionKey = "";
    self.postMessage({ id: data.id, ok: false, error: err instanceof Error ? err.message : "denoise" });
  }
}
