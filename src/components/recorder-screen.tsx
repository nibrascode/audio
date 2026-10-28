import { useBlocker, useNavigate } from "@tanstack/react-router";
import { LoaderCircle, Mic, Pause, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BackLink, Frame, MicStatus } from "@/components/chrome";
import { LiveMeter } from "@/components/live-meter";
import { AudioPlayer } from "@/components/player";
import { classifyMicError, formatClock, formatStamp, primeMicPermission, readShape, useMicWatch, type MicPerm } from "@/lib/audio";
import { m4aMime, startCapture, type CaptureSession, type MicLoss, type RecordFormat } from "@/lib/capture";
import { useI18n } from "@/lib/i18n";
import { useLibrary } from "@/lib/library";
import type { SoundTone } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { clearCapture, readCapture, readCaptureBlob } from "@/lib/checkpoint";
import { wavFromParts } from "@/lib/wav";

type Phase = "idle" | "recording" | "paused" | "review";
type Notice = "micTaken" | "micBack" | "micCut" | "micSuspended" | null;

function isQuota(err: unknown) {
  return err instanceof DOMException && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

function FingerPad({ label, onSwipe }: { label: string; onSwipe: (dir: "up" | "down" | "left" | "right") => void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className="relative grid h-32 touch-none place-items-center rounded-3xl border border-dashed border-line text-sm text-muted"
      onPointerDown={(event) => {
        start.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        const from = start.current;
        start.current = null;
        if (!from) return;
        const dx = event.clientX - from.x;
        const dy = event.clientY - from.y;
        if (Math.hypot(dx, dy) < 42) return;
        onSwipe(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
      }}
    >
      {label}
    </div>
  );
}

export function RecorderScreen() {
  const { t, locale } = useI18n();
  const library = useLibrary();
  const navigate = useNavigate();
  const watched = useMicWatch();
  const [override, setOverride] = useState<MicPerm | null>(null);
  const perm = override ?? watched;
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [format, setFormat] = useState<RecordFormat>("wav");
  const [m4aOk, setM4aOk] = useState(false);
  const [m4aChecked, setM4aChecked] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [marks, setMarks] = useState<number[]>([]);
  const [tone, setTone] = useState<SoundTone | undefined>(undefined);

  const sessionRef = useRef<CaptureSession | null>(null);
  const accumulatedRef = useRef(0);
  const startedAtRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const skipRef = useRef(false);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const beginRef = useRef<() => Promise<void>>(async () => {});
  const finishRef = useRef<() => Promise<void>>(async () => {});
  const pauseRef = useRef<(manual?: boolean) => void>(() => {});
  const manualPause = useRef(false);
  const resumeRef = useRef<() => Promise<void>>(async () => {});
  const cleanupRef = useRef<() => void>(() => {});
  const formatRef = useRef<RecordFormat>("wav");

  phaseRef.current = phase;
  formatRef.current = format;
  dirtyRef.current = phase === "recording" || phase === "paused" || phase === "review";

  const blocker = useBlocker({
    shouldBlockFn: () => !skipRef.current && dirtyRef.current,
    enableBeforeUnload: () => !skipRef.current && dirtyRef.current,
    withResolver: true,
  });

  useEffect(() => {
    let cancel = false;
    void readCapture().then(async (saved) => {
      if (cancel || phaseRef.current !== "idle") return;
      if (saved) {
        setBlob(wavFromParts(saved.parts, saved.sampleRate));
        let frames = 0;
        for (const part of saved.parts) frames += part.length;
        setElapsed((frames / saved.sampleRate) * 1000);
        setTitle(`${t("take")} · ${t("recovered")}`);
        setPhase("review");
        return;
      }
      const piece = await readCaptureBlob();
      if (cancel || !piece || phaseRef.current !== "idle") return;
      setBlob(piece);
      setTitle(`${t("take")} · ${t("recovered")}`);
      setPhase("review");
    }).catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [t]);

  useEffect(() => {
    setM4aOk(m4aMime() !== "");
    setM4aChecked(true);
  }, []);


  useEffect(() => {
    let cancel = false;
    void (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
      try {
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (cancel) return;
        if (status.state === "granted") {
          setOverride("granted");
          return;
        }
        if (status.state === "denied") {
          setOverride("denied");
          return;
        }
      } catch {
        /* Permissions API unavailable — ask via getUserMedia */
      }
      if (cancel) return;
      setOverride("requesting");
      const result = await primeMicPermission();
      if (cancel) return;
      setOverride(result === "prompt" ? null : result);
    })();
    return () => {
      cancel = true;
    };
  }, []);


  function releaseHardware() {
    sessionRef.current?.release();
    sessionRef.current = null;
    setAnalyser(null);
  }

  cleanupRef.current = releaseHardware;
  useEffect(() => () => cleanupRef.current(), []);

  useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(() => {
      setElapsed(accumulatedRef.current + (Date.now() - startedAtRef.current));
    }, 50);
    return () => window.clearInterval(id);
  }, [phase]);

  function stampPause() {
    if (phaseRef.current === "recording") {
      accumulatedRef.current += Date.now() - startedAtRef.current;
      setElapsed(accumulatedRef.current);
    }
  }

  function pause(manual = false) {
    const session = sessionRef.current;
    if (!session || phaseRef.current !== "recording") return;
    if (manual) manualPause.current = true;
    session.pause();
    stampPause();
    setPhase("paused");
  }

  async function resume() {
    const session = sessionRef.current;
    if (!session || phaseRef.current !== "paused") return;
    const result = await session.resume();
    if (result !== "ok") {
      setOverride(result === "denied" ? "denied" : result === "missing" ? "missing" : "busy");
      setNotice("micTaken");
      return;
    }
    manualPause.current = false;
    startedAtRef.current = Date.now();
    setNotice(null);
    setOverride("granted");
    setPhase("recording");
  }

  async function begin() {
    if (busyRef.current || phaseRef.current === "recording" || phaseRef.current === "paused") return;
    busyRef.current = true;
    setError(null);
    setNotice(null);
    setConfirmDrop(false);
    void clearCapture();
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
        setOverride("unsupported");
        return;
      }
      if (!window.isSecureContext) {
        setOverride("insecure");
        return;
      }
      const chosen = formatRef.current === "m4a" && m4aMime() ? "m4a" : "wav";
      if (formatRef.current === "m4a" && chosen === "wav") setNotice(null);
      setFormat(chosen);
      setOverride("requesting");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          video: false,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "OverconstrainedError") {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } else {
          throw err;
        }
      }
      const session = await startCapture(stream, chosen, {
        onMicLost: (kind: MicLoss) => {
          if (kind === "ended" || kind === "muted") {
            if (kind === "muted") {
              const at = accumulatedRef.current;
              setMarks((prev) => [...prev, at]);
            }
            pauseRef.current(false);
            setNotice("micTaken");
            void resumeRef.current();
            return;
          }
          pauseRef.current(false);
          setNotice("micSuspended");
        },
        onMicBack: () => {
          if (phaseRef.current === "paused" && !manualPause.current) {
            void resumeRef.current();
            return;
          }
          if (phaseRef.current === "paused") setNotice("micBack");
        },
        onControl: (action) => {
          if (action === "pause") pauseRef.current(true);
          if (action === "play") void resumeRef.current();
          if (action === "stop") void finishRef.current();
        },
      });
      sessionRef.current = session;
      setAnalyser(session.analyser);
      accumulatedRef.current = 0;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setBlob(null);
      setPeaks([]);
      setNote("");
      setMarks([]);
      setTone(undefined);
      setPhase("recording");
      setOverride("granted");
    } catch (err) {
      releaseHardware();
      setOverride(err instanceof Error && err.message === "no-audio" ? "unsupported" : classifyMicError(err));
      setPhase("idle");
    } finally {
      busyRef.current = false;
    }
  }

  async function finish() {
    const session = sessionRef.current;
    if (!session || busyRef.current) return;
    if (phaseRef.current !== "recording" && phaseRef.current !== "paused") return;
    busyRef.current = true;
    const ms = phaseRef.current === "recording" ? accumulatedRef.current + (Date.now() - startedAtRef.current) : accumulatedRef.current;
    try {
      const recorded = await session.stop();
      const msFromWav =
        recorded.type.includes("wav") && recorded.size > 44
          ? ((recorded.size - 44) / 2 / session.sampleRate) * 1000
          : ms;
      session.release();
      sessionRef.current = null;
      setAnalyser(null);
      setElapsed(msFromWav);
      setBlob(recorded);
      setTitle(`${t("take")} · ${formatStamp(Date.now(), locale, t("today"))}`);
      setPhase("review");
      try {
        const shape = await readShape(recorded);
        setPeaks(shape.peaks);
        setTone(shape.tone);
      } catch {
        setPeaks([]);
      }
    } finally {
      busyRef.current = false;
    }
  }

  beginRef.current = begin;
  finishRef.current = finish;
  pauseRef.current = pause;
  resumeRef.current = resume;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
      const current = phaseRef.current;
      if (current === "review") return;
      event.preventDefault();
      if (current === "idle") void beginRef.current();
      else if (current === "paused") void resumeRef.current();
      else void finishRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function resetTake() {
    releaseHardware();
    setBlob(null);
    setPeaks([]);
    setNote("");
    setTitle("");
    setElapsed(0);
    setError(null);
    setNotice(null);
    setMarks([]);
    setTone(undefined);
    setConfirmDrop(false);
    setPhase("idle");
    void clearCapture();
  }

  async function save() {
    if (!blob || saving) return;
    setSaving(true);
    setError(null);
    try {
      const meta = await library.addProject({
        title: title.trim() || `${t("take")} · ${formatStamp(Date.now(), locale, t("today"))}`,
        note,
        blob,
        mimeType: blob.type || (format === "m4a" ? "audio/mp4" : "audio/wav"),
        durationMs: elapsed,
        source: "record",
        peaks,
        tone,
        marks,
      });
      skipRef.current = true;
      void clearCapture();
      setPhase("idle");
      setBlob(null);
      await navigate({ to: "/p/$id", params: { id: meta.id } });
    } catch (err) {
      setError(isQuota(err) ? t("storageFail") : t("storageFail"));
    } finally {
      setSaving(false);
    }
  }

  const blocked =
    phase === "idle" &&
    (perm === "denied" || perm === "unsupported" || perm === "insecure" || perm === "missing" || perm === "busy");
  const status =
    phase === "recording" ? t("recording") : phase === "paused" ? t("paused") : t("ready");
  const meterMode = phase === "recording" ? "live" : phase === "paused" ? "paused" : "idle";
  const help =
    perm === "denied"
      ? t("micDeniedHelp")
      : perm === "unsupported"
        ? t("micUnsupported")
        : perm === "insecure"
          ? t("micInsecure")
          : perm === "missing"
            ? t("micMissing")
            : perm === "busy"
              ? t("micBusy")
              : t("permissionBody");
  const formatName = format === "m4a" ? t("m4a") : t("wav");

  return (
    <Frame>
      <header className="flex items-center justify-between">
        <BackLink />
        <h1 className="text-base font-semibold">{t("studio")}</h1>
        <span className="w-16" />
      </header>

      {phase !== "review" ? (
        <div className="mt-6 flex flex-1 flex-col">
          <p className="text-center text-sm text-muted" aria-live="polite">
            {status}
            {phase !== "idle" ? ` · ${formatName}` : ""}
          </p>
          <p className="mt-2 text-center text-5xl font-semibold tabular-nums">{formatClock(elapsed, phase !== "idle")}</p>
          {phase === "idle" && !blocked ? (
            <div className="mx-auto mt-4 flex items-center gap-2" role="group" aria-label={t("formatLabel")}>
              {(["wav", "m4a"] as const).map((item) => {
                const disabled = item === "m4a" && !m4aOk;
                return (
                  <button
                    key={item}
                    type="button"
                    disabled={disabled}
                    aria-pressed={format === item}
                    onClick={() => setFormat(item)}
                    className={cn(
                      "press min-h-11 rounded-full px-4 text-sm font-semibold",
                      format === item ? "brand-fill" : "border border-line bg-surface text-muted",
                      disabled && "opacity-40",
                    )}
                  >
                    {item === "wav" ? t("wav") : t("m4a")}
                  </button>
                );
              })}
            </div>
          ) : null}
          {m4aChecked && !m4aOk && phase === "idle" && !blocked ? <p className="mt-2 text-center text-sm text-faint">{t("m4aUnavailable")}</p> : null}
          <div className="mt-4">
            <LiveMeter analyser={analyser} mode={meterMode} />
          </div>
          {notice ? (
            <p className={cn("mt-3 text-center text-sm text-pretty", notice === "micBack" ? "text-cyan" : "text-danger")} role="status">
              {t(notice)}
            </p>
          ) : null}
          <div className="mt-auto pt-6">
            {blocked ? (
              <div className="rounded-3xl border border-line bg-surface p-5">
                <h2 className="text-lg font-semibold">{t("permissionTitle")}</h2>
                <p className="mt-2 text-sm text-pretty text-muted">{help}</p>
                <div className="mt-4">
                  <MicStatus perm={perm} />
                </div>
                {perm !== "unsupported" && perm !== "insecure" ? (
                  <button
                    type="button"
                    onClick={() => void begin()}
                    className="press brand-fill mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-2xl px-4 text-base font-semibold"
                  >
                    {t("retryMic")}
                  </button>
                ) : null}
              </div>
            ) : (
              <div>
                <FingerPad
                  label={`${t("fingerHint")} · ↑ ${t("record")} · ↓ ${t("stop")}`}
                  onSwipe={(dir) => {
                    const current = phaseRef.current;
                    if (dir === "up") {
                      if (current === "idle") void beginRef.current();
                      else if (current === "paused") void resumeRef.current();
                    } else if (dir === "down" && (current === "recording" || current === "paused")) void finishRef.current();
                    else if (dir === "left" && current === "recording") pauseRef.current(true);
                    else if (dir === "right" && current === "paused") void resumeRef.current();
                  }}
                />
                <div className="mt-4 grid grid-cols-3 items-center">
                <div className="flex justify-center">
                  {phase === "recording" ? (
                    <button type="button" onClick={() => pause(true)} className="press grid size-14 place-items-center rounded-full border border-line bg-surface text-fg" aria-label={t("pause")}>
                      <Pause className="size-5" />
                    </button>
                  ) : phase === "paused" ? (
                    <button type="button" onClick={() => void resume()} className="press grid size-14 place-items-center rounded-full border border-line bg-surface text-fg" aria-label={t("resume")}>
                      <Play className="size-5 translate-x-px" />
                    </button>
                  ) : null}
                </div>
                <div className="flex justify-center">
                  {phase === "idle" ? (
                    <button
                      type="button"
                      onClick={() => void begin()}
                      disabled={perm === "requesting"}
                      className="press brand-fill relative grid size-24 place-items-center rounded-full disabled:opacity-70"
                      aria-label={t("record")}
                    >
                      {perm === "requesting" ? <LoaderCircle className="size-8 animate-spin" /> : <Mic className="size-8" />}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void finish()}
                      className="press relative grid size-24 place-items-center rounded-full border border-line bg-surface text-fg"
                      aria-label={t("stop")}
                    >
                      <span className="pulse-ring" aria-hidden="true" />
                      <Square className="relative size-7 fill-danger text-danger" />
                    </button>
                  )}
                </div>
                <span />
              </div>
              </div>
            )}
            {!blocked ? (
              <p className="mt-4 text-center text-sm text-pretty text-muted">
                {phase === "idle" ? t("permissionBody") : t("screenOff")}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-6 flex flex-1 flex-col gap-4">
          {notice === "micCut" ? <p className="text-sm text-danger">{t("micCut")}</p> : null}
          <p className="text-sm text-muted">
            {formatName} · {formatClock(elapsed)}
          </p>
          <label className="grid gap-2 text-sm text-muted">
            {t("projectName")}
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={80}
              className="min-h-12 rounded-2xl border border-line bg-bg px-4 text-base text-fg outline-none focus:border-cyan"
            />
          </label>
          {blob ? <AudioPlayer blob={blob} peaks={peaks} marks={marks} /> : null}
          {marks.length > 0 ? (
            <p className="text-sm text-cyan">
              {t("callMark")}: {marks.map((mark) => formatClock(mark)).join(" · ")}
            </p>
          ) : null}
          <label className="grid gap-2 text-sm text-muted">
            {t("notes")}
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={4}
              maxLength={8000}
              placeholder={t("notePlaceholder")}
              className="resize-none rounded-2xl border border-line bg-bg px-4 py-3 text-base text-fg outline-none focus:border-cyan"
            />
          </label>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {confirmDrop ? (
            <div className="rounded-2xl border border-line bg-surface p-4">
              <p className="text-sm">{t("discardAsk")}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => setConfirmDrop(false)} className="press min-h-11 flex-1 rounded-full border border-line text-sm font-medium">
                  {t("cancel")}
                </button>
                <button type="button" onClick={resetTake} className="press min-h-11 flex-1 rounded-full text-sm font-semibold text-danger">
                  {t("discard")}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-auto grid gap-3 pt-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !blob || !library.ready}
                className="press brand-fill inline-flex min-h-12 items-center justify-center rounded-2xl text-base font-semibold disabled:opacity-50"
              >
                {saving ? t("loading") : t("save")}
              </button>
              <div className="grid grid-cols-2 gap-3">
                <button type="button" onClick={resetTake} className="press min-h-12 rounded-2xl border border-line bg-surface text-sm font-semibold">
                  {t("retake")}
                </button>
                <button type="button" onClick={() => setConfirmDrop(true)} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold text-danger">
                  {t("discard")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {blocker.status === "blocked" ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <div className="absolute inset-0 bg-bg/75" />
          <div className="safe-b relative z-10 m-4 w-full max-w-sm rounded-3xl border border-line bg-surface-2 p-5">
            <h2 className="text-lg font-semibold">{t("leaveTitle")}</h2>
            <p className="mt-2 text-sm text-pretty text-muted">{t("leaveBody")}</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => blocker.reset()} className="press min-h-11 rounded-full border border-line text-sm font-semibold">
                {t("stay")}
              </button>
              <button type="button" onClick={() => blocker.proceed()} className="press brand-fill min-h-11 rounded-full text-sm font-semibold">
                {t("leave")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Frame>
  );
}
