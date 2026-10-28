import { createFxChain, mergeFx, prepareBuffer, type Fx } from "@/lib/fx";
import { streamSlice } from "@/lib/stream";

export type TrackKind = "voice" | "music" | "fx";

export const TRACKS: TrackKind[] = ["voice", "music", "fx"];

export type Clip = {
  id: string;
  audioId: string;
  name: string;
  kind: TrackKind;
  startMs: number;
  offsetMs: number;
  durationMs: number;
  sourceMs: number;
  gain: number;
  peaks: number[];
  fx?: Fx;
};

export type Session = {
  id: string;
  clips: Clip[];
  zoom: number;
  updatedAt: number;
};

export const MIX_BLOCK_MS = 8000;
export const MIX_WARM_MS = 700;

export function mixSpan(startMs: number, lengthMs: number, blockMs = MIX_BLOCK_MS, warmMs = MIX_WARM_MS) {
  const warm = startMs <= 0 ? 0 : Math.min(warmMs, startMs);
  const from = startMs - warm;
  const until = Math.min(lengthMs, startMs + blockMs);
  return { from, until, skipMs: warm, keepMs: Math.max(0, until - startMs) };
}

export function mixPlan(lengthMs: number, blockMs = MIX_BLOCK_MS) {
  const pieces: { start: number; keepMs: number }[] = [];
  for (let start = 0; start < lengthMs; start += blockMs) {
    pieces.push({ start, keepMs: mixSpan(start, lengthMs, blockMs).keepMs });
  }
  return pieces;
}

export function timelineEnd(clips: Clip[]) {
  return clips.reduce((max, clip) => Math.max(max, clip.startMs + clip.durationMs), 0);
}

export function shiftClip(clip: Clip, mode: "move" | "left" | "right", deltaMs: number): Clip {
  if (mode === "move") return { ...clip, startMs: Math.max(0, Math.round(clip.startMs + deltaMs)) };
  if (mode === "right") {
    const durationMs = Math.round(Math.min(clip.sourceMs - clip.offsetMs, Math.max(80, clip.durationMs + deltaMs)));
    return { ...clip, durationMs };
  }
  let delta = deltaMs;
  if (clip.offsetMs + delta < 0) delta = -clip.offsetMs;
  if (clip.startMs + delta < 0) delta = -clip.startMs;
  if (clip.durationMs - delta < 80) delta = clip.durationMs - 80;
  return {
    ...clip,
    startMs: Math.round(clip.startMs + delta),
    offsetMs: Math.round(clip.offsetMs + delta),
    durationMs: Math.round(clip.durationMs - delta),
  };
}

export function splitClip(clip: Clip, atMs: number): [Clip, Clip] | null {
  const local = atMs - clip.startMs;
  if (local < 80 || clip.durationMs - local < 80) return null;
  const rightId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${clip.id}-b`;
  return [
    { ...clip, durationMs: Math.round(local) },
    {
      ...clip,
      id: rightId,
      startMs: Math.round(atMs),
      offsetMs: Math.round(clip.offsetMs + local),
      durationMs: Math.round(clip.durationMs - local),
    },
  ];
}

export async function renderMix(
  clips: Clip[],
  getBlob: (id: string) => Promise<Blob | null>,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const tail = clips.some((clip) => (clip.fx?.echo ?? 0) > 0 || (clip.fx?.reverb ?? 0) > 0) ? 1400 : 0;
  const lengthMs = Math.max(timelineEnd(clips) + tail, 1);
  const stereo = clips.some((clip) => mergeFx(clip.fx).channels === "stereo");
  const rate = 48000;
  const channels = stereo ? 2 : 1;
  const pieces: Int16Array[] = [];
  const plan = mixPlan(lengthMs);
  for (let index = 0; index < plan.length; index++) {
    const piece = plan[index];
    if (!piece) continue;
    const span = mixSpan(piece.start, lengthMs);
    const spanMs = Math.max(1, span.until - span.from);
    const hits = clips.filter((clip) => {
      const audibleUntil = clip.startMs + clip.durationMs + tail;
      return audibleUntil > span.from && clip.startMs < span.until;
    });
    const keepFrames = Math.max(1, Math.round((span.keepMs / 1000) * rate));
    if (!hits.length) {
      pieces.push(new Int16Array(keepFrames * channels));
      onProgress?.(Math.min(0.9, piece.start / lengthMs));
      continue;
    }
    const offline = new OfflineAudioContext(channels, Math.max(1, Math.ceil((spanMs / 1000) * rate)), rate);
    for (const clip of hits) {
      const blob = await getBlob(clip.audioId);
      if (!blob) continue;
      const localFrom = Math.max(0, span.from - clip.startMs);
      const localTo = Math.min(clip.durationMs, span.until - clip.startMs);
      if (localTo - localFrom < 1 && clip.startMs >= span.from) continue;
      const sourceFrom = clip.sourceMs ? (clip.offsetMs + Math.max(0, localFrom)) / clip.sourceMs : 0;
      const sourceTo = clip.sourceMs ? (clip.offsetMs + Math.max(localFrom, localTo)) / clip.sourceMs : 1;
      const fx = mergeFx(clip.fx);
      const slice = localTo > localFrom ? await streamSlice(blob, Math.max(0, sourceFrom), Math.min(1, sourceTo)) : null;
      let buffer: AudioBuffer;
      let bufferOffsetMs = 0;
      let bufferDurationMs = Math.max(1, localTo - localFrom);
      if (slice && slice.samples.length > 8) {
        buffer = offline.createBuffer(1, slice.samples.length, slice.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < slice.samples.length; i++) data[i] = (slice.samples[i] ?? 0) / 32768;
        if (channels === 2) {
          const stereoBuffer = offline.createBuffer(2, buffer.length, buffer.sampleRate);
          stereoBuffer.copyToChannel(data, 0);
          stereoBuffer.copyToChannel(data, 1);
          buffer = stereoBuffer;
        }
        bufferDurationMs = buffer.duration * 1000;
      } else {
        const audio = await offline.decodeAudioData((await blob.arrayBuffer()).slice(0));
        buffer = audio;
        bufferOffsetMs = Math.max(0, clip.offsetMs + localFrom);
        bufferDurationMs = Math.max(1, localTo - localFrom);
      }
      const prepared = await prepareBuffer(offline, buffer, bufferOffsetMs, bufferDurationMs, fx);
      const source = offline.createBufferSource();
      source.buffer = prepared.buffer;
      source.playbackRate.value = prepared.rate;
      const chain = createFxChain(offline, offline.destination, fx, clip.gain);
      source.connect(chain.input);
      source.start(Math.max(0, (clip.startMs - span.from) / 1000));
    }
    onProgress?.(lengthMs ? Math.min(0.9, piece.start / lengthMs) : 1);
    const rendered = await offline.startRendering();
    const skip = Math.min(rendered.length, Math.round((span.skipMs / 1000) * rendered.sampleRate));
    const keep = Math.max(0, Math.min(Math.round((span.keepMs / 1000) * rendered.sampleRate), rendered.length - skip));
    const pcm = new Int16Array(Math.max(keep, 1) * channels);
    for (let i = 0; i < keep; i++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = Math.max(-1, Math.min(1, rendered.getChannelData(channel)[skip + i] ?? 0));
        pcm[i * channels + channel] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
    }
    pieces.push(pcm);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!pieces.length) throw new Error("empty");
  let frames = 0;
  for (const piece of pieces) frames += piece.length / channels;
  const dataBytes = frames * channels * 2;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const mark = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  mark(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  mark(8, "WAVE");
  mark(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  mark(36, "data");
  view.setUint32(40, dataBytes, true);
  const bodies = pieces.map((part) => {
    const copy = new Uint8Array(part.byteLength);
    copy.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
    return copy;
  });
  onProgress?.(1);
  return new Blob([header, ...bodies], { type: "audio/wav" });
}
