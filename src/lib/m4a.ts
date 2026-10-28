import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { AAC_FRAME, packAacFrames } from "@/lib/aac-pack";

export async function canExportM4a() {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    const result = await AudioEncoder.isConfigSupported({
      codec: "mp4a.40.2",
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 128_000,
    });
    return result.supported === true;
  } catch {
    return false;
  }
}

export async function encodeM4a(
  samples: Float32Array,
  sampleRate: number,
  hooks?: { progress?: (ratio: number) => void; cancelled?: () => boolean; bitrate?: number; right?: Float32Array; dualMono?: boolean },
): Promise<ArrayBuffer | null> {
  if (typeof AudioEncoder === "undefined") throw new Error("unsupported");
  const channels = hooks?.right || hooks?.dualMono ? 2 : 1;
  const bitrate = (hooks?.bitrate && hooks.bitrate >= 96 ? hooks.bitrate : 128) * 1000;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    audio: { codec: "aac", numberOfChannels: channels, sampleRate },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let failed: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (err) => {
      failed = err instanceof Error ? err : new Error(String(err));
    },
  });
  encoder.configure({
    codec: "mp4a.40.2",
    numberOfChannels: channels,
    sampleRate,
    bitrate,
  });
  const packed = packAacFrames(samples, hooks?.right, hooks?.dualMono === true);
  const frame = AAC_FRAME;
  for (let index = 0; index < packed.frames.length; index++) {
    if (hooks?.cancelled?.() || failed) return null;
    const copy = packed.frames[index];
    if (!copy) continue;
    const local = new Float32Array(copy.length);
    local.set(copy);
    const data = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: frame,
      numberOfChannels: packed.channels,
      timestamp: Math.round((index * frame / sampleRate) * 1_000_000),
      data: local,
    });
    encoder.encode(data);
    data.close();
    if (encoder.encodeQueueSize > 8) {
      hooks?.progress?.(packed.frames.length ? index / packed.frames.length : 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (hooks?.cancelled?.() || failed) return null;
  await encoder.flush();
  if (failed) throw failed;
  muxer.finalize();
  hooks?.progress?.(1);
  return target.buffer;
}
