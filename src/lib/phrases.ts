export type Phrase = { start: number; end: number };

function snap(samples: Float32Array, index: number, direction: 1 | -1) {
  const at = Math.max(1, Math.min(samples.length - 2, index));
  const reach = 480;
  const last = Math.max(1, Math.min(samples.length - 2, at + direction * reach));
  for (let i = at; direction > 0 ? i < last : i > last; i += direction) {
    const prev = samples[i - 1] ?? 0;
    const next = samples[i] ?? 0;
    if ((prev <= 0 && next >= 0) || (prev >= 0 && next <= 0)) return i;
  }
  return at;
}

export function phrasesFromEnergy(energies: number[]): Phrase[] {
  if (energies.length < 10) return [{ start: 0, end: 1 }];
  const sorted = energies.slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
  const loud = sorted[Math.floor(sorted.length * 0.85)] ?? floor;
  if (loud < 0.008) return [{ start: 0, end: 1 }];
  const openAt = Math.max(0.01, floor * 2.4, loud * 0.12);
  const closeAt = openAt * 0.55;
  const speech = new Uint8Array(energies.length);
  let open = false;
  for (let i = 0; i < energies.length; i++) {
    const level = energies[i] ?? 0;
    if (!open && level >= openAt) open = true;
    else if (open && level < closeAt) open = false;
    speech[i] = open ? 1 : 0;
  }
  const minGap = Math.round(0.16 / 0.02);
  const minRun = Math.round(0.12 / 0.02);
  const pad = Math.round(0.04 / 0.02);
  const runs: { from: number; to: number }[] = [];
  let cursor = 0;
  while (cursor < speech.length) {
    while (cursor < speech.length && speech[cursor] === 0) cursor += 1;
    if (cursor >= speech.length) break;
    let end = cursor;
    let quiet = 0;
    while (end < speech.length) {
      if (speech[end] === 1) quiet = 0;
      else {
        quiet += 1;
        if (quiet >= minGap) break;
      }
      end += 1;
    }
    const cut = Math.max(cursor + 1, end - quiet);
    if (cut - cursor >= minRun) runs.push({ from: Math.max(0, cursor - pad), to: Math.min(energies.length, cut + pad) });
    cursor = end;
  }
  const merged: { from: number; to: number }[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && run.from <= prev.to + 2) prev.to = Math.max(prev.to, run.to);
    else merged.push({ ...run });
  }
  if (merged.length < 2) return [{ start: 0, end: 1 }];
  return merged.map((run) => ({
    start: run.from / energies.length,
    end: Math.min(1, run.to / energies.length),
  }));
}

export function speechStops(energies: number[]): number[] {
  if (energies.length < 8) return [];
  const sorted = energies.slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
  const loud = sorted[Math.floor(sorted.length * 0.85)] ?? floor;
  if (loud < 0.008) return [];
  const openAt = Math.max(0.01, floor * 2.4, loud * 0.12);
  const closeAt = openAt * 0.55;
  const stops: number[] = [];
  let open = false;
  let quiet = 0;
  let quietAt = 0;
  const minQuiet = 3;
  for (let i = 0; i < energies.length; i++) {
    const level = energies[i] ?? 0;
    if (!open && level >= openAt) {
      open = true;
      quiet = 0;
    } else if (open && level < closeAt) {
      if (quiet === 0) quietAt = i;
      quiet += 1;
      if (quiet >= minQuiet) {
        open = false;
        stops.push(quietAt / energies.length);
        quiet = 0;
      }
    } else quiet = 0;
  }
  return stops;
}

export function stopsInPcm(samples: Float32Array, sampleRate: number): number[] {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  if (samples.length < frame * 8) return [];
  const energies: number[] = [];
  for (let i = 0; i < samples.length; i += frame) {
    const end = Math.min(samples.length, i + frame);
    let sum = 0;
    let count = 0;
    for (let j = i; j < end; j++) {
      const value = samples[j] ?? 0;
      sum += value * value;
      count += 1;
    }
    energies.push(Math.sqrt(sum / Math.max(1, count)));
  }
  return speechStops(energies);
}

export function nearestStop(stops: number[], ratio: number, reach: number) {
  let best = ratio;
  let distance = reach;
  for (const stop of stops) {
    const delta = Math.abs(stop - ratio);
    if (delta <= distance) {
      distance = delta;
      best = stop;
    }
  }
  return best;
}

export function findPhrases(samples: Float32Array, sampleRate: number): Phrase[] {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  if (samples.length < frame * 10) return [{ start: 0, end: 1 }];
  const stride = Math.max(1, Math.floor(frame / 48));
  const energies: number[] = [];
  for (let i = 0; i < samples.length; i += frame) {
    const end = Math.min(samples.length, i + frame);
    let sum = 0;
    let count = 0;
    for (let j = i; j < end; j += stride) {
      const value = samples[j] ?? 0;
      sum += value * value;
      count += 1;
    }
    energies.push(Math.sqrt(sum / Math.max(1, count)));
  }
  const rough = phrasesFromEnergy(energies);
  if (rough.length < 2) return rough;
  const total = samples.length;
  return rough.map((phrase) => {
    const rawStart = Math.min(total - 2, Math.max(0, Math.round(phrase.start * energies.length) * frame));
    const rawEnd = Math.min(total, Math.max(rawStart + 2, Math.round(phrase.end * energies.length) * frame));
    return {
      start: snap(samples, rawStart, 1) / total,
      end: snap(samples, rawEnd, -1) / total,
    };
  });
}
