export const AAC_FRAME = 1024;

export function packAacFrames(samples: Float32Array, right?: Float32Array, dualMono = false) {
  const channels = right || dualMono ? 2 : 1;
  const frames: Float32Array[] = [];
  for (let offset = 0; offset < Math.max(samples.length, right?.length ?? 0); offset += AAC_FRAME) {
    const copy = new Float32Array(AAC_FRAME * channels);
    const count = Math.min(AAC_FRAME, Math.max(samples.length, right?.length ?? 0) - offset);
    for (let i = 0; i < count; i++) {
      copy[i * channels] = samples[offset + i] ?? 0;
      if (channels === 2) copy[i * channels + 1] = dualMono ? (samples[offset + i] ?? 0) : (right?.[offset + i] ?? 0);
    }
    frames.push(copy);
  }
  return { frames, channels };
}
