import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { formatClock } from "@/lib/audio";
import { useI18n } from "@/lib/i18n";
import { playWindow, stopInMs } from "@/lib/play-window";
import { cn } from "@/lib/utils";

export function Waveform({
  peaks,
  progress,
  rtl,
  onSeek,
  label,
  marks,
  durationMs,
}: {
  peaks: number[];
  progress: number;
  rtl: boolean;
  onSeek: (ratio: number) => void;
  label: string;
  marks?: number[];
  durationMs?: number;
}) {
  const bars = peaks.length ? peaks : Array.from({ length: 42 }, () => 0.16);

  function seekFrom(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    const ratio = rtl ? 1 - raw : raw;
    onSeek(Math.min(1, Math.max(0, ratio)));
  }

  return (
    <div className="relative">
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(1, Math.max(0, progress)) * 100)}
        className="flex h-16 cursor-pointer items-center gap-px"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFrom(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFrom(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") onSeek(Math.min(1, progress + 0.05));
          if (event.key === "ArrowLeft") onSeek(Math.max(0, progress - 0.05));
        }}
      >
        {bars.map((peak, index) => {
          const played = (index + 0.5) / bars.length <= progress;
          return (
            <span
              key={index}
              className={cn("min-w-0 flex-1 rounded-full", played ? "bg-cyan" : "bg-line")}
              style={{ height: `${Math.round(12 + Math.min(1, peak) * 88)}%` }}
            />
          );
        })}
      </div>
      {durationMs && durationMs > 0
        ? marks?.map((mark) => (
            <span
              key={mark}
              className="pointer-events-none absolute top-0 h-full w-0.5 bg-danger"
              style={{ left: `${Math.min(100, Math.max(0, (mark / durationMs) * 100))}%` }}
            />
          ))
        : null}
    </div>
  );
}

export function MiniBars({ peaks }: { peaks: number[] }) {
  const bars = (peaks.length ? peaks : Array.from({ length: 16 }, () => 0.2)).slice(0, 16);
  return (
    <span className="flex h-10 w-11 shrink-0 items-center gap-px" aria-hidden="true">
      {bars.map((peak, index) => (
        <span
          key={index}
          className="min-w-0 flex-1 rounded-full bg-cyan"
          style={{ height: `${Math.round(18 + Math.min(1, peak) * 82)}%`, opacity: 0.4 + Math.min(1, peak) * 0.6 }}
        />
      ))}
    </span>
  );
}

export function AudioPlayer({
  blob,
  peaks,
  marks,
  startRatio = 0,
  endRatio = 1,
  onRatio,
  onDuration,
  loop = false,
  rate = 1,
  seekTo = null,
}: {
  blob: Blob;
  peaks: number[];
  marks?: number[];
  startRatio?: number;
  endRatio?: number;
  onRatio?: (ratio: number) => void;
  onDuration?: (ms: number) => void;
  loop?: boolean;
  rate?: number;
  seekTo?: { ratio: number; token: number } | null;
}) {
  const { t, locale } = useI18n();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [failed, setFailed] = useState(false);
  const reported = useRef(false);
  const stopTimer = useRef<number | null>(null);
  const startRef = useRef(startRatio);
  const endRef = useRef(endRatio);
  const loopRef = useRef(loop);
  const seekSeen = useRef<number | null>(null);
  startRef.current = startRatio;
  endRef.current = endRatio;
  loopRef.current = loop;

  function clearStop() {
    if (stopTimer.current != null) window.clearTimeout(stopTimer.current);
    stopTimer.current = null;
  }

  function holdAt(audio: HTMLAudioElement) {
    const span = playWindow(audio.duration, startRef.current, endRef.current);
    const wait = stopInMs(audio.currentTime, span.stop, endRef.current);
    clearStop();
    if (audio.paused || wait == null) return;
    if (wait === 0) {
      if (loopRef.current) {
        audio.currentTime = span.start;
        setTime(span.start);
        const again = stopInMs(span.start, span.stop, endRef.current);
        if (again && again > 0) {
          stopTimer.current = window.setTimeout(() => holdAt(audio), again);
        }
        return;
      }
      audio.pause();
      audio.currentTime = span.start;
      setTime(span.start);
      return;
    }
    stopTimer.current = window.setTimeout(() => {
      if (audio.paused) return;
      audio.pause();
      const again = playWindow(audio.duration, startRef.current, endRef.current);
      audio.currentTime = again.start;
      setTime(again.start);
    }, wait);
  }

  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    setPlaying(false);
    setTime(0);
    setDur(0);
    setFailed(false);
    reported.current = false;
    return () => {
      URL.revokeObjectURL(next);
      if (stopTimer.current != null) window.clearTimeout(stopTimer.current);
    };
  }, [blob]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = rate > 0 ? rate : 1;
  }, [rate, url]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !seekTo || seekSeen.current === seekTo.token || !Number.isFinite(audio.duration)) return;
    seekSeen.current = seekTo.token;
    audio.currentTime = Math.min(audio.duration, Math.max(0, seekTo.ratio * audio.duration));
    setTime(audio.currentTime);
  }, [seekTo, dur]);

  const progress = dur > 0 ? time / dur : 0;

  function toggle() {
    const audio = audioRef.current;
    if (!audio || failed) return;
    if (audio.paused) {
      const span = playWindow(audio.duration, startRef.current, endRef.current);
      if (audio.currentTime < span.start || audio.currentTime >= span.stop - 0.005) audio.currentTime = span.start;
      void audio.play().catch(() => setFailed(true));
    } else audio.pause();
  }

  function seek(ratio: number) {
    const audio = audioRef.current;
    if (!audio || failed || !Number.isFinite(audio.duration)) return;
    audio.currentTime = playWindow(audio.duration, ratio, endRef.current).start;
    setTime(audio.currentTime);
  }

  function skip(delta: number) {
    const audio = audioRef.current;
    if (!audio || failed || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + delta));
    setTime(audio.currentTime);
  }

  function remember(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    setDur(seconds);
    if (!reported.current) {
      reported.current = true;
      onDuration?.(seconds * 1000);
    }
  }

  return (
    <div className="rounded-3xl border border-line bg-surface p-4">
      <audio
        ref={audioRef}
        src={url ?? undefined}
        preload="auto"
        playsInline
        loop={loop}
        className="audio-clip"
        onPlay={(event) => {
          setPlaying(true);
          holdAt(event.currentTarget);
        }}
        onPause={() => {
          setPlaying(false);
          clearStop();
        }}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          holdAt(audio);
          setTime(audio.currentTime);
          if (audio.duration > 0) onRatio?.(audio.currentTime / audio.duration);
        }}
        onLoadedMetadata={(event) => {
          remember(event.currentTarget.duration);
          const start = playWindow(event.currentTarget.duration, startRef.current, endRef.current).start;
          if (start > 0.0005) event.currentTarget.currentTime = start;
        }}
        onDurationChange={(event) => remember(event.currentTarget.duration)}
        onError={() => setFailed(true)}
      />
      <Waveform peaks={peaks} progress={progress} rtl={locale === "ar"} onSeek={seek} label={t("play")} marks={marks} durationMs={dur * 1000} />
      {failed ? (
        <p className="mt-3 text-sm text-pretty text-danger" role="alert">
          {t("cannotPlay")}
        </p>
      ) : (
        <div className="mt-3 flex items-center gap-3">
          <button type="button" onClick={() => skip(-15)} className="press grid size-11 place-items-center rounded-full border border-line text-fg" aria-label={t("skipBack")}>
            <SkipBack className="size-4" />
          </button>
          <button
            type="button"
            onClick={toggle}
            className="press brand-fill grid size-12 place-items-center rounded-full"
            aria-label={playing ? t("pause") : t("play")}
          >
            {playing ? <Pause className="size-5" /> : <Play className="size-5 translate-x-px rtl:-translate-x-px" />}
          </button>
          <button type="button" onClick={() => skip(15)} className="press grid size-11 place-items-center rounded-full border border-line text-fg" aria-label={t("skipForward")}>
            <SkipForward className="size-4" />
          </button>
          <p className="text-sm tabular-nums text-muted">
            <span className="text-fg">{formatClock(time * 1000)}</span>
            <span> / {formatClock((dur || 0) * 1000)}</span>
          </p>
        </div>
      )}
    </div>
  );
}
