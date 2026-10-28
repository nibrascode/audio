export type SoundTone = "warm" | "cold" | "deep";

export function soundTone(samples: Float32Array, sampleRate: number): SoundTone {
  const take = Math.min(samples.length, Math.max(1, Math.floor(sampleRate * 12)));
  if (take < sampleRate * 0.2 || sampleRate < 1000) return "warm";
  const window = Math.floor(sampleRate);
  const votes = { warm: 0, cold: 0, deep: 0 };
  for (let offset = 0; offset < take; offset += window) {
    const end = Math.min(take, offset + window);
    const vote = voteWindow(samples, sampleRate, offset, end);
    votes[vote] += 1;
  }
  if (votes.deep >= votes.cold && votes.deep > votes.warm) return "deep";
  if (votes.cold > votes.warm) return "cold";
  return "warm";
}

function voteWindow(samples: Float32Array, sampleRate: number, from: number, to: number): SoundTone {
  const step = Math.max(1, Math.floor(sampleRate / 8000));
  const lowMix = Math.exp((-2 * Math.PI * 180) / sampleRate);
  const highMix = Math.exp((-2 * Math.PI * 2800) / sampleRate);
  let crossings = 0;
  let prev = samples[from] ?? 0;
  let energy = 0;
  let low = 0;
  let high = 0;
  let lowState = 0;
  let highState = 0;
  let count = 0;
  for (let i = from; i < to; i += step) {
    const value = samples[i] ?? 0;
    energy += value * value;
    if ((prev >= 0 && value < 0) || (prev < 0 && value >= 0)) crossings += 1;
    prev = value;
    lowState = (1 - lowMix) * value + lowMix * lowState;
    highState = (1 - highMix) * value + highMix * highState;
    low += lowState * lowState;
    high += (value - highState) * (value - highState);
    count += 1;
  }
  const zcr = crossings / Math.max(1, count);
  const lowShare = low / Math.max(energy, 1e-8);
  const highShare = high / Math.max(energy, 1e-8);
  if (lowShare > 0.58 && zcr < 0.14) return "deep";
  if (zcr > 0.2 || highShare > 0.45) return "cold";
  return "warm";
}

export function toneColor(tone: SoundTone | undefined): string {
  if (tone === "cold") return "#3ec6ff";
  if (tone === "deep") return "#7c6bff";
  if (tone === "warm") return "#e2a15a";
  return "";
}
