import { Mp3Encoder } from "@breezystack/lamejs";
import { resample } from "@/lib/edit";

const MPEG_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

function mpegRate(rate: number) {
  let best = 44100;
  let distance = Number.POSITIVE_INFINITY;
  for (const item of MPEG_RATES) {
    const next = Math.abs(item - rate);
    if (next < distance) {
      distance = next;
      best = item;
    }
  }
  return best;
}

export async function encodeMp3(
  samples: Float32Array,
  sampleRate: number,
  hooks?: { progress?: (ratio: number) => void; cancelled?: () => boolean; bitrate?: number; right?: Float32Array; dualMono?: boolean },
): Promise<Uint8Array | null> {
  const rate = mpegRate(sampleRate);
  const left = rate === sampleRate ? samples : resample(samples, sampleRate, rate);
  const right = hooks?.right ? (rate === sampleRate ? hooks.right : resample(hooks.right, sampleRate, rate)) : null;
  const stereo = Boolean(right || hooks?.dualMono);
  const kbps = hooks?.bitrate && hooks.bitrate >= 96 && hooks.bitrate <= 320 ? hooks.bitrate : 128;
  const encoder = new Mp3Encoder(stereo ? 2 : 1, rate, kbps);
  const block = 1152;
  const parts: Uint8Array[] = [];
  let bytes = 0;
  const to16 = (input: Float32Array, start: number, count: number) => {
    const frame = new Int16Array(count);
    for (let j = 0; j < count; j++) {
      const sample = Math.max(-1, Math.min(1, input[start + j] ?? 0));
      frame[j] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return frame;
  };
  for (let i = 0; i < left.length; i += block) {
    if (hooks?.cancelled?.()) return null;
    const count = Math.min(block, left.length - i);
    const frame = to16(left, i, count);
    const encoded = right ? encoder.encodeBuffer(frame, to16(right, i, count)) : hooks?.dualMono ? encoder.encodeBuffer(frame, frame) : encoder.encodeBuffer(frame);
    if (encoded.length) {
      parts.push(encoded);
      bytes += encoded.length;
    }
    if (i % (block * 48) === 0) {
      hooks?.progress?.(left.length ? i / left.length : 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (hooks?.cancelled?.()) return null;
  const tail = encoder.flush();
  if (tail.length) {
    parts.push(tail);
    bytes += tail.length;
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  hooks?.progress?.(1);
  return output;
}
