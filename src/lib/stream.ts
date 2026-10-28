export type WavInfo = {
  rate: number;
  channels: number;
  dataStart: number;
  frames: number;
};

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG1_RATE = [44100, 48000, 32000];
const MPEG2_RATE = [22050, 24000, 16000];
const MPEG25_RATE = [11025, 12000, 8000];

type Mp3Frame = { offset: number; size: number; samples: number; rate: number; channels: number };

function text(view: DataView, offset: number, length: number) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

export function parseWav(buffer: ArrayBuffer, fileSize = buffer.byteLength): WavInfo | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  if (text(view, 0, 4) !== "RIFF" || text(view, 8, 4) !== "WAVE") return null;
  let offset = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let dataStart = 0;
  let dataBytes = 0;
  while (offset + 8 <= view.byteLength) {
    const id = text(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 8 + 16 <= view.byteLength) {
      channels = view.getUint16(offset + 8 + 2, true);
      rate = view.getUint32(offset + 8 + 4, true);
      bits = view.getUint16(offset + 8 + 14, true);
    }
    if (id === "data") {
      dataStart = offset + 8;
      dataBytes = size;
      break;
    }
    const step = 8 + size + (size % 2);
    if (step <= 0) return null;
    offset += step;
    if (id !== "fmt " && offset > buffer.byteLength) return null;
    if (offset > 1024 * 1024) return null;
  }
  if (!rate || !channels || bits !== 16 || !dataStart) return null;
  const bytesPerFrame = channels * 2;
  const available = Math.max(0, fileSize - dataStart);
  const bytes = dataBytes > 0 ? Math.min(dataBytes, available) : available;
  return { rate, channels, dataStart, frames: Math.floor(bytes / bytesPerFrame) };
}

export function wavWindow(view: DataView, info: WavInfo, startFrame: number, frames: number) {
  const out = new Float32Array(frames);
  const base = info.dataStart + startFrame * info.channels * 2;
  const read = (frame: number, channel: number) => {
    const at = base + (frame * info.channels + channel) * 2;
    if (at + 1 >= view.byteLength) return 0;
    return view.getInt16(at, true) / 32768;
  };
  if (info.channels < 2) {
    for (let i = 0; i < frames; i++) out[i] = read(i, 0);
    return out;
  }
  let mid = 0;
  let side = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  const step = Math.max(1, Math.floor(frames / 2000));
  for (let i = 0; i < frames; i += step) {
    const left = read(i, 0);
    const right = read(i, 1);
    mid += (left + right) * (left + right);
    side += (left - right) * (left - right);
    leftEnergy += left * left;
    rightEnergy += right * right;
  }
  const louder = leftEnergy >= rightEnergy ? 0 : 1;
  const cancelled = side > mid * 3;
  for (let i = 0; i < frames; i++) {
    if (cancelled) {
      out[i] = read(i, louder);
      continue;
    }
    let sum = 0;
    for (let channel = 0; channel < info.channels; channel++) sum += read(i, channel);
    out[i] = sum / info.channels;
  }
  return out;
}

export function parseMp3(bytes: Uint8Array): Mp3Frame[] {
  let offset = 0;
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + size;
  }
  const frames: Mp3Frame[] = [];
  while (offset + 4 < bytes.length && frames.length < 2_000_000) {
    const b0 = bytes[offset] ?? 0;
    const b1 = bytes[offset + 1] ?? 0;
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    if (layer !== 1 || version === 1) {
      offset += 1;
      continue;
    }
    const b2 = bytes[offset + 2] ?? 0;
    const bitrateIndex = (b2 >> 4) & 15;
    const rateIndex = (b2 >> 2) & 3;
    const padding = (b2 >> 1) & 1;
    const table = version === 3 ? MPEG1_L3 : MPEG2_L3;
    const bitrate = (table[bitrateIndex] ?? 0) * 1000;
    const rates = version === 3 ? MPEG1_RATE : version === 2 ? MPEG2_RATE : MPEG25_RATE;
    const rate = rates[rateIndex] ?? 0;
    if (!bitrate || !rate) {
      offset += 1;
      continue;
    }
    const samples = version === 3 ? 1152 : 576;
    const size = Math.floor((samples / 8) * bitrate / rate) + padding;
    if (size < 4 || offset + size > bytes.length) break;
    const channels = ((bytes[offset + 3] ?? 0) >> 6) === 3 ? 1 : 2;
    frames.push({ offset, size, samples, rate, channels });
    offset += size;
  }
  return frames;
}

export function clipFrame(samples: Float32Array, at: number, from: number, to: number) {
  const start = Math.max(0, from - at);
  const end = Math.min(samples.length, to - at);
  if (end <= start) return null;
  return samples.subarray(start, end);
}

function toInt16(samples: Float32Array) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

async function wavBytes(blob: Blob) {
  const head = await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer();
  const info = parseWav(head, blob.size);
  if (!info) return null;
  return { info, head };
}

export async function streamPeaks(blob: Blob, bars = 1000): Promise<number[] | null> {
  const wav = await wavBytes(blob);
  if (wav && wav.info.frames > 0) {
    const { info } = wav;
    const peaks = new Array<number>(bars).fill(0);
    const chunk = info.rate * 2;
    for (let frame = 0; frame < info.frames; frame += chunk) {
      const count = Math.min(chunk, info.frames - frame);
      const bytes = await blob.slice(info.dataStart + frame * info.channels * 2, info.dataStart + (frame + count) * info.channels * 2).arrayBuffer();
      const view = new DataView(bytes);
      const local = { ...info, dataStart: 0 };
      const samples = wavWindow(view, local, 0, count);
      for (let i = 0; i < samples.length; i++) {
        const at = frame + i;
        const bar = Math.min(bars - 1, Math.floor((at / info.frames) * bars));
        const value = Math.abs(samples[i] ?? 0);
        if (value > (peaks[bar] ?? 0)) peaks[bar] = value;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const top = Math.max(...peaks, 0.001);
    return peaks.map((value) => Math.min(1, value / top));
  }
  return mp3Peaks(blob, bars).then((peaks) => peaks ?? m4aPeaks(blob, bars));
}

export async function streamEnergies(blob: Blob): Promise<number[] | null> {
  const wav = await wavBytes(blob);
  if (!wav || wav.info.frames <= 0) return null;
  const { info } = wav;
  const frame = Math.max(1, Math.round(info.rate * 0.01));
  const energies: number[] = [];
  const chunk = info.rate * 2;
  for (let start = 0; start < info.frames; start += chunk) {
    const count = Math.min(chunk, info.frames - start);
    const bytes = await blob.slice(info.dataStart + start * info.channels * 2, info.dataStart + (start + count) * info.channels * 2).arrayBuffer();
    const samples = wavWindow(new DataView(bytes), { ...info, dataStart: 0 }, 0, count);
    for (let i = 0; i < samples.length; i += frame) {
      let sum = 0;
      let seen = 0;
      const end = Math.min(samples.length, i + frame);
      for (let j = i; j < end; j++) {
        const value = samples[j] ?? 0;
        sum += value * value;
        seen += 1;
      }
      energies.push(Math.sqrt(sum / Math.max(1, seen)));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return energies.length ? energies : null;
}

export async function streamPhrases(blob: Blob): Promise<{ start: number; end: number }[] | null> {
  const { phrasesFromEnergy } = await import("@/lib/phrases");
  const wav = await wavBytes(blob);
  if (wav && wav.info.frames > 0) {
    const { info } = wav;
    const energies: number[] = [];
    const frame = Math.max(1, Math.round(info.rate * 0.02));
    const chunk = frame * 250;
    for (let start = 0; start < info.frames; start += chunk) {
      const count = Math.min(chunk, info.frames - start);
      const bytes = await blob.slice(info.dataStart + start * info.channels * 2, info.dataStart + (start + count) * info.channels * 2).arrayBuffer();
      const samples = wavWindow(new DataView(bytes), { ...info, dataStart: 0 }, 0, count);
      for (let i = 0; i < samples.length; i += frame) {
        let sum = 0;
        let seen = 0;
        const end = Math.min(samples.length, i + frame);
        for (let j = i; j < end; j += 8) {
          const value = samples[j] ?? 0;
          sum += value * value;
          seen += 1;
        }
        energies.push(Math.sqrt(sum / Math.max(1, seen)));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return phrasesFromEnergy(energies);
  }
  return mp3Phrases(blob).then((phrases) => phrases ?? m4aPhrases(blob));
}

export function sliceFrames(frames: number, start: number, end: number) {
  const from = Math.max(0, Math.min(frames, Math.round(frames * start)));
  const to = Math.max(from, Math.min(frames, Math.round(frames * end)));
  return { from, to };
}

export async function streamSlice(blob: Blob, start: number, end: number): Promise<{ samples: Int16Array; sampleRate: number } | null> {
  const wav = await wavBytes(blob);
  if (wav && wav.info.frames > 0) {
    const { info } = wav;
    const { from, to } = sliceFrames(info.frames, start, end);
    const pieces: Int16Array[] = [];
    const chunk = info.rate * 5;
    for (let frame = from; frame < to; frame += chunk) {
      const count = Math.min(chunk, to - frame);
      const bytes = await blob.slice(info.dataStart + frame * info.channels * 2, info.dataStart + (frame + count) * info.channels * 2).arrayBuffer();
      const samples = wavWindow(new DataView(bytes), { ...info, dataStart: 0 }, 0, count);
      pieces.push(toInt16(samples));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    let total = 0;
    for (const piece of pieces) total += piece.length;
    const samples = new Int16Array(total);
    let offset = 0;
    for (const piece of pieces) {
      samples.set(piece, offset);
      offset += piece.length;
    }
    return { samples, sampleRate: info.rate };
  }
  return mp3Slice(blob, start, end).then((slice) => slice ?? m4aSlice(blob, start, end));
}

async function mp3Index(blob: Blob) {
  if (typeof AudioDecoder === "undefined") return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const frames = parseMp3(bytes);
  if (frames.length < 2) return null;
  const supported = await AudioDecoder.isConfigSupported({
    codec: "mp3",
    sampleRate: frames[0]?.rate || 48000,
    numberOfChannels: frames[0]?.channels || 1,
  }).catch(() => ({ supported: false }));
  if (!supported.supported) return null;
  let total = 0;
  for (const frame of frames) total += frame.samples;
  return { bytes, frames, total, rate: frames[0]?.rate || 48000, channels: frames[0]?.channels || 1, codec: "mp3", description: undefined as Uint8Array | undefined };
}

async function decodeMp3(
  index: NonNullable<Awaited<ReturnType<typeof mp3Index>>>,
  fromFrame: number,
  toFrame: number,
  onSamples: (samples: Float32Array, frame: number) => void,
  afterFlush?: () => Promise<void>,
) {
  let pending = 0;
  const decoder = new AudioDecoder({
    output: (audio) => {
      const mono = new Float32Array(audio.numberOfFrames);
      const planes = audio.numberOfChannels;
      for (let plane = 0; plane < planes; plane++) {
        const channel = new Float32Array(audio.numberOfFrames);
        audio.copyTo(channel, { planeIndex: plane, format: "f32-planar" });
        for (let i = 0; i < mono.length; i++) mono[i] += (channel[i] ?? 0) / planes;
      }
      const at = Math.max(0, Math.round((audio.timestamp / 1e6) * index.rate));
      audio.close();
      onSamples(mono, at);
      pending = Math.max(0, pending - 1);
    },
    error: () => {
      pending = 0;
    },
  });
  decoder.configure({
    codec: index.codec,
    sampleRate: index.rate,
    numberOfChannels: index.channels,
    description: index.description,
  });
  let sampleAt = 0;
  for (const frame of index.frames) {
    const next = sampleAt + frame.samples;
    if (next >= fromFrame && sampleAt < toFrame) {
      const data = index.bytes.subarray(frame.offset, frame.offset + frame.size);
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      pending += 1;
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round((sampleAt / index.rate) * 1e6), duration: Math.round((frame.samples / index.rate) * 1e6), data: copy }));
      if (pending > 8) {
        await decoder.flush().catch(() => undefined);
        pending = 0;
        if (afterFlush) await afterFlush();
      }
    }
    sampleAt = next;
    if (sampleAt >= toFrame) break;
  }
  await decoder.flush().catch(() => undefined);
  if (afterFlush) await afterFlush();
  decoder.close();
}

async function mp3Peaks(blob: Blob, bars: number) {
  const index = await mp3Index(blob);
  if (!index) return null;
  const peaks = new Array<number>(bars).fill(0);
  await decodeMp3(index, 0, index.total, (samples, frame) => {
    for (let i = 0; i < samples.length; i += 64) {
      const bar = Math.min(bars - 1, Math.floor(((frame + i) / index.total) * bars));
      const value = Math.abs(samples[i] ?? 0);
      if (value > (peaks[bar] ?? 0)) peaks[bar] = value;
    }
  });
  const top = Math.max(...peaks, 0.001);
  return peaks.map((value) => Math.min(1, value / top));
}

async function mp3Phrases(blob: Blob) {
  const { phrasesFromEnergy } = await import("@/lib/phrases");
  const index = await mp3Index(blob);
  if (!index) return null;
  const energies: number[] = [];
  const frame = Math.max(1, Math.round(index.rate * 0.02));
  await decodeMp3(index, 0, index.total, (samples) => {
    for (let i = 0; i < samples.length; i += frame) {
      let sum = 0;
      let seen = 0;
      const end = Math.min(samples.length, i + frame);
      for (let j = i; j < end; j += 8) {
        const value = samples[j] ?? 0;
        sum += value * value;
        seen += 1;
      }
      energies.push(Math.sqrt(sum / Math.max(1, seen)));
    }
  });
  return phrasesFromEnergy(energies);
}

async function mp3Slice(blob: Blob, start: number, end: number) {
  const index = await mp3Index(blob);
  if (!index) return null;
  const { from, to } = sliceFrames(index.total, start, end);
  const lead = Math.max(0, from - Math.floor(index.rate * 0.12));
  const pieces: Int16Array[] = [];
  await decodeMp3(index, lead, to, (samples, frame) => {
    const part = clipFrame(samples, frame, from, to);
    if (part?.length) pieces.push(toInt16(part));
  });
  let total = 0;
  for (const piece of pieces) total += piece.length;
  if (total < 2) return null;
  const samples = new Int16Array(total);
  let offset = 0;
  for (const piece of pieces) {
    samples.set(piece, offset);
    offset += piece.length;
  }
  return { samples, sampleRate: index.rate };
}

type Compressed = NonNullable<Awaited<ReturnType<typeof mp3Index>>>;

function boxText(view: DataView, offset: number) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function walkBoxes(view: DataView, start: number, end: number, visit: (type: string, payload: number, next: number) => void) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = boxText(view, offset + 4);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }
    if (size < header) return;
    const next = size === 0 ? end : Math.min(end, offset + size);
    visit(type, offset + header, next);
    offset = next;
  }
}

function ascFrom(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] !== 0x05) continue;
    const len = bytes[i + 1] ?? 0;
    if (len < 2 || len > 8) continue;
    if (i + 2 + len > bytes.length) continue;
    return bytes.slice(i + 2, i + 2 + len);
  }
  return null;
}

async function m4aIndex(blob: Blob): Promise<Compressed | null> {
  if (typeof AudioDecoder === "undefined") return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let timescale = 48000;
  let sampleRate = 48000;
  let channels = 1;
  let description: Uint8Array | undefined;
  const sizes: number[] = [];
  const chunkOffsets: number[] = [];
  const chunkSamples: number[] = [];
  const deltas: { count: number; delta: number }[] = [];
  const walk = (start: number, end: number) => {
    walkBoxes(view, start, end, (type, payload, next) => {
      if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl" || type === "edts") walk(payload, next);
      if (type === "mdhd" && payload + 20 <= next) {
        const version = view.getUint8(payload);
        timescale = version === 1 ? view.getUint32(payload + 20) : view.getUint32(payload + 12);
      }
      if (type === "stsd") walk(payload + 8, next);
      if (type === "mp4a" && payload + 28 <= next) {
        channels = view.getUint16(payload + 16) || 1;
        sampleRate = view.getUint32(payload + 24) >>> 16 || sampleRate;
        walk(payload + 28, next);
      }
      if (type === "esds") description = ascFrom(bytes.subarray(payload, next)) ?? description;
      if (type === "stsz" && payload + 12 <= next) {
        const fixed = view.getUint32(payload + 4);
        const count = view.getUint32(payload + 8);
        if (fixed > 0) {
          for (let i = 0; i < count; i++) sizes.push(fixed);
        } else {
          for (let i = 0; i < count && payload + 12 + (i + 1) * 4 <= next; i++) sizes.push(view.getUint32(payload + 12 + i * 4));
        }
      }
      if (type === "stco" && payload + 4 <= next) {
        const count = view.getUint32(payload);
        for (let i = 0; i < count && payload + 4 + (i + 1) * 4 <= next; i++) chunkOffsets.push(view.getUint32(payload + 4 + i * 4));
      }
      if (type === "co64" && payload + 4 <= next) {
        const count = view.getUint32(payload);
        for (let i = 0; i < count && payload + 4 + (i + 1) * 8 <= next; i++) chunkOffsets.push(Number(view.getBigUint64(payload + 4 + i * 8)));
      }
      if (type === "stsc" && payload + 4 <= next) {
        const count = view.getUint32(payload);
        for (let i = 0; i < count && payload + 4 + (i + 1) * 12 <= next; i++) chunkSamples.push(view.getUint32(payload + 4 + i * 12 + 4));
      }
      if (type === "stts" && payload + 4 <= next) {
        const count = view.getUint32(payload);
        for (let i = 0; i < count && payload + 4 + (i + 1) * 8 <= next; i++) {
          deltas.push({ count: view.getUint32(payload + 4 + i * 8), delta: view.getUint32(payload + 4 + i * 8 + 4) });
        }
      }
    });
  };
  walk(0, bytes.byteLength);
  if (!sizes.length || !chunkOffsets.length || !description) return null;
  const perChunk: number[] = [];
  for (let i = 0; i < chunkOffsets.length; i++) {
    const run = chunkSamples[Math.min(i, chunkSamples.length - 1)] || 1;
    perChunk.push(run);
  }
  const frames: Mp3Frame[] = [];
  let sample = 0;
  let deltaAt = 0;
  let deltaLeft = deltas[0]?.count ?? 0;
  let delta = deltas[0]?.delta ?? 1024;
  const scale = timescale ? sampleRate / timescale : 1;
  for (let chunk = 0; chunk < chunkOffsets.length && sample < sizes.length; chunk++) {
    let offset = chunkOffsets[chunk] ?? 0;
    const count = perChunk[chunk] ?? 1;
    for (let n = 0; n < count && sample < sizes.length; n++) {
      const size = sizes[sample] ?? 0;
      const samples = Math.max(1, Math.round(delta * scale));
      if (size > 0) frames.push({ offset, size, samples, rate: sampleRate, channels });
      offset += size;
      sample += 1;
      deltaLeft -= 1;
      if (deltaLeft <= 0) {
        deltaAt += 1;
        deltaLeft = deltas[deltaAt]?.count ?? 0;
        delta = deltas[deltaAt]?.delta ?? delta;
      }
    }
  }
  if (frames.length < 1) return null;
  const supported = await AudioDecoder.isConfigSupported({
    codec: "mp4a.40.2",
    sampleRate,
    numberOfChannels: channels,
    description,
  }).catch(() => ({ supported: false }));
  if (!supported.supported) return null;
  let total = 0;
  for (const frame of frames) total += frame.samples;
  return { bytes, frames, total, rate: sampleRate, channels, codec: "mp4a.40.2", description };
}

async function m4aPeaks(blob: Blob, bars: number) {
  const index = await m4aIndex(blob);
  if (!index) return null;
  const peaks = new Array<number>(bars).fill(0);
  await decodeMp3(index, 0, index.total, (samples, frame) => {
    for (let i = 0; i < samples.length; i += 64) {
      const bar = Math.min(bars - 1, Math.floor(((frame + i) / index.total) * bars));
      const value = Math.abs(samples[i] ?? 0);
      if (value > (peaks[bar] ?? 0)) peaks[bar] = value;
    }
  });
  const top = Math.max(...peaks, 0.001);
  return peaks.map((value) => Math.min(1, value / top));
}

async function m4aPhrases(blob: Blob) {
  const { phrasesFromEnergy } = await import("@/lib/phrases");
  const index = await m4aIndex(blob);
  if (!index) return null;
  const energies: number[] = [];
  const frame = Math.max(1, Math.round(index.rate * 0.02));
  await decodeMp3(index, 0, index.total, (samples) => {
    for (let i = 0; i < samples.length; i += frame) {
      let sum = 0;
      let seen = 0;
      const end = Math.min(samples.length, i + frame);
      for (let j = i; j < end; j += 8) {
        const value = samples[j] ?? 0;
        sum += value * value;
        seen += 1;
      }
      energies.push(Math.sqrt(sum / Math.max(1, seen)));
    }
  });
  return phrasesFromEnergy(energies);
}

async function m4aSlice(blob: Blob, start: number, end: number) {
  const index = await m4aIndex(blob);
  if (!index) return null;
  const { from, to } = sliceFrames(index.total, start, end);
  const lead = Math.max(0, from - Math.floor(index.rate * 0.12));
  const pieces: Int16Array[] = [];
  await decodeMp3(index, lead, to, (samples, frame) => {
    const part = clipFrame(samples, frame, from, to);
    if (part?.length) pieces.push(toInt16(part));
  });
  let total = 0;
  for (const piece of pieces) total += piece.length;
  if (total < 2) return null;
  const samples = new Int16Array(total);
  let offset = 0;
  for (const piece of pieces) {
    samples.set(piece, offset);
    offset += piece.length;
  }
  return { samples, sampleRate: index.rate };
}

export async function* streamWindows(blob: Blob): AsyncGenerator<{ samples: Float32Array; sampleRate: number; ratio: number; last: boolean }> {
  const wav = await wavBytes(blob);
  if (wav && wav.info.frames > 0) {
    const { info } = wav;
    const chunk = Math.max(1, info.rate);
    for (let frame = 0; frame < info.frames; frame += chunk) {
      const count = Math.min(chunk, info.frames - frame);
      const bytes = await blob.slice(info.dataStart + frame * info.channels * 2, info.dataStart + (frame + count) * info.channels * 2).arrayBuffer();
      yield {
        samples: wavWindow(new DataView(bytes), { ...info, dataStart: 0 }, 0, count),
        sampleRate: info.rate,
        ratio: (frame + count) / info.frames,
        last: frame + count >= info.frames,
      };
    }
    return;
  }
  const index = (await mp3Index(blob)) ?? (await m4aIndex(blob));
  if (!index) return;
  type Chunk = { samples: Float32Array; sampleRate: number; ratio: number; last: boolean };
  const ready: Chunk[] = [];
  const queue: Chunk[] = [];
  let wake: (() => void) | null = null;
  const gate: { space: (() => void) | null } = { space: null };
  let produced = 0;
  let pending: Float32Array[] = [];
  let pendingFrames = 0;
  const emit = (chunk: Chunk) => {
    ready.push(chunk);
  };
  const pump = decodeMp3(
    index,
    0,
    index.total,
    (samples) => {
      pending.push(samples);
      pendingFrames += samples.length;
      while (pendingFrames >= index.rate) {
        const head = index.rate;
        const samplesOut = new Float32Array(head);
        let filled = 0;
        while (filled < head && pending.length) {
          const part = pending[0];
          if (!part) break;
          const need = head - filled;
          if (part.length <= need) {
            samplesOut.set(part, filled);
            filled += part.length;
            pending.shift();
            pendingFrames -= part.length;
          } else {
            samplesOut.set(part.subarray(0, need), filled);
            pending[0] = part.subarray(need);
            pendingFrames -= need;
            filled += need;
          }
        }
        produced += head;
        emit({ samples: samplesOut, sampleRate: index.rate, ratio: index.total ? Math.min(1, produced / index.total) : 1, last: false });
      }
    },
    async () => {
      while (ready.length) {
        while (queue.length > 1) await new Promise<void>((resolve) => { gate.space = resolve; });
        const chunk = ready.shift();
        if (!chunk) break;
        queue.push(chunk);
        wake?.();
        wake = null;
      }
    },
  ).then(() => {
    if (pendingFrames) {
      const samples = new Float32Array(pendingFrames);
      let offset = 0;
      for (const part of pending) {
        samples.set(part, offset);
        offset += part.length;
      }
      produced += samples.length;
      queue.push({ samples, sampleRate: index.rate, ratio: 1, last: true });
    } else if (queue.length) queue[queue.length - 1] = { ...queue[queue.length - 1]!, last: true };
    wake?.();
  });
  while (queue.length || pendingFrames || ready.length) {
    if (!queue.length) {
      await Promise.race([pump, new Promise<void>((resolve) => { wake = resolve; })]);
      if (!queue.length && ready.length === 0) break;
      continue;
    }
    const chunk = queue.shift();
    const resume = gate.space;
    gate.space = null;
    if (resume) resume();
    if (chunk) yield chunk;
  }
  await pump;
}
