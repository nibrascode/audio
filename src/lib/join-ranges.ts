import { streamSlice } from "@/lib/stream";
import { wavFromParts } from "@/lib/wav";

export type Range = { start: number; end: number };

export function spanAroundMark(samples: Int16Array, center: number, rate: number) {
  const safe = Math.max(1, Math.min(samples.length - 1, center));
  const from = Math.max(1, safe - Math.floor(rate * 0.08));
  const to = Math.min(samples.length - 1, safe + Math.floor(rate * 0.45));
  let worst = safe;
  let worstDelta = 0;
  for (let i = from; i <= to; i++) {
    const delta = Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0));
    if (delta > worstDelta) {
      worstDelta = delta;
      worst = i;
    }
  }
  let quietEnd = worst;
  let loud = 0;
  const win = Math.max(8, Math.floor(rate * 0.01));
  const limit = Math.min(samples.length - win, worst + Math.floor(rate * 0.55));
  for (let i = worst; i <= limit; i += win) {
    let sum = 0;
    for (let j = 0; j < win; j++) sum += Math.abs(samples[i + j] ?? 0);
    if (sum / win > 900) {
      loud += win;
      if (loud > Math.floor(rate * 0.03)) break;
    } else {
      loud = 0;
      quietEnd = i + win;
    }
  }
  return {
    from: Math.max(0, worst - Math.floor(rate * 0.012)),
    to: Math.min(samples.length, quietEnd + Math.floor(rate * 0.012)),
  };
}

function withFades(parts: Int16Array[], fade: number) {
  if (fade < 2) return parts;
  return parts.map((part, index) => {
    const copy = new Int16Array(part);
    const n = Math.min(fade, Math.floor(copy.length / 2));
    if (n < 2) return copy;
    if (index > 0) {
      for (let i = 0; i < n; i++) copy[i] = Math.round((copy[i] ?? 0) * (i / (n - 1)));
    }
    if (index < parts.length - 1) {
      for (let i = 0; i < n; i++) {
        const at = copy.length - 1 - i;
        copy[at] = Math.round((copy[at] ?? 0) * (i / (n - 1)));
      }
    }
    return copy;
  });
}

export async function joinRanges(blob: Blob, ranges: Range[], fadeMs = 45) {
  const pieces: Int16Array[] = [];
  let rate = 48000;
  const ordered = ranges
    .filter((range) => range.end - range.start > 1e-6)
    .sort((a, b) => a.start - b.start);
  for (const range of ordered) {
    const slice = await streamSlice(blob, Math.max(0, range.start), Math.min(1, range.end));
    if (!slice || slice.samples.length < 8) continue;
    rate = slice.sampleRate;
    pieces.push(slice.samples);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!pieces.length) return null;
  const faded = withFades(pieces, Math.round((fadeMs / 1000) * rate));
  let frames = 0;
  for (const piece of faded) frames += piece.length;
  return {
    blob: wavFromParts(faded, rate),
    durationMs: (frames / rate) * 1000,
  };
}

export async function dropCallMarks(blob: Blob, durationMs: number, marksMs: number[], fadeMs = 8) {
  const duration = Math.max(durationMs, 1);
  const marks = [...new Set(marksMs.map((mark) => Math.round(mark)))].filter((mark) => mark > 20 && mark < duration - 20).sort((a, b) => a - b);
  if (!marks.length) return null;
  const holes: Range[] = [];
  for (const mark of marks) {
    const ratio = mark / duration;
    const half = Math.min(0.45, (700 / duration));
    const start = Math.max(0, ratio - half);
    const end = Math.min(1, ratio + half);
    const slice = await streamSlice(blob, start, end);
    if (!slice || slice.samples.length < 16) {
      holes.push({ start: Math.max(0, ratio - 80 / duration), end: Math.min(1, ratio + 80 / duration) });
      continue;
    }
    const center = Math.round(((ratio - start) / Math.max(0.0001, end - start)) * slice.samples.length);
    const span = spanAroundMark(slice.samples, center, slice.sampleRate);
    const width = end - start;
    holes.push({
      start: start + (span.from / slice.samples.length) * width,
      end: start + (span.to / slice.samples.length) * width,
    });
  }
  const ranges: Range[] = [];
  let cursor = 0;
  for (const hole of holes.sort((a, b) => a.start - b.start)) {
    const from = Math.max(cursor, hole.start);
    const to = Math.max(from, hole.end);
    if (from > cursor + 20 / duration) ranges.push({ start: cursor, end: from });
    cursor = Math.max(cursor, to);
  }
  if (cursor < 0.999) ranges.push({ start: cursor, end: 1 });
  if (!ranges.length) return null;
  return joinRanges(blob, ranges, fadeMs);
}
