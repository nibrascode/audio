import { useEffect, useState } from "react";
import { soundTone, type SoundTone } from "@/lib/tone";

export type MicPerm =
  | "unknown"
  | "prompt"
  | "granted"
  | "denied"
  | "unsupported"
  | "insecure"
  | "requesting"
  | "missing"
  | "busy";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
  "audio/ogg;codecs=opus",
];

export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function fileExt(mime: string, filename = ""): string {
  const m = mime.toLowerCase();
  if (m.includes("wav") || m.includes("wave")) return "wav";
  if (m.includes("flac")) return "flac";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("caf")) return "caf";
  if (m.includes("aac") && !m.includes("mp4")) return "aac";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  const fromName = filename.toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] ?? "";
  if (fromName === "mp4" || fromName === "m4a") return "m4a";
  if (fromName === "mpeg" || fromName === "mp3") return "mp3";
  if (["wav", "aac", "ogg", "flac", "webm", "caf", "opus"].includes(fromName)) return fromName === "opus" ? "ogg" : fromName;
  return "audio";
}

export function formatName(mime: string, filename = ""): string {
  const ext = fileExt(mime, filename);
  return ext === "audio" ? "AUDIO" : ext.toUpperCase();
}

export function mimeFromName(filename: string): string {
  switch (fileExt("", filename)) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "webm":
      return "audio/webm";
    case "caf":
      return "audio/x-caf";
    default:
      return "";
  }
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  let text = "";
  for (let i = 0; i < length && start + i < bytes.length; i++) text += String.fromCharCode(bytes[start + i] ?? 0);
  return text;
}

export async function sniffAudio(blob: Blob): Promise<{ mime: string; ext: string } | null> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  if (head.length < 12) return null;
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (ascii(head, 0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (ascii(head, 0, 4) === "fLaC") return { mime: "audio/flac", ext: "flac" };
  if (ascii(head, 0, 4) === "caff") return { mime: "audio/x-caf", ext: "caf" };
  if (ascii(head, 0, 3) === "ID3") return { mime: "audio/mpeg", ext: "mp3" };
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    const layer = (head[1] >> 1) & 3;
    return layer === 0 ? { mime: "audio/aac", ext: "aac" } : { mime: "audio/mpeg", ext: "mp3" };
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { mime: "audio/webm", ext: "webm" };
  if (ascii(head, 4, 4) === "ftyp") return { mime: "audio/mp4", ext: "m4a" };
  return null;
}

export async function shareAudio(blob: Blob, filename: string, title: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  const data: ShareData = { files: [file], title };
  if (typeof navigator.share === "function" && (typeof navigator.canShare !== "function" || navigator.canShare(data))) {
    try {
      await navigator.share(data);
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    }
  }
  downloadBlob(blob, filename);
  return "downloaded";
}

export async function saveToPhone(blob: Blob, filename: string, title: string): Promise<"saved" | "shared" | "downloaded" | "cancelled"> {
  const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName?: string; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker && window.isSecureContext) {
    try {
      const ext = filename.slice(filename.lastIndexOf("."));
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: "Audio", accept: { [blob.type || "application/octet-stream"]: [ext || ".wav"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "saved";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    }
  }
  const shared = await shareAudio(blob, filename, title);
  if (shared === "shared") return "shared";
  if (shared === "cancelled") return "cancelled";
  return "downloaded";
}

export function safeName(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N}\-_ ]+/gu, "").trim().slice(0, 60);
  return clean || "nibras-audio";
}

export function formatClock(ms: number, withCs = false): string {
  const clamped = Math.max(0, ms);
  const totalCs = Math.floor(clamped / 10);
  const cs = totalCs % 100;
  const totalS = Math.floor(totalCs / 100);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60);
  const base = `${m}:${s.toString().padStart(2, "0")}`;
  return withCs ? `${base}.${cs.toString().padStart(2, "0")}` : base;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

export function formatStamp(ts: number, locale: string, todayWord: string): string {
  const date = new Date(ts);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  if (date.toDateString() === new Date().toDateString()) return `${todayWord} · ${time}`;
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
  return `${day} · ${time}`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function readDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const finish = (ms: number) => {
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration) || audio.duration === Infinity) {
        audio.ontimeupdate = () => {
          audio.ontimeupdate = null;
          const d = audio.duration;
          try {
            audio.currentTime = 0;
          } catch {
            /* ignore */
          }
          finish(Number.isFinite(d) ? d * 1000 : 0);
        };
        try {
          audio.currentTime = 1e101;
        } catch {
          finish(0);
        }
        return;
      }
      finish(audio.duration * 1000);
    };
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}

export async function readShape(blob: Blob, bars = 42): Promise<{ peaks: number[]; tone: SoundTone }> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return { peaks: [], tone: "warm" };
  const ctx = new Ctx();
  try {
    const raw = await blob.arrayBuffer();
    const buffer = await ctx.decodeAudioData(raw.slice(0));
    const channel = buffer.getChannelData(0);
    const block = Math.max(1, Math.floor(channel.length / bars));
    const peaks: number[] = [];
    for (let i = 0; i < bars; i++) {
      let max = 0;
      const start = i * block;
      const end = Math.min(channel.length, start + block);
      const step = Math.max(1, Math.floor((end - start) / 80));
      for (let j = start; j < end; j += step) {
        const value = Math.abs(channel[j] ?? 0);
        if (value > max) max = value;
      }
      peaks.push(max);
    }
    const top = Math.max(...peaks, 0.001);
    return { peaks: peaks.map((peak) => Math.min(1, peak / top)), tone: soundTone(channel, buffer.sampleRate) };
  } finally {
    await ctx.close();
  }
}

export async function computePeaks(blob: Blob, bars = 42): Promise<number[]> {
  return (await readShape(blob, bars)).peaks;
}

export function classifyMicError(err: unknown): MicPerm {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  if (name === "SecurityError") return "insecure";
  return "denied";
}

export function useMicWatch(): MicPerm {
  const [perm, setPerm] = useState<MicPerm>("unknown");
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const read = async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setPerm("unsupported");
        return;
      }
      if (!window.isSecureContext) {
        setPerm("insecure");
        return;
      }
      try {
        status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        const apply = () => {
          if (cancelled || !status) return;
          setPerm(status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "prompt");
        };
        apply();
        status.onchange = apply;
      } catch {
        if (!cancelled) setPerm("prompt");
      }
    };
    void read();
    const onVis = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return perm;
}
