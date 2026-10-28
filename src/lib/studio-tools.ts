export type Span = { start: number; end: number };

export function signalRms(samples: ArrayLike<number>, from = 0, to = samples.length) {
  let energy = 0;
  let count = 0;
  const end = Math.min(samples.length, Math.max(from, to));
  for (let i = Math.max(0, from); i < end; i++) {
    const value = samples[i] ?? 0;
    energy += value * value;
    count += 1;
  }
  return Math.sqrt(energy / Math.max(1, count));
}

export function matchGain(insert: ArrayLike<number>, neighbor: ArrayLike<number>, maxGain = 4) {
  const own = signalRms(insert);
  const target = signalRms(neighbor);
  if (own < 1e-4 || target < 1e-4) return 1;
  return Math.min(maxGain, Math.max(1 / maxGain, target / own));
}

export function scaleSamples(samples: Float32Array, gain: number) {
  if (gain > 0.999 && gain < 1.001) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let value = (samples[i] ?? 0) * gain;
    if (value > 0.98) value = 0.98 + Math.tanh(value - 0.98) * 0.015;
    else if (value < -0.98) value = -0.98 + Math.tanh(value + 0.98) * 0.015;
    out[i] = value;
  }
  return out;
}

export function scaleInt16(samples: Int16Array, gain: number) {
  if (gain > 0.98 && gain < 1.02) return samples;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round((samples[i] ?? 0) * gain)));
  }
  return out;
}

export function reviewRate(ratio: number, marks: number[], reach: number) {
  if (!(reach > 0)) return 1.5;
  for (const mark of marks) {
    if (Math.abs(mark - ratio) <= reach) return 1;
  }
  return 1.5;
}

export function loopAround(spot: number, seconds: number, durationSec: number) {
  if (!(durationSec > 0)) return { start: 0, end: 1 };
  const pad = Math.min(Math.max(0.2, seconds), durationSec / 2) / durationSec;
  const start = Math.max(0, Math.min(1, spot) - pad);
  return { start, end: Math.min(1, Math.max(start + 0.01, spot + pad)) };
}

export function tightenSavings(length: number, sampleRate: number, phrases: Span[], gapSec: number) {
  const nowMs = sampleRate > 0 ? (length / sampleRate) * 1000 : 0;
  if (phrases.length < 2 || sampleRate <= 0 || length < 2) return { removedMs: 0, nextMs: nowMs };
  const gap = Math.max(0.05, gapSec) * sampleRate;
  let kept = 0;
  const ordered = phrases.slice().sort((a, b) => a.start - b.start);
  for (let index = 0; index < ordered.length; index++) {
    const phrase = ordered[index];
    if (!phrase) continue;
    const start = Math.max(0, Math.min(length, Math.round(phrase.start * length)));
    const end = Math.max(start, Math.min(length, Math.round(phrase.end * length)));
    kept += end - start;
    const next = ordered[index + 1];
    if (!next) continue;
    const nextStart = Math.max(0, Math.min(length, Math.round(next.start * length)));
    const hole = nextStart - end;
    if (hole > 8) kept += Math.min(hole, Math.round(gap));
  }
  const nextMs = (kept / sampleRate) * 1000;
  return { removedMs: Math.max(0, nowMs - nextMs), nextMs };
}

export function guardDrop(start: number, end: number, locks: Span[]) {
  if (end - start <= 1e-6) return [] as Span[];
  let open: Span[] = [{ start, end }];
  for (const lock of locks) {
    const next: Span[] = [];
    for (const piece of open) {
      if (lock.end <= piece.start + 1e-6 || lock.start >= piece.end - 1e-6) {
        next.push(piece);
        continue;
      }
      if (lock.start > piece.start + 1e-6) next.push({ start: piece.start, end: Math.min(piece.end, lock.start) });
      if (lock.end < piece.end - 1e-6) next.push({ start: Math.max(piece.start, lock.end), end: piece.end });
    }
    open = next;
  }
  return open.filter((piece) => piece.end - piece.start > 1e-5);
}

export function burstMarks(energies: number[], frameSec = 0.01) {
  if (energies.length < 8 || frameSec <= 0) return [];
  const sorted = energies.slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const openAt = Math.max(0.02, floor * 4);
  const closeAt = Math.max(floor * 1.6, openAt * 0.45);
  const marks: number[] = [];
  let index = 0;
  while (index < energies.length) {
    while (index < energies.length && (energies[index] ?? 0) < openAt) index += 1;
    if (index >= energies.length) break;
    const from = index;
    while (index < energies.length && (energies[index] ?? 0) >= closeAt) index += 1;
    const seconds = (index - from) * frameSec;
    const before = from === 0 ? 0 : (energies[from - 1] ?? 0);
    if ((from === 0 || before < openAt) && seconds >= 0.03 && seconds <= 0.32) {
      marks.push(((from + index) / 2) / energies.length);
    }
    if (marks.length >= 40) break;
  }
  return marks;
}

function unit(values: number[]) {
  let energy = 0;
  for (const value of values) energy += value * value;
  const scale = Math.sqrt(energy);
  if (scale < 1e-8) return null;
  return values.map((value) => value / scale);
}

export function similarMarks(energies: number[], center: number, frameSec = 0.01) {
  const width = Math.max(4, Math.round(0.16 / frameSec));
  const at = Math.round(Math.min(1, Math.max(0, center)) * energies.length);
  const from = Math.max(0, at - Math.floor(width / 2));
  const template = energies.length >= from + width ? unit(energies.slice(from, from + width)) : null;
  if (!template) return [];
  const hits: number[] = [];
  const step = Math.max(1, Math.round(0.02 / frameSec));
  for (let start = 0; start + width < energies.length; start += step) {
    if (Math.abs(start - from) < width) continue;
    let score = 0;
    let energy = 0;
    for (let i = 0; i < width; i++) {
      const value = energies[start + i] ?? 0;
      energy += value * value;
      score += value * (template[i] ?? 0);
    }
    const norm = Math.sqrt(energy);
    const likeness = norm > 1e-8 ? score / norm : 0;
    const ratio = (start + width / 2) / energies.length;
    if (likeness >= 0.86 && hits.every((hit) => Math.abs(hit - ratio) > 0.01)) hits.push(ratio);
    if (hits.length >= 12) break;
  }
  return hits;
}

export function energiesFromPcm(samples: Float32Array, sampleRate: number, frameSec = 0.01) {
  const frame = Math.max(1, Math.round(sampleRate * frameSec));
  const energies: number[] = [];
  for (let i = 0; i < samples.length; i += frame) energies.push(signalRms(samples, i, Math.min(samples.length, i + frame)));
  return energies;
}
