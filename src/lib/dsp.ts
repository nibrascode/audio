import { isLightDevice } from "@/lib/device";

export function toMono(channels: Float32Array[]) {
  const first = channels[0];
  if (!first || channels.length < 2) return channels;
  const second = channels[1] ?? first;
  const step = Math.max(1, Math.floor(first.length / 4000));
  let midEnergy = 0;
  let sideEnergy = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let i = 0; i < first.length; i += step) {
    const left = first[i] ?? 0;
    const right = second[i] ?? left;
    const mid = left + right;
    const side = left - right;
    midEnergy += mid * mid;
    sideEnergy += side * side;
    leftEnergy += left * left;
    rightEnergy += right * right;
  }
  if (sideEnergy > midEnergy * 3) return [leftEnergy >= rightEnergy ? first : second];
  const mono = new Float32Array(first.length);
  for (let i = 0; i < first.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    mono[i] = sum / channels.length;
  }
  return [mono];
}

function loudest(channels: Float32Array[], index: number) {
  let level = 0;
  for (const data of channels) {
    const value = Math.abs(data[index] ?? 0);
    if (value > level) level = value;
  }
  return level;
}

export function normalizePeak(channels: Float32Array[], target = 0.89) {
  const ref = channels[0];
  if (!ref?.length) return;
  const hop = 512;
  const blocks: number[] = [];
  let truePeak = 0;
  for (let i = 0; i < ref.length; i += hop) {
    let max = 0;
    const end = Math.min(ref.length, i + hop);
    for (let j = i; j < end; j++) {
      const level = loudest(channels, j);
      if (level > max) max = level;
      if (level > truePeak) truePeak = level;
    }
    if (max > 0.00001) blocks.push(max);
  }
  if (!blocks.length || truePeak < 0.00001) return;
  blocks.sort((a, b) => a - b);
  const body = blocks[Math.min(blocks.length - 1, Math.floor(blocks.length * 0.9))] ?? truePeak;
  let gain = Math.min(18, target / Math.max(0.0001, body));
  const limited = 0.98 / truePeak;
  if (truePeak * gain > 0.98 && !(body * limited < target * 0.75 && truePeak > body * 2.5)) gain = limited;
  if (gain > 0.999 && gain < 1.001) return;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      let value = (data[i] ?? 0) * gain;
      if (value > 0.98) value = 0.98 + Math.tanh(value - 0.98) * 0.015;
      else if (value < -0.98) value = -0.98 + Math.tanh(value + 0.98) * 0.015;
      data[i] = value;
    }
  }
}

export function applyGate(channels: Float32Array[], amount: number) {
  const ref = channels[0];
  if (!ref?.length || amount <= 0) return;
  const hop = 160;
  const blocks: number[] = [];
  for (let i = 0; i < ref.length; i += hop) {
    let sum = 0;
    const end = Math.min(ref.length, i + hop);
    for (let j = i; j < end; j++) {
      let loud = 0;
      for (const data of channels) {
        const value = data[j] ?? 0;
        const power = value * value;
        if (power > loud) loud = power;
      }
      sum += loud;
    }
    blocks.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const sorted = blocks.slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const peak = sorted[Math.max(0, sorted.length - 1)] ?? floor;
  const openAt = Math.max(0.008, floor * 2.4 + (peak - floor) * (Math.min(100, amount) / 160) * 0.22);
  const closeAt = openAt * 0.42;
  const depth = 10 ** ((-14 - amount * 0.36) / 20);
  const holdBlocks = 5 + Math.round(amount / 16);
  const look = 3;
  const target = new Float32Array(blocks.length);
  let open = false;
  let held = 0;
  for (let i = 0; i < blocks.length; i++) {
    let level = 0;
    for (let step = 0; step <= look && i + step < blocks.length; step++) level = Math.max(level, blocks[i + step] ?? 0);
    if (!open && level >= openAt) {
      open = true;
      held = holdBlocks;
    } else if (level >= closeAt) {
      open = true;
      held = holdBlocks;
    } else if (held > 0) held -= 1;
    else open = false;
    target[i] = open ? 1 : depth;
  }
  for (const data of channels) {
    let env = target[0] ?? depth;
    for (let i = 0; i < data.length; i++) {
      const want = target[Math.min(target.length - 1, Math.floor(i / hop))] ?? env;
      env += (want - env) * (want > env ? 0.8 : 0.22);
      data[i] = (data[i] ?? 0) * env;
    }
  }
}

export async function timeStretch(input: Float32Array, ratio: number): Promise<Float32Array> {
  if (!input.length) return input;
  if (ratio > 0.98 && ratio < 1.02) return input;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  if (input.length < 512) return resampleLinear(input, outLen);
  const light = isLightDevice();
  const win = Math.min(light ? 768 : 2048, input.length);
  const analysisHop = Math.max(1, Math.floor(win / 4));
  const synthesisHop = Math.max(1, Math.round(analysisHop * ratio));
  const seek = Math.max(4, Math.floor(analysisHop / 2));
  const overlap = Math.max(8, win - synthesisHop);
  const step = light ? 8 : 4;
  const out = new Float32Array(outLen);
  const weight = new Float32Array(outLen);
  const place = (from: number, at: number) => {
    const length = Math.min(win, input.length - from, outLen - at);
    if (length < 8 || from < 0) return;
    for (let i = 0; i < length; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
      const index = at + i;
      out[index] = (out[index] ?? 0) + (input[from + i] ?? 0) * w;
      weight[index] = (weight[index] ?? 0) + w;
    }
  };
  const correlate = (pos: number, at: number, scan: number) => {
    let score = 0;
    let energy = 0;
    for (let i = 0; i < scan; i += step) {
      const heard = out[at + i] ?? 0;
      score += (input[pos + i] ?? 0) * heard;
      energy += heard * heard;
    }
    return energy > 1e-8 ? score / Math.sqrt(energy) : 0;
  };
  place(0, 0);
  let frame = 0;
  const limit = Math.max(0, input.length - 8);
  for (let at = synthesisHop; at < outLen; at += synthesisHop) {
    const ideal = Math.max(0, Math.min(limit, Math.round((at / outLen) * limit)));
    const scan = Math.min(overlap, outLen - at, win);
    let bestScore = -Infinity;
    const picks: { pos: number; score: number }[] = [];
    const consider = (pos: number) => {
      if (pos < 0 || pos + 8 > input.length) return;
      const score = correlate(pos, at, scan);
      picks.push({ pos, score });
      if (score > bestScore) bestScore = score;
    };
    for (let delta = -seek; delta <= seek; delta += step) consider(ideal + delta);
    if (!light) {
      for (let delta = -seek; delta <= seek; delta += 1) consider(ideal + delta);
    }
    let best = ideal;
    let bestFit = -Infinity;
    for (const pick of picks) {
      const distance = Math.abs(pick.pos - ideal);
      const fit = pick.score - distance * Math.max(0.0001, Math.abs(bestScore) * 0.004);
      if (fit > bestFit) {
        bestFit = fit;
        best = pick.pos;
      }
    }
    place(best, at);
    frame += 1;
    if (frame % 24 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (let i = 0; i < outLen; i++) {
    const w = weight[i] ?? 0;
    out[i] = w > 0.0001 ? (out[i] ?? 0) / w : 0;
  }
  return out;
}

export async function pitchShift(input: Float32Array, semitones: number): Promise<Float32Array> {
  if (!input.length || !semitones) return input;
  const factor = 2 ** (semitones / 12);
  const shifted = resampleCubic(input, Math.max(1, Math.round(input.length / factor)));
  return timeStretch(shifted, input.length / shifted.length);
}

function sampleAt(input: Float32Array, index: number) {
  if (index <= 0) return input[0] ?? 0;
  if (index >= input.length) return input[input.length - 1] ?? 0;
  return input[index] ?? 0;
}

function resampleCubic(input: Float32Array, length: number) {
  if (length === input.length) return input.slice();
  const out = new Float32Array(length);
  const scale = (input.length - 1) / Math.max(1, length - 1);
  for (let i = 0; i < length; i++) {
    const x = i * scale;
    const index = Math.floor(x);
    const t = x - index;
    const a = sampleAt(input, index - 1);
    const b = sampleAt(input, index);
    const c = sampleAt(input, index + 1);
    const d = sampleAt(input, index + 2);
    const t2 = t * t;
    const t3 = t2 * t;
    out[i] = 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  }
  return out;
}

function resampleLinear(input: Float32Array, length: number) {
  if (length === input.length) return input.slice();
  const out = new Float32Array(length);
  const scale = (input.length - 1) / Math.max(1, length - 1);
  for (let i = 0; i < length; i++) {
    const x = i * scale;
    const index = Math.floor(x);
    const mix = x - index;
    const a = input[index] ?? 0;
    const b = input[Math.min(input.length - 1, index + 1)] ?? a;
    out[i] = a + (b - a) * mix;
  }
  return out;
}
