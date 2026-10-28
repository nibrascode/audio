export function buildRoomImpulse(sampleRate: number, light = false) {
  const rate = Math.max(8000, sampleRate);
  const seconds = light ? 0.9 : 1.8;
  const length = Math.max(1, Math.floor(rate * seconds));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const early: [number, number][] = [
    [0.011, 0.74],
    [0.017, 0.58],
    [0.029, 0.46],
    [0.041, 0.34],
    [0.061, 0.24],
    [0.083, 0.16],
  ];
  for (const [time, gain] of early) {
    const at = Math.min(length - 1, Math.floor(time * rate));
    left[at] += gain;
    const side = Math.min(length - 1, at + Math.max(1, Math.floor(rate * 0.0008)));
    right[side] += gain * 0.9;
  }
  let seed = 17;
  const next = () => {
    seed = (seed * 48271) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  let lowL = 0;
  let lowR = 0;
  const decay = light ? 3.6 : 2.1;
  for (let i = 0; i < length; i++) {
    const env = Math.exp((-decay * i) / rate);
    lowL += 0.18 * (next() - lowL);
    lowR += 0.18 * (next() - lowR);
    left[i] += lowL * env * 0.34;
    right[i] += lowR * env * 0.34;
  }
  let peak = 0.0001;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(left[i] ?? 0), Math.abs(right[i] ?? 0));
  const scale = 0.9 / peak;
  for (let i = 0; i < length; i++) {
    left[i] = (left[i] ?? 0) * scale;
    right[i] = (right[i] ?? 0) * scale;
  }
  return { left, right, sampleRate: rate };
}

export function impulseEnergy(samples: Float32Array, from: number, to: number) {
  let sum = 0;
  let count = 0;
  const end = Math.min(samples.length, to);
  for (let i = Math.max(0, from); i < end; i++) {
    const value = samples[i] ?? 0;
    sum += value * value;
    count += 1;
  }
  return count ? sum / count : 0;
}
