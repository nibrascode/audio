function writeFmt(view: DataView, channels: number, sampleRate: number, dataBytes: number) {
  const mark = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  mark(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  mark(8, "WAVE");
  mark(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  mark(36, "data");
  view.setUint32(40, dataBytes, true);
}

export function wavFromParts(parts: Int16Array[], sampleRate: number): Blob {
  let frames = 0;
  for (const part of parts) frames += part.length;
  const dataBytes = frames * 2;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeFmt(view, 1, sampleRate, dataBytes);
  const bodies = parts.map((part) => {
    const copy = new Uint8Array(part.byteLength);
    copy.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
    return copy;
  });
  return new Blob([header, ...bodies], { type: "audio/wav" });
}

export function wavFromPcm(pcm: Int16Array, sampleRate: number): Blob {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeFmt(view, 1, sampleRate, dataBytes);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}

export function wavFromPlanar(channels: Float32Array[], sampleRate: number): Blob {
  const count = Math.max(1, Math.min(2, channels.length));
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeFmt(view, count, sampleRate, dataBytes);
  const pcm = new Int16Array(buffer, 44);
  let offset = 0;
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < count; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel]?.[i] ?? 0));
      pcm[offset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      offset += 1;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function wavChunks(
  channels: Float32Array[],
  sampleRate: number,
  hooks?: { progress?: (ratio: number) => void; cancelled?: () => boolean },
): Promise<Blob | null> {
  const count = Math.max(1, Math.min(2, channels.length));
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 2;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeFmt(view, count, sampleRate, dataBytes);
  const parts: BlobPart[] = [header];
  const block = Math.max(1, sampleRate);
  for (let start = 0; start < frames; start += block) {
    if (hooks?.cancelled?.()) return null;
    const n = Math.min(block, frames - start);
    const pcm = new Int16Array(n * count);
    let offset = 0;
    for (let i = 0; i < n; i++) {
      for (let channel = 0; channel < count; channel++) {
        const sample = Math.max(-1, Math.min(1, channels[channel]?.[start + i] ?? 0));
        pcm[offset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        offset += 1;
      }
    }
    parts.push(pcm);
    hooks?.progress?.(frames ? (start + n) / frames : 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (hooks?.cancelled?.()) return null;
  return new Blob(parts, { type: "audio/wav" });
}
