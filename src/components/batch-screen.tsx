import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Mic, Minus, Plus, Square, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BackLink, Frame } from "@/components/chrome";
import { classifyMicError, formatClock, readDuration } from "@/lib/audio";
import { startCapture, type CaptureSession } from "@/lib/capture";
import { decodePcm, peaksFromPcm, resample, slicePcm, type Pcm } from "@/lib/edit";
import { findPhrases, nearestStop } from "@/lib/phrases";
import { cn } from "@/lib/utils";
import { wavFromParts } from "@/lib/wav";
import { useI18n } from "@/lib/i18n";
import { useLibrary } from "@/lib/library";
import { ratioOf } from "@/lib/fix";
import { playWindow, stopInMs } from "@/lib/play-window";
import { streamPeaks, streamPhrases, streamSlice } from "@/lib/stream";
import { matchGain, scaleInt16 } from "@/lib/studio-tools";
import { loadBatch, saveBatch, type StoredClip } from "@/lib/batch-store";

type Clip = {
  key: string;
  title: string;
  blob: Blob;
  durationMs: number;
  source: "record" | "import";
  start: number;
  end: number;
  spot: number;
  marks: number[];
  peaks: number[];
  projectId?: string;
  locked?: boolean;
};

type Target = { kind: "split"; index: number } | { kind: "gap"; index: number };

function keptMs(clip: Clip) {
  return Math.max(40, (clip.end - clip.start) * clip.durationMs);
}

export function BatchScreen() {
  const { t } = useI18n();
  const library = useLibrary();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [lane, setLane] = useState({ start: 0, span: 1 });
  const [pausesOn, setPausesOn] = useState(false);
  const [stops, setStops] = useState<number[]>([]);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const [rec, setRec] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const sessionRef = useRef<CaptureSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const targetRef = useRef<Target | null>(null);
  const finishRef = useRef<() => Promise<void>>(async () => {});
  const history = useRef<Clip[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const restored = useRef(false);
  const allowSave = useRef(false);

  useEffect(() => {
    if (!library.ready || restored.current) return;
    restored.current = true;
    let cancel = false;
    void loadBatch().then(async (saved) => {
      if (cancel || !saved?.length) return;
      const next: Clip[] = [];
      for (const item of saved) {
        const blob = item.blob ?? (item.projectId ? await library.getAudio(item.projectId) : null);
        if (!blob) continue;
        next.push({ ...item, blob, marks: item.marks ?? [], peaks: item.peaks ?? [] });
      }
      if (!cancel && next.length) {
        setClips(next);
        setOpenKey(next[0]?.key ?? null);
      }
      allowSave.current = true;
    }).catch(() => {
      allowSave.current = true;
    });
    return () => {
      cancel = true;
    };
  }, [library.ready, library.getAudio]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (!allowSave.current) return;
      const stored: StoredClip[] = clips.map((clip) => ({
        key: clip.key,
        title: clip.title,
        durationMs: clip.durationMs,
        source: clip.source,
        start: clip.start,
        end: clip.end,
        spot: clip.spot,
        marks: clip.marks,
        peaks: clip.peaks,
        projectId: clip.projectId,
        locked: clip.locked,
        blob: clip.projectId ? undefined : clip.blob,
      }));
      void saveBatch(stored).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(handle);
  }, [clips]);

  function remember() {
    history.current = [...history.current.slice(-29), clips.map((clip) => ({ ...clip, marks: clip.marks.slice(), peaks: clip.peaks }))];
    setCanUndo(true);
  }

  function undo() {
    const prev = history.current.pop();
    setCanUndo(history.current.length > 0);
    if (prev) setClips(prev);
  }

  function patch(key: string, next: Partial<Pick<Clip, "start" | "end" | "spot" | "locked">>) {
    setClips((list) => list.map((clip) => (clip.key === key ? { ...clip, ...next } : clip)));
  }

  function move(index: number, direction: -1 | 1) {
    remember();
    setClips((list) => {
      const target = index + direction;
      if (target < 0 || target >= list.length) return list;
      const next = list.slice();
      const current = next[index];
      const other = next[target];
      if (!current || !other) return list;
      next[index] = other;
      next[target] = current;
      return next;
    });
  }

  async function addBlob(title: string, blob: Blob, source: "record" | "import", at?: number, projectId?: string) {
    const durationMs = await readDuration(blob);
    const clip: Clip = {
      key: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: title.slice(0, 80) || t("take"),
      blob,
      durationMs: durationMs || 0,
      source,
      start: 0,
      end: 1,
      spot: 0.5,
      marks: [],
      peaks: [],
      projectId,
    };
    remember();
    setClips((list) => {
      if (at == null) return [...list, clip];
      const next = list.slice();
      next.splice(at, 0, clip);
      return next;
    });
    setOpenKey((current) => current ?? clip.key);
    setLane({ start: 0, span: 1 });
  }

  async function addFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const base = file.name.replace(/\.[^.]+$/, "").trim();
      await addBlob(base, file, "import");
    } catch {
      setError(t("importFail"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function addProject(id: string) {
    const project = library.projects.find((item) => item.id === id);
    const blob = await library.getAudio(id);
    setPicking(false);
    if (!project || !blob) {
      setError(t("editFail"));
      return;
    }
    await addBlob(project.title, blob, project.source, undefined, project.id);
  }

  async function begin(target: Target) {
    if (rec || busy) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      const session = await startCapture(stream, "wav", {
        onMicLost: () => undefined,
        onMicBack: () => undefined,
        onControl: (action) => {
          if (action === "stop") void finishRef.current();
        },
      });
      streamRef.current = stream;
      sessionRef.current = session;
      targetRef.current = target;
      setElapsed(0);
      setRec(true);
    } catch (err) {
      const kind = classifyMicError(err);
      setError(t(kind === "denied" ? "micDenied" : kind === "missing" ? "micMissing" : "micBusy"));
    }
  }

  async function finish() {
    const session = sessionRef.current;
    const target = targetRef.current;
    sessionRef.current = null;
    targetRef.current = null;
    setRec(false);
    if (!session || !target) return;
    try {
      const blob = await session.stop();
      session.release();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (blob.size < 44) {
        setError(t("tooShort"));
        return;
      }
      const durationMs = await readDuration(blob);
      const take: Clip = {
        key: `rec-${Date.now()}`,
        title: t("take"),
        blob,
        durationMs: durationMs || 0,
        source: "record",
        start: 0,
        end: 1,
        spot: 0.5,
        marks: [],
        peaks: [],
      };
      remember();
      setClips((list) => {
        if (target.kind === "gap") {
          const next = list.slice();
          next.splice(target.index, 0, take);
          return next;
        }
        const clip = list[target.index];
        if (!clip) return [...list, take];
        const point = Math.min(clip.end - 0.01, Math.max(clip.start + 0.01, clip.spot));
        const parts: Clip[] = [];
        if (point - clip.start > 0.02) parts.push({ ...clip, key: `${clip.key}-a`, end: point, marks: clip.marks.filter((mark) => mark < point) });
        parts.push(take);
        if (clip.end - point > 0.02) parts.push({ ...clip, key: `${clip.key}-b`, start: point, marks: clip.marks.filter((mark) => mark > point) });
        const next = list.slice();
        next.splice(target.index, 1, ...parts);
        return next;
      });
    } catch {
      setError(t("editFail"));
    }
  }

  finishRef.current = finish;

  useEffect(() => {
    if (!rec) return;
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - started), 200);
    return () => window.clearInterval(id);
  }, [rec]);

  useEffect(() => {
    return () => {
      sessionRef.current?.release();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function renderClips(list: Clip[]) {
    const pieces: Int16Array[] = [];
    let rate = 48000;
    for (let index = 0; index < list.length; index++) {
      const clip = list[index];
      if (!clip) continue;
      setStatus(`${t("processing")} ${index + 1}/${list.length}`);
      const streamed = await streamSlice(clip.blob, clip.start, clip.end);
      let samples: Int16Array | null = streamed?.samples ?? null;
      let sampleRate = streamed?.sampleRate ?? 0;
      if (!samples) {
        const pcm = await decodePcm(clip.blob);
        const sliced = slicePcm(pcm, clip.start, clip.end);
        const float = !pieces.length || sliced.sampleRate === (pieces.length ? rate : sliced.sampleRate)
          ? sliced.samples
          : resample(sliced.samples, sliced.sampleRate, rate);
        sampleRate = sliced.sampleRate;
        samples = new Int16Array(float.length);
        for (let i = 0; i < float.length; i++) {
          const sample = Math.max(-1, Math.min(1, float[i] ?? 0));
          samples[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
      }
      if (!pieces.length) rate = sampleRate || 48000;
      if (sampleRate && sampleRate !== rate) {
        const float = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) float[i] = (samples[i] ?? 0) / 32768;
        const next = resample(float, sampleRate, rate);
        samples = new Int16Array(next.length);
        for (let i = 0; i < next.length; i++) {
          const sample = Math.max(-1, Math.min(1, next[i] ?? 0));
          samples[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
      }
      if (samples.length < 2) continue;
      if (clip.source === "record" && pieces.length && samples.length < rate * 20) {
        samples = scaleInt16(samples, matchGain(samples, pieces[pieces.length - 1] ?? samples));
      }
      pieces.push(samples);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    let frames = 0;
    for (const piece of pieces) frames += piece.length;
    if (frames < 8) throw new Error("short");
    const peaks = new Array<number>(48).fill(0);
    let seen = 0;
    const step = Math.max(1, Math.floor(frames / (48 * 32)));
    for (const piece of pieces) {
      for (let i = 0; i < piece.length; i += step) {
        const bar = Math.min(47, Math.floor((seen / frames) * 48));
        const value = Math.abs(piece[i] ?? 0) / 32768;
        if (value > (peaks[bar] ?? 0)) peaks[bar] = value;
        seen += step;
      }
    }
    const top = Math.max(...peaks, 0.001);
    return {
      blob: wavFromParts(pieces, rate),
      durationMs: (frames / rate) * 1000,
      peaks: peaks.map((value) => Math.min(1, value / top)),
    };
  }

  async function save(list: Clip[], title: string) {
    if (!list.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const rendered = await renderClips(list);
      if (rendered.blob.size < 44) throw new Error("incomplete");
      const created = await library.addProject({
        title: title.slice(0, 80),
        note: "",
        blob: rendered.blob,
        mimeType: "audio/wav",
        durationMs: Math.round(rendered.durationMs),
        source: list[0]?.source ?? "import",
        peaks: rendered.peaks,
      });
      await navigate({ to: "/p/$id", params: { id: created.id } });
    } catch {
      setError(t("editFail"));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  function listen(clip: Clip) {
    playerRef.current?.pause();
    const url = URL.createObjectURL(clip.blob);
    const audio = new Audio(url);
    playerRef.current = audio;
    const { start, stop } = playWindow(clip.durationMs / 1000, clip.start, clip.end);
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      const wait = stopInMs(audio.currentTime, stop, clip.end);
      if (wait == null) return;
      timer = window.setTimeout(() => {
        audio.pause();
        audio.currentTime = start;
        URL.revokeObjectURL(url);
      }, wait);
    };
    const begin = () => {
      audio.currentTime = start;
      void audio.play().then(arm).catch(() => URL.revokeObjectURL(url));
    };
    audio.onloadedmetadata = begin;
    audio.ontimeupdate = arm;
    audio.onended = () => URL.revokeObjectURL(url);
    if (audio.readyState >= 1) begin();
  }

  useEffect(() => {
    if (!pausesOn || !openKey) return;
    const clip = clips.find((item) => item.key === openKey);
    if (!clip) return;
    let cancel = false;
    void streamPhrases(clip.blob).then((phrases) => {
      if (cancel || !phrases) return;
      const next: number[] = [];
      for (const phrase of phrases) {
        const edge = ratioOf(0.05, clip.durationMs);
        if (phrase.start > edge && phrase.start < 1 - edge) next.push(phrase.start);
        if (phrase.end > edge && phrase.end < 1 - edge) next.push(phrase.end);
      }
      setStops(next);
    });
    return () => {
      cancel = true;
    };
  }, [pausesOn, openKey, clips]);

  function focus(clip: Clip) {
    setOpenKey(clip.key);
    setLane({ start: clip.start, span: Math.max(0.001, clip.end - clip.start) });
    void loadPeaks(clip);
  }

  async function loadPeaks(clip: Clip) {
    if (clip.peaks.length > 8) return;
    setStatus(t("processing"));
    try {
      const streamed = await streamPeaks(clip.blob, 1000);
      const peaks = streamed ?? peaksFromPcm((await decodePcm(clip.blob)).samples, 1000);
      setClips((list) => list.map((item) => (item.blob === clip.blob && item.peaks.length < 8 ? { ...item, peaks } : item)));
    } catch {
      setError(t("editFail"));
    } finally {
      setStatus(null);
    }
  }

  function addMark(clip: Clip) {
    setClips((list) =>
      list.map((item) => {
        if (item.key !== clip.key) return item;
        if (item.marks.some((mark) => Math.abs(mark - item.spot) < ratioOf(0.03, item.durationMs))) return item;
        return { ...item, marks: [...item.marks, item.spot].sort((a, b) => a - b) };
      }),
    );
  }

  function splitMarks(clip: Clip) {
    if (clip.locked) return;
    const gap = ratioOf(0.04, clip.durationMs);
    const points = [clip.start, ...clip.marks.filter((mark) => mark > clip.start + gap && mark < clip.end - gap), clip.end];
    const unique = points.filter((point, index) => index === 0 || point - (points[index - 1] ?? 0) > gap);
    if (unique.length < 3) return;
    remember();
    setClips((list) => {
      const index = list.findIndex((item) => item.key === clip.key);
      if (index < 0) return list;
      const parts: Clip[] = [];
      for (let i = 0; i < unique.length - 1; i++) {
        const start = unique[i] ?? clip.start;
        const end = unique[i + 1] ?? clip.end;
        parts.push({
          ...clip,
          key: `${clip.key}-${i}-${Date.now()}`,
          start,
          end,
          spot: (start + end) / 2,
          marks: [],
        });
      }
      const next = list.slice();
      next.splice(index, 1, ...parts);
      return next;
    });
    setOpenKey(null);
  }

  async function splitSpeech(clip: Clip) {
    if (busy || clip.locked) return;
    setBusy(true);
    setError(null);
    setStatus(t("processing"));
    try {
      const streamed = await streamPhrases(clip.blob);
      const pcm = streamed ? null : await decodePcm(clip.blob);
      const found = streamed ?? (pcm ? findPhrases(pcm.samples, pcm.sampleRate) : []);
      const minRatio = 12 / Math.max(12, clip.durationMs / 1000);
      const grouped: { start: number; end: number }[] = [];
      for (const phrase of found) {
        const start = Math.max(clip.start, phrase.start);
        const end = Math.min(clip.end, phrase.end);
        if (end - start < ratioOf(0.08, clip.durationMs)) continue;
        const last = grouped[grouped.length - 1];
        if (last && end - last.start < minRatio) last.end = end;
        else grouped.push({ start, end });
      }
      if (grouped.length < 2) return;
      remember();
      setClips((list) => {
        const index = list.findIndex((item) => item.key === clip.key);
        if (index < 0) return list;
        const parts = grouped.map((part, partIndex) => ({
          ...clip,
          key: `${clip.key}-p${partIndex}-${Date.now()}`,
          start: part.start,
          end: part.end,
          spot: (part.start + part.end) / 2,
          marks: [],
        }));
        const next = list.slice();
        next.splice(index, 1, ...parts);
        return next;
      });
      setOpenKey(null);
    } catch {
      setError(t("editFail"));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <Frame>
      <header className="flex items-center justify-between gap-3">
        <BackLink />
        <h1 className="truncate text-base font-semibold">{t("batch")}</h1>
        <span className="w-16" />
      </header>
      <p className="mt-4 text-sm text-pretty text-muted">{t("batchHint")}</p>
      {clips.length === 0 ? (
        <button type="button" onClick={() => void begin({ kind: "gap", index: 0 })} className="instrument press mt-5 flex min-h-16 w-full items-center justify-center gap-3 rounded-[1.2rem] text-base font-semibold">
          <Mic className="size-5" />
          {t("newRecording")}
        </button>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => fileRef.current?.click()} className="press inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-line bg-surface text-sm font-semibold">
          <Plus className="size-4" />
          {t("batchFile")}
        </button>
        <button type="button" onClick={() => setPicking(true)} className="press min-h-12 rounded-2xl border border-line bg-surface text-sm font-semibold">
          {t("batchFrom")}
        </button>
      </div>
      <input ref={fileRef} type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac,.webm" className="sr-only" onChange={(event) => void addFile(event.target.files?.[0])} />

      {clips.length === 0 ? <p className="mt-6 text-sm text-faint">{t("batchEmpty")}</p> : null}

      <div className="mt-4">
        {clips.map((clip, index) => (
          <div key={clip.key}>
            {index > 0 ? (
              <button type="button" onClick={() => void begin({ kind: "gap", index })} className="press my-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-dashed border-line text-sm font-semibold text-cyan">
                <Mic className="size-4" />
                {t("batchGap")}
              </button>
            ) : null}
            <article className="rounded-3xl border border-line bg-surface p-4">
              <button type="button" onClick={() => focus(clip)} className="flex w-full items-center gap-2 text-start">
                <span className="text-xs tabular-nums text-faint">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{clip.title}</span>
                  <span className="mt-0.5 block text-xs tabular-nums text-muted">
                    {formatClock(clip.start * clip.durationMs)} – {formatClock(clip.end * clip.durationMs)}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-faint">{formatClock(keptMs(clip))}</span>
              </button>
              {openKey === clip.key ? (
                <div className="mt-3">
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label={t("zoom")} onClick={() => {
                      const seconds = Math.max(1, clip.durationMs / 1000);
                      const min = Math.min(clip.end - clip.start, 8 / seconds);
                      const next = Math.min(clip.end - clip.start, Math.max(min, lane.span * 1.8));
                      setLane({ span: next, start: Math.min(clip.end - next, Math.max(clip.start, clip.spot - next / 2)) });
                    }} className="press grid size-10 place-items-center rounded-full border border-line"><Minus className="size-4" /></button>
                    <button type="button" aria-label={t("zoom")} onClick={() => {
                      const seconds = Math.max(1, clip.durationMs / 1000);
                      const min = Math.min(clip.end - clip.start, 8 / seconds);
                      const next = Math.max(min, lane.span / 1.8);
                      setLane({ span: next, start: Math.min(clip.end - next, Math.max(clip.start, clip.spot - next / 2)) });
                    }} className="press grid size-10 place-items-center rounded-full border border-line"><Plus className="size-4" /></button>
                    <span className="text-xs tabular-nums text-faint">{formatClock(lane.span * clip.durationMs)}</span>
                  </div>
                  <div
                    dir="ltr"
                    className="relative mt-3 h-20 touch-none overflow-hidden rounded-2xl border border-line bg-bg"
                    onPointerDown={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const origin = { x: event.clientX, start: lane.start, moved: false };
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const place = (clientX: number) => Math.min(clip.end, Math.max(clip.start, origin.start + ((clientX - rect.left) / rect.width) * lane.span));
                      const move = (ev: PointerEvent) => {
                        if (Math.abs(ev.clientX - origin.x) > 8) origin.moved = true;
                        if (!origin.moved) return;
                        const delta = ((ev.clientX - origin.x) / rect.width) * lane.span;
                        const next = Math.min(clip.end - lane.span, Math.max(clip.start, origin.start - delta));
                        setLane((current) => ({ ...current, start: next }));
                      };
                      const up = (ev: PointerEvent) => {
                        event.currentTarget.removeEventListener("pointermove", move);
                        event.currentTarget.removeEventListener("pointerup", up);
                        if (!origin.moved) {
                          const raw = place(ev.clientX);
                          patch(clip.key, { spot: pausesOn ? nearestStop(stops, raw, lane.span * 0.04) : raw });
                        }
                      };
                      event.currentTarget.addEventListener("pointermove", move);
                      event.currentTarget.addEventListener("pointerup", up);
                    }}
                  >
                    <div className="flex h-full items-end gap-px px-1 pb-4">
                      {(clip.peaks.length ? clip.peaks : [0.2]).filter((_, bar, all) => {
                        const at = (bar + 0.5) / all.length;
                        return at >= lane.start && at < lane.start + lane.span;
                      }).map((peak, bar) => (
                        <span key={bar} className="min-w-0 flex-1 rounded-full bg-violet/80" style={{ height: `${Math.round(16 + Math.min(1, peak) * 70)}%` }} />
                      ))}
                    </div>
                    <span className="pointer-events-none absolute inset-y-1 w-0.5 -translate-x-1/2 bg-fg" style={{ left: `${((clip.spot - lane.start) / Math.max(lane.span, 0.0001)) * 100}%` }} />
                    {clip.marks.map((mark) => (
                      <span key={mark} className="pointer-events-none absolute inset-y-1 w-0.5 bg-cyan" style={{ left: `${((mark - lane.start) / Math.max(lane.span, 0.0001)) * 100}%` }} />
                    ))}
                    {stops.map((stop) => (
                      <span key={stop} className="pointer-events-none absolute inset-y-1 w-px bg-amber-200/80" style={{ left: `${((stop - lane.start) / Math.max(lane.span, 0.0001)) * 100}%` }} />
                    ))}
                    <span className="pointer-events-none absolute bottom-1 left-2 text-[10px] tabular-nums text-muted">{formatClock(clip.spot * clip.durationMs, lane.span < 0.05)}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => addMark(clip)} className="press min-h-11 rounded-2xl border border-line text-sm font-semibold">{t("batchMark")}</button>
                    <button type="button" disabled={rec || busy} onClick={() => void begin({ kind: "split", index })} className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-cyan text-sm font-semibold text-cyan disabled:opacity-40">
                      <Mic className="size-4" />
                      {t("batchHere")}
                    </button>
                    <button type="button" disabled={clip.marks.length === 0} onClick={() => splitMarks(clip)} className="press min-h-11 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("batchSplit")}</button>
                    <button type="button" onClick={() => setPausesOn((value) => !value)} className={cn("press min-h-11 rounded-2xl border text-sm font-semibold", pausesOn ? "border-amber-200 text-amber-100" : "border-line")}>{t("pauseHelp")}</button>
                    <button type="button" disabled={busy} onClick={() => void splitSpeech(clip)} className="press min-h-11 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("batchSpeech")}</button>
                  </div>
                </div>
              ) : null}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button type="button" onClick={() => listen(clip)} className="press min-h-11 rounded-xl border border-line text-xs font-semibold">{t("batchListen")}</button>
                <button type="button" aria-label={t("batchUp")} disabled={index === 0} onClick={() => move(index, -1)} className="press grid min-h-11 place-items-center rounded-xl border border-line disabled:opacity-40">
                  <ChevronUp className="size-4" />
                </button>
                <button type="button" aria-label={t("batchDown")} disabled={index === clips.length - 1} onClick={() => move(index, 1)} className="press grid min-h-11 place-items-center rounded-xl border border-line disabled:opacity-40">
                  <ChevronDown className="size-4" />
                </button>
                <button type="button" onClick={() => patch(clip.key, { locked: !clip.locked })} className={cn("press min-h-11 rounded-xl border text-xs font-semibold", clip.locked ? "border-cyan text-cyan" : "border-line")}>{t("protect")}</button>
                <button type="button" disabled={clip.locked} onPointerDown={() => remember()} onClick={() => setClips((list) => list.filter((item) => item.key !== clip.key))} className="press min-h-11 rounded-xl border border-line text-xs font-semibold text-danger disabled:opacity-40">
                  {t("batchOut")}
                </button>
              </div>
            </article>
          </div>
        ))}
      </div>

      {status ? <p className="mt-4 text-sm text-muted" role="status">{status}</p> : null}
      {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}

      <div className="mt-5 grid grid-cols-[auto_1fr] gap-2">
        <button type="button" disabled={!canUndo} onClick={undo} className="press inline-flex min-h-12 items-center justify-center gap-1 rounded-2xl border border-line px-4 text-sm font-semibold disabled:opacity-40">
          <Undo2 className="size-4" />
          {t("undo")}
        </button>
        <button
          type="button"
          disabled={busy || clips.length < 2}
          onClick={() => void save(clips, t("batch"))}
          className="press brand-fill min-h-12 rounded-2xl text-base font-semibold disabled:opacity-40"
        >
          {t("join")}
        </button>
      </div>

      {rec ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <div className="absolute inset-0 bg-bg/80" />
          <div className="safe-b relative z-10 m-4 w-full max-w-sm rounded-3xl border border-line bg-surface-2 p-5 text-center">
            <p className="text-sm text-muted">{t("batchHere")}</p>
            <p className="mt-3 text-4xl font-semibold tabular-nums">{formatClock(elapsed)}</p>
            <button type="button" onClick={() => void finish()} className="press mt-5 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-danger text-base font-semibold text-white">
              <Square className="size-4 fill-current" />
              {t("stop")}
            </button>
          </div>
        </div>
      ) : null}

      {picking ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={() => setPicking(false)} />
          <div className="safe-b relative z-10 m-4 max-h-[70vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
            <h2 className="text-lg font-semibold">{t("pickSound")}</h2>
            {library.projects.length === 0 ? <p className="mt-3 text-sm text-muted">{t("batchEmpty")}</p> : null}
            <ul className="mt-4 grid gap-2">
              {library.projects.map((project) => (
                <li key={project.id}>
                  <button type="button" onClick={() => void addProject(project.id)} className="press min-h-12 w-full rounded-2xl border border-line bg-surface px-4 text-start text-sm font-medium">
                    <span className="block truncate">{project.title}</span>
                    <span className="text-muted">{formatClock(project.durationMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setPicking(false)} className="press mt-4 min-h-11 w-full rounded-full border border-line text-sm font-semibold">
              {t("close")}
            </button>
          </div>
        </div>
      ) : null}
    </Frame>
  );
}
