import { findPhrases } from "@/lib/phrases";
import { wavFromPcm } from "@/lib/wav";

export type Pcm = { samples: Float32Array; sampleRate: number };

export type EditOp =
  | { kind: "trim"; start: number; end: number }
  | { kind: "drop"; start: number; end: number }
  | { kind: "gain"; gain: number }
  | { kind: "fadeIn"; seconds: number }
  | { kind: "fadeOut"; seconds: number }
  | { kind: "append"; samples: Float32Array; sampleRate: number }
  | { kind: "swap"; a0: number; a1: number; b0: number; b1: number }
  | { kind: "insert"; at: number; samples: Float32Array; sampleRate: number }
  | { kind: "tighten"; gap: number }
  | { kind: "replace"; samples: Float32Array; sampleRate: number };

export function applyOps(source: Pcm, ops: EditOp[]): Pcm {
  return ops.reduce(applyOne, source);
}

function applyOne(pcm: Pcm, op: EditOp): Pcm {
  if (op.kind === "trim") {
    const length = pcm.samples.length;
    const start = clampIndex(Math.round(op.start * length), length);
    const end = clampIndex(Math.round(op.end * length), length);
    return { samples: pcm.samples.slice(start, Math.max(start + 1, Math.min(length, end))), sampleRate: pcm.sampleRate };
  }
  if (op.kind === "drop") {
    const length = pcm.samples.length;
    const start = clampIndex(Math.round(op.start * length), length);
    const end = clampIndex(Math.round(op.end * length), length);
    if (end <= start) return pcm;
    const next = new Float32Array(length - (end - start));
    next.set(pcm.samples.subarray(0, start), 0);
    next.set(pcm.samples.subarray(end), start);
    softenEdge(next, start, pcm.sampleRate);
    return { samples: next, sampleRate: pcm.sampleRate };
  }
  if (op.kind === "gain") {
    const next = new Float32Array(pcm.samples.length);
    for (let i = 0; i < next.length; i++) {
      let value = (pcm.samples[i] ?? 0) * op.gain;
      if (value > 0.98) value = 0.98 + Math.tanh(value - 0.98) * 0.015;
      else if (value < -0.98) value = -0.98 + Math.tanh(value + 0.98) * 0.015;
      next[i] = value;
    }
    return { samples: next, sampleRate: pcm.sampleRate };
  }
  if (op.kind === "fadeIn" || op.kind === "fadeOut") {
    const next = new Float32Array(pcm.samples);
    const span = Math.min(next.length, Math.round(op.seconds * pcm.sampleRate));
    if (span <= 1) return { samples: next, sampleRate: pcm.sampleRate };
    for (let i = 0; i < span; i++) {
      const ramp = Math.sin((i / (span - 1)) * (Math.PI / 2));
      if (op.kind === "fadeIn") next[i] = (next[i] ?? 0) * ramp;
      else next[next.length - 1 - i] = (next[next.length - 1 - i] ?? 0) * ramp;
    }
    return { samples: next, sampleRate: pcm.sampleRate };
  }
  if (op.kind === "swap") {
    const length = pcm.samples.length;
    let a0 = clampIndex(Math.round(Math.min(op.a0, op.b0) * length), length);
    let a1 = clampIndex(Math.round(Math.min(op.a1, op.b1) * length), length);
    let b0 = clampIndex(Math.round(Math.max(op.a0, op.b0) * length), length);
    let b1 = clampIndex(Math.round(Math.max(op.a1, op.b1) * length), length);
    if (a1 > b0) a1 = b0;
    if (b1 <= b0 || a1 <= a0) return pcm;
    const head = pcm.samples.subarray(0, a0);
    const left = pcm.samples.subarray(a0, a1);
    const mid = pcm.samples.subarray(a1, b0);
    const right = pcm.samples.subarray(b0, b1);
    const tail = pcm.samples.subarray(b1);
    const next = new Float32Array(length);
    let offset = 0;
    next.set(head, offset);
    offset += head.length;
    next.set(right, offset);
    offset += right.length;
    next.set(mid, offset);
    offset += mid.length;
    next.set(left, offset);
    offset += left.length;
    next.set(tail, offset);
    return { samples: next, sampleRate: pcm.sampleRate };
  }
  if (op.kind === "insert") {
    const extra = resample(op.samples, op.sampleRate, pcm.sampleRate);
    if (!extra.length) return pcm;
    const at = clampIndex(Math.round(Math.min(1, Math.max(0, op.at)) * pcm.samples.length), pcm.samples.length);
    const next = new Float32Array(pcm.samples.length + extra.length);
    next.set(pcm.samples.subarray(0, at), 0);
    next.set(extra, at);
    next.set(pcm.samples.subarray(at), at + extra.length);
    return { samples: next, sampleRate: pcm.sampleRate };
  }
  if (op.kind === "tighten") {
    const phrases = findPhrases(pcm.samples, pcm.sampleRate);
    if (phrases.length < 2) return pcm;
    const gap = Math.max(0.05, op.gap) * pcm.sampleRate;
    const parts: Float32Array[] = [];
    let total = 0;
    for (let index = 0; index < phrases.length; index++) {
      const phrase = phrases[index];
      if (!phrase) continue;
      const start = clampIndex(Math.round(phrase.start * pcm.samples.length), pcm.samples.length);
      const end = clampIndex(Math.round(phrase.end * pcm.samples.length), pcm.samples.length);
      if (end <= start) continue;
      const speech = pcm.samples.subarray(start, end);
      parts.push(speech);
      total += speech.length;
      const nextPhrase = phrases[index + 1];
      if (!nextPhrase) continue;
      const nextStart = clampIndex(Math.floor(nextPhrase.start * pcm.samples.length), pcm.samples.length);
      const hole = nextStart - end;
      const keep = Math.min(hole, Math.round(gap));
      if (keep > 8) {
        const from = end + Math.floor((hole - keep) / 2);
        const bed = pcm.samples.subarray(from, from + keep);
        parts.push(bed);
        total += bed.length;
      }
    }
    if (total < 2) return pcm;
    const fade = Math.min(Math.round(pcm.sampleRate * 0.01), Math.floor(gap / 3));
    let frames = 0;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part) continue;
      frames += part.length;
      if (index > 0) frames -= Math.min(fade, Math.floor(part.length / 2), Math.floor((parts[index - 1]?.length ?? 0) / 2));
    }
    const next = new Float32Array(Math.max(1, frames));
    let offset = 0;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part?.length) continue;
      if (offset === 0) {
        next.set(part.subarray(0, Math.min(part.length, next.length)));
        offset = part.length;
        continue;
      }
      const blend = Math.min(fade, Math.floor(offset / 2), Math.floor(part.length / 2));
      if (blend >= 2) {
        for (let i = 0; i < blend; i++) {
          const gain = i / (blend - 1);
          const at = offset - blend + i;
          next[at] = (next[at] ?? 0) * (1 - gain) + (part[i] ?? 0) * gain;
        }
        const rest = part.subarray(blend);
        const room = Math.min(rest.length, next.length - offset);
        if (room > 0) next.set(rest.subarray(0, room), offset);
        offset += rest.length;
      } else {
        const room = Math.min(part.length, next.length - offset);
        if (room > 0) next.set(part.subarray(0, room), offset);
        offset += part.length;
      }
    }
    return { samples: next.subarray(0, Math.max(1, Math.min(next.length, offset))), sampleRate: pcm.sampleRate };
  }
  if (op.kind === "replace") {
    const samples = resample(op.samples, op.sampleRate, pcm.sampleRate);
    if (samples.length < 2) return pcm;
    return { samples, sampleRate: pcm.sampleRate };
  }
  const extra = resample(op.samples, op.sampleRate, pcm.sampleRate);
  if (!extra.length) return pcm;
  const next = new Float32Array(pcm.samples.length + extra.length);
  next.set(pcm.samples, 0);
  next.set(extra, pcm.samples.length);
  return { samples: next, sampleRate: pcm.sampleRate };
}

function softenEdge(samples: Float32Array, at: number, rate: number) {
  const n = Math.min(Math.round(rate * 0.0015), Math.floor(at), samples.length - at);
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const gain = i / (n - 1);
    const left = at - 1 - i;
    if (left >= 0) samples[left] = (samples[left] ?? 0) * gain;
    const right = at + i;
    if (right < samples.length) samples[right] = (samples[right] ?? 0) * gain;
  }
}

function clampIndex(value: number, length: number) {
  return Math.max(0, Math.min(length, value));
}

function clampSample(value: number) {
  return Math.max(-1, Math.min(1, value));
}

function quietWindow(samples: Float32Array, need: number) {
  const size = Math.max(8, Math.min(samples.length, need));
  if (samples.length <= size) return samples.subarray(0, size);
  const hop = Math.max(1, Math.floor(size / 3));
  const found: { at: number; rough: number }[] = [];
  for (let i = 0; i + size <= samples.length; i += hop) {
    let sum = 0;
    for (let j = i; j < i + size; j += 8) sum += (samples[j] ?? 0) ** 2;
    found.push({ at: i, rough: sum });
  }
  found.sort((a, b) => a.rough - b.rough);
  let bestAt = found[0]?.at ?? 0;
  let best = Infinity;
  for (const cand of found.slice(0, 6)) {
    const from = Math.max(0, cand.at - hop);
    const to = Math.min(samples.length - size, cand.at + hop);
    const step = Math.max(1, Math.floor(hop / 6));
    for (let i = from; i <= to; i += step) {
      let sum = 0;
      let peak = 0;
      for (let j = i; j < i + size; j++) {
        const value = samples[j] ?? 0;
        sum += value * value;
        const level = Math.abs(value);
        if (level > peak) peak = level;
      }
      const cost = sum + (peak > 0.2 ? peak * peak * size : 0);
      if (cost < best) {
        best = cost;
        bestAt = i;
      }
    }
  }
  return samples.subarray(bestAt, bestAt + size);
}

export function roomSlice(pcm: Pcm, seconds = 0.4): Pcm {
  const need = Math.max(8, Math.round(Math.max(0.05, seconds) * pcm.sampleRate));
  const window = quietWindow(pcm.samples, need);
  return { samples: window.slice(), sampleRate: pcm.sampleRate };
}

export function peakOf(samples: Float32Array) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 4) {
    const level = Math.abs(samples[i] ?? 0);
    if (level > peak) peak = level;
  }
  return peak;
}

export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!input.length) return input;
  if (fromRate === toRate) return input.slice();
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(length);
  fillResample(input, out);
  return out;
}

export async function resampleChunks(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  hooks?: { progress?: (ratio: number) => void; cancelled?: () => boolean },
): Promise<Float32Array | null> {
  if (!input.length) return input;
  if (fromRate === toRate) return input;
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const block = 65536;
  for (let start = 0; start < length; start += block) {
    if (hooks?.cancelled?.()) return null;
    fillResample(input, out, start, Math.min(length, start + block));
    hooks?.progress?.(start / length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  hooks?.progress?.(1);
  return out;
}

function fillResample(input: Float32Array, out: Float32Array, from = 0, to = out.length) {
  const scale = (input.length - 1) / Math.max(1, out.length - 1);
  const last = input.length - 1;
  for (let i = from; i < to; i++) {
    const x = i * scale;
    const index = Math.floor(x);
    const t = x - index;
    const a = input[Math.max(0, index - 1)] ?? 0;
    const b = input[index] ?? 0;
    const c = input[Math.min(last, index + 1)] ?? b;
    const d = input[Math.min(last, index + 2)] ?? c;
    const t2 = t * t;
    const t3 = t2 * t;
    out[i] =
      0.5 *
      (2 * b +
        (-a + c) * t +
        (2 * a - 5 * b + 4 * c - d) * t2 +
        (-a + 3 * b - 3 * c + d) * t3);
  }
}

export function slicePcm(pcm: Pcm, start: number, end: number): Pcm {
  return applyOne(pcm, { kind: "trim", start, end });
}

export function peaksFromPcm(samples: Float32Array, bars = 42): number[] {
  if (!samples.length) return [];
  const block = Math.max(1, Math.floor(samples.length / bars));
  const peaks: number[] = [];
  for (let i = 0; i < bars; i++) {
    let max = 0;
    const from = i * block;
    const to = Math.min(samples.length, from + block);
    const step = Math.max(1, Math.floor((to - from) / 240));
    for (let j = from; j < to; j += step) {
      const value = Math.abs(samples[j] ?? 0);
      if (value > max) max = value;
    }
    peaks.push(max);
  }
  const top = Math.max(...peaks, 0.001);
  return peaks.map((peak) => Math.min(1, peak / top));
}

export function pcmToWav(pcm: Pcm): Blob {
  const pcm16 = new Int16Array(pcm.samples.length);
  for (let i = 0; i < pcm16.length; i++) {
    const sample = clampSample(pcm.samples[i] ?? 0);
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return wavFromPcm(pcm16, pcm.sampleRate);
}

export function pcmDuration(pcm: Pcm): number {
  if (!pcm.sampleRate) return 0;
  return (pcm.samples.length / pcm.sampleRate) * 1000;
}

export async function decodePcm(blob: Blob): Promise<Pcm> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("no-audio");
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0));
    const samples = new Float32Array(audio.length);
    const channels = audio.numberOfChannels;
    for (let channel = 0; channel < channels; channel++) {
      const data = audio.getChannelData(channel);
      for (let i = 0; i < audio.length; i++) samples[i] += (data[i] ?? 0) / channels;
    }
    return { samples, sampleRate: audio.sampleRate };
  } finally {
    await ctx.close();
  }
}

export async function decodeChannels(blob: Blob, mode: "all" | "mono" | "stereo" = "all"): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("no-audio");
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0));
    if (mode === "mono") {
      const mixed = new Float32Array(audio.length);
      const count = audio.numberOfChannels;
      for (let channel = 0; channel < count; channel++) {
        const data = audio.getChannelData(channel);
        for (let i = 0; i < audio.length; i++) mixed[i] += (data[i] ?? 0) / count;
      }
      return { channels: [mixed], sampleRate: audio.sampleRate };
    }
    const channels: Float32Array[] = [];
    const limit = mode === "stereo" ? Math.min(2, audio.numberOfChannels) : audio.numberOfChannels;
    for (let channel = 0; channel < limit; channel++) channels.push(audio.getChannelData(channel).slice());
    return { channels, sampleRate: audio.sampleRate };
  } finally {
    await ctx.close();
  }
}
