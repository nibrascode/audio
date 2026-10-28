import { useSyncExternalStore } from "react";
import { isLightDevice } from "@/lib/device";
import { encodeInBackground, type ExportFormat, type ExportRate } from "@/lib/jobs";

export type ExportNote = "interrupted" | "failed" | "cancelled";

export type ExportPhase =
  | { state: "idle" }
  | { state: "run"; progress: number; title: string; light: boolean; sheet: boolean }
  | { state: "ready"; blob: Blob; filename: string; title: string; format: ExportFormat; sheet: boolean }
  | { state: "note"; kind: ExportNote; sheet: boolean };

const FLAG = "nibras-export";
const idle: ExportPhase = { state: "idle" };

let phase: ExportPhase = idle;
let sheetOpen = false;
let cancelJob: (() => void) | null = null;
let wake: WakeLockSentinel | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function boot() {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (sessionStorage.getItem(FLAG) === "run") {
      sessionStorage.removeItem(FLAG);
      phase = { state: "note", kind: "interrupted", sheet: false };
      emit();
    }
  } catch {
    /* private mode */
  }
}

if (typeof window !== "undefined") queueMicrotask(boot);

function markRunning() {
  try {
    sessionStorage.setItem(FLAG, "run");
  } catch {
    /* ignore */
  }
}

function clearRunning() {
  try {
    sessionStorage.removeItem(FLAG);
  } catch {
    /* ignore */
  }
}

async function holdWake() {
  try {
    wake = (await navigator.wakeLock?.request("screen")) ?? null;
  } catch {
    wake = null;
  }
}

function releaseWake() {
  void wake?.release().catch(() => undefined);
  wake = null;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && phase.state === "run") void holdWake();
  });
}

export function setExportSheetOpen(open: boolean) {
  sheetOpen = open;
  if ("sheet" in phase && phase.sheet !== open) {
    phase = { ...phase, sheet: open };
    emit();
  }
}

export function cancelExport() {
  cancelJob?.();
  cancelJob = null;
  clearRunning();
  releaseWake();
  phase = { state: "note", kind: "cancelled", sheet: sheetOpen };
  emit();
}

export function dismissExport() {
  if (phase.state === "run") return;
  cancelJob = null;
  phase = idle;
  emit();
}

export async function fileLooksComplete(blob: Blob, format: ExportFormat) {
  if (blob.size < 16) return false;
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (format === "wav") {
    return blob.size >= 44 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
  }
  if (format === "mp3") return (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || head[0] === 0xff;
  return head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
}

export function startExport(input: {
  title: string;
  filename: string;
  format: ExportFormat;
  samples: Float32Array;
  sampleRate: number;
  targetRate: ExportRate;
  bitrate: number;
  right?: Float32Array;
  dualMono?: boolean;
}) {
  if (phase.state === "run") return false;
  const light = isLightDevice();
  const sheet = sheetOpen;
  markRunning();
  phase = { state: "run", progress: 0.08, title: input.title, light, sheet };
  emit();
  void holdWake();
  const job = encodeInBackground(input.samples, input.sampleRate, input.format, (ratio) => {
    if (phase.state !== "run") return;
    phase = { ...phase, progress: 0.08 + ratio * 0.92 };
    emit();
  }, {
    targetRate: input.targetRate,
    bitrate: light ? Math.min(input.bitrate, 128) : input.bitrate,
    right: input.right,
    dualMono: input.dualMono,
    transfer: true,
  });
  cancelJob = job.cancel;
  void job.done.then(async (blob) => {
    cancelJob = null;
    clearRunning();
    releaseWake();
    if (phase.state !== "run") return;
    if (!(await fileLooksComplete(blob, input.format))) {
      phase = { state: "note", kind: "failed", sheet: phase.sheet };
      emit();
      return;
    }
    phase = { state: "ready", blob, filename: input.filename, title: input.title, format: input.format, sheet: phase.sheet };
    emit();
  }).catch((err: unknown) => {
    cancelJob = null;
    clearRunning();
    releaseWake();
    if (phase.state !== "run") return;
    const cancelled = err instanceof Error && err.message === "cancelled";
    phase = { state: "note", kind: cancelled ? "cancelled" : "failed", sheet: phase.sheet };
    emit();
  });
  return true;
}

function snapshot() {
  return phase;
}

export function useExportRun() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    () => idle,
  );
}
