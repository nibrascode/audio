import { Link, useNavigate } from "@tanstack/react-router";
import { Minus, Plus, Redo2, Scissors, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BackLink, Frame } from "@/components/chrome";
import { AudioPlayer } from "@/components/player";
import { applyOps, decodePcm, pcmDuration, pcmToWav, peakOf, peaksFromPcm, resample, roomSlice, slicePcm, type EditOp, type Pcm } from "@/lib/edit";
import { findPhrases, nearestStop, stopsInPcm } from "@/lib/phrases";
import { encodeInBackground } from "@/lib/jobs";
import { formatClock, readDuration } from "@/lib/audio";
import { useI18n } from "@/lib/i18n";
import { useLibrary } from "@/lib/library";
import { joinEdges, keptSpans, ratioOf, stepTo } from "@/lib/fix";
import { streamEnergies, streamPeaks, streamPhrases, streamSlice } from "@/lib/stream";
import { burstMarks, energiesFromPcm, guardDrop, loopAround, matchGain, reviewRate, scaleSamples, similarMarks, tightenSavings } from "@/lib/studio-tools";
import { wavFromParts } from "@/lib/wav";
import { dropCallMarks, joinRanges, type Range } from "@/lib/join-ranges";
import { DenoiseSheet } from "@/components/denoise-sheet";

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

function clampView(start: number, span: number) {
  return Math.min(Math.max(0, 1 - span), Math.max(0, start));
}

function clampSpan(span: number, seconds: number) {
  const min = Math.min(1, 1.2 / Math.max(seconds, 1.2));
  return Math.min(1, Math.max(min, span));
}

function CutLane({
  bars,
  overview,
  cuts,
  marker,
  selected,
  viewStart,
  span,
  duration,
  stops = [],
  pins = [],
  onMarker,
  onSelect,
  onView,
}: {
  bars: number[];
  overview: number[];
  cuts: number[];
  marker: number;
  selected: number | null;
  viewStart: number;
  span: number;
  duration: number;
  stops?: number[];
  pins?: number[];
  onMarker: (value: number) => void;
  onSelect: (index: number) => void;
  onView: (start: number, span: number) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const mode = useRef<"none" | "marker" | "pan">("none");
  const panFrom = useRef({ x: 0, start: 0 });
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{ distance: number; span: number; anchor: number } | null>(null);
  const points = [0, ...cuts, 1];
  const shown = bars.length ? bars : Array.from({ length: 72 }, () => 0.16);
  const full = overview.length ? overview : Array.from({ length: 48 }, () => 0.16);
  const viewEnd = viewStart + span;

  function ratioFrom(clientX: number) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect?.width) return viewStart;
    return clamp(viewStart + ((clientX - rect.left) / rect.width) * span);
  }

  function pieceAt(ratio: number) {
    for (let index = 0; index < points.length - 1; index++) {
      const from = points[index] ?? 0;
      const to = points[index + 1] ?? 1;
      if (ratio >= from && ratio < to) return index;
    }
    return Math.max(0, points.length - 2);
  }

  function pinchDistance() {
    const values = [...pointers.current.values()];
    if (values.length < 2) return 0;
    return Math.abs((values[0] ?? 0) - (values[1] ?? 0));
  }

  return (
    <div className="mt-4">
      <div
        ref={ref}
        dir="ltr"
        className="relative h-32 touch-none overflow-hidden rounded-2xl border border-line bg-bg"
        onPointerDown={(event) => {
          pointers.current.set(event.pointerId, event.clientX);
          event.currentTarget.setPointerCapture(event.pointerId);
          if (pointers.current.size >= 2) {
            const xs = [...pointers.current.values()];
            const mid = ratioFrom(((xs[0] ?? 0) + (xs[1] ?? 0)) / 2);
            pinch.current = { distance: Math.max(12, pinchDistance()), span, anchor: mid };
            mode.current = "none";
            return;
          }
          const ratio = ratioFrom(event.clientX);
          const rect = ref.current?.getBoundingClientRect();
          const markerX = rect ? ((marker - viewStart) / span) * rect.width + rect.left : 0;
          if (Math.abs(event.clientX - markerX) < 22) {
            mode.current = "marker";
            onMarker(ratio);
          } else {
            mode.current = "pan";
            panFrom.current = { x: event.clientX, start: viewStart };
          }
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          pointers.current.set(event.pointerId, event.clientX);
          if (pinch.current && pointers.current.size >= 2) {
            const distance = Math.max(12, pinchDistance());
            const nextSpan = clampSpan(pinch.current.span * (pinch.current.distance / distance), duration / 1000);
            onView(clampView(pinch.current.anchor - nextSpan / 2, nextSpan), nextSpan);
            return;
          }
          if (mode.current === "marker") onMarker(ratioFrom(event.clientX));
          if (mode.current === "pan" && span < 0.999) {
            const rect = ref.current?.getBoundingClientRect();
            const width = rect?.width || 1;
            const delta = ((event.clientX - panFrom.current.x) / width) * span;
            onView(clampView(panFrom.current.start - delta, span), span);
          }
        }}
        onPointerUp={(event) => {
          const wasTap = mode.current === "pan" && Math.abs(event.clientX - panFrom.current.x) < 8 && pointers.current.size < 2;
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          if (wasTap) onSelect(pieceAt(ratioFrom(event.clientX)));
          if (pointers.current.size === 0) mode.current = "none";
        }}
        onPointerCancel={() => {
          pointers.current.clear();
          pinch.current = null;
          mode.current = "none";
        }}
      >
        <div className="flex h-full items-end gap-px px-1 pb-5">
          {shown.map((peak, index) => {
            const at = viewStart + ((index + 0.5) / shown.length) * span;
            const piece = pieceAt(at);
            return (
              <span
                key={index}
                className={cn("min-w-0 flex-1 rounded-full", selected === piece ? "bg-cyan" : "bg-violet/80")}
                style={{ height: `${Math.round(14 + Math.min(1, peak) * 70)}%` }}
              />
            );
          })}
        </div>
        {points.slice(0, -1).map((from, index) => {
          const to = points[index + 1] ?? 1;
          const left = Math.max(from, viewStart);
          const right = Math.min(to, viewEnd);
          if (right - left <= 0.0001) return null;
          return (
            <span
              key={`${from}-${to}`}
              className={cn("pointer-events-none absolute inset-y-0 border-x", selected === index ? "border-cyan" : "border-transparent")}
              style={{ left: `${((left - viewStart) / span) * 100}%`, width: `${((right - left) / span) * 100}%` }}
            >
              <span className="absolute inset-x-1 bottom-1 truncate text-[10px] tabular-nums text-muted">
                {formatClock(from * duration, span * duration < 10000)}
              </span>
            </span>
          );
        })}
        <span
          className="pointer-events-none absolute top-0 z-10 h-full w-0.5 -translate-x-1/2 bg-fg"
          style={{ left: `${((marker - viewStart) / span) * 100}%` }}
        />
        {stops.map((stop) => (
          <span key={stop} className="pointer-events-none absolute inset-y-2 w-px bg-amber-200/80" style={{ left: `${((stop - viewStart) / span) * 100}%` }} />
        ))}
        {pins.map((pin) => (
          <span key={pin} className="pointer-events-none absolute inset-y-1 w-0.5 bg-rose-300/90" style={{ left: `${((pin - viewStart) / span) * 100}%` }} />
        ))}
      </div>
      <div
        dir="ltr"
        className="relative mt-2 h-9 touch-none"
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = clamp((event.clientX - rect.left) / rect.width);
          event.currentTarget.setPointerCapture(event.pointerId);
          onView(clampView(ratio - span / 2, span), span);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = clamp((event.clientX - rect.left) / rect.width);
          onView(clampView(ratio - span / 2, span), span);
        }}
      >
        <div className="flex h-full items-end gap-px opacity-70">
          {full.map((peak, index) => (
            <span key={index} className="min-w-0 flex-1 rounded-full bg-line" style={{ height: `${Math.round(18 + Math.min(1, peak) * 82)}%` }} />
          ))}
        </div>
        <span
          className="pointer-events-none absolute inset-y-0 rounded-md border border-cyan bg-cyan/15"
          style={{ left: `${viewStart * 100}%`, width: `${span * 100}%` }}
        />
      </div>
      <p className="sr-only">{t("zoom")}</p>
    </div>
  );
}

import { cn } from "@/lib/utils";

function LongTake({
  title,
  sourceKind,
  blob,
  durationMs,
  peaks,
  marks,
  parentId,
  onFull,
}: {
  title: string;
  sourceKind: "record" | "import";
  blob: Blob;
  durationMs: number;
  peaks: number[];
  marks: number[];
  parentId: string;
  onFull: () => void;
}) {
  const { t } = useI18n();
  const library = useLibrary();
  const navigate = useNavigate();
  const [cuts, setCuts] = useState<number[]>([]);
  const [gone, setGone] = useState<Range[]>([]);
  const [spot, setSpot] = useState(0.5);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denoise, setDenoise] = useState(false);
  const [pausesOn, setPausesOn] = useState(false);
  const [stops, setStops] = useState<number[]>([]);
  const [joinBlob, setJoinBlob] = useState<Blob | null>(null);
  const [joinLoop, setJoinLoop] = useState(false);
  const [reviewOn, setReviewOn] = useState(false);
  const [heardRatio, setHeardRatio] = useState(0);
  const [clicks, setClicks] = useState<number[]>([]);
  const [likes, setLikes] = useState<number[]>([]);
  const [locks, setLocks] = useState<Range[]>([]);
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState(0);
  const past = useRef<{ cuts: number[]; gone: Range[] }[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const span = 1 / zoom;
  const gap = ratioOf(0.04, durationMs);
  const edges = [0, ...cuts.filter((cut, index, all) => cut > gap && cut < 1 - gap && all.indexOf(cut) === index).sort((a, b) => a - b), 1];
  const segments = edges.slice(0, -1).map((start, index) => ({ start, end: edges[index + 1] ?? 1 }));
  const shown = peaks.filter((_, index) => {
    const at = (index + 0.5) / Math.max(1, peaks.length);
    return at >= view && at < view + span;
  });
  const kept = segments.filter((segment) => !gone.some((item) => Math.abs(item.start - segment.start) < 1e-5 && Math.abs(item.end - segment.end) < 1e-5));

  useEffect(() => {
    if (!pausesOn) return;
    let cancel = false;
    void streamPhrases(blob).then((phrases) => {
      if (cancel || !phrases) return;
      const next: number[] = [];
      for (const phrase of phrases) {
        if (phrase.start > gap && phrase.start < 1 - gap) next.push(phrase.start);
        if (phrase.end > gap && phrase.end < 1 - gap) next.push(phrase.end);
      }
      setStops(next);
    });
    return () => {
      cancel = true;
    };
  }, [pausesOn, blob]);

  function jump(direction: 1 | -1) {
    const marks = pausesOn && stops.length ? stops : cuts;
    const next = stepTo(spot, marks, direction);
    setSpot(next);
    setView(Math.min(Math.max(0, next - span / 2), Math.max(0, 1 - span)));
    const index = segments.findIndex((segment) => next >= segment.start && next < segment.end);
    setSelected(index >= 0 ? index : null);
  }

  async function hearJoin() {
    const edges = joinEdges(keptSpans(cuts, gone), spot, 1.4, durationMs / 1000);
    if (!edges) return;
    setBusy(true);
    setError(null);
    try {
      const left = await streamSlice(blob, edges.leftFrom, edges.leftTo);
      const right = await streamSlice(blob, edges.rightFrom, edges.rightTo);
      if (!left || !right) {
        setError(t("editFail"));
        return;
      }
      const rate = left.sampleRate;
      const second = right.sampleRate === rate ? right.samples : right.samples;
      setJoinBlob(wavFromParts([left.samples, second], rate));
    } catch {
      setError(t("editFail"));
    } finally {
      setBusy(false);
    }
  }

  function remember() {
    past.current = [...past.current.slice(-29), { cuts: [...cuts], gone: gone.map((item) => ({ ...item })) }];
    setCanUndo(true);
  }

  function undoCut() {
    const prev = past.current.pop();
    if (!prev) return;
    setCuts(prev.cuts);
    setGone(prev.gone);
    setSelected(null);
    setCanUndo(past.current.length > 0);
  }

  function addCut() {
    if (cuts.some((cut) => Math.abs(cut - spot) < gap)) return;
    remember();
    setCuts((current) => [...current, spot].sort((a, b) => a - b));
    setSelected(null);
  }

  function dropSide() {
    const segment = selected == null ? null : segments[selected];
    if (!segment || kept.length < 2) return;
    if (locks.some((lock) => Math.abs(lock.start - segment.start) < 1e-5 && Math.abs(lock.end - segment.end) < 1e-5)) {
      setError(t("protectKept"));
      return;
    }
    remember();
    setGone((current) => [...current, segment]);
    setSelected(null);
  }

  async function saveKept() {
    if (busy || !kept.length) return;
    setBusy(true);
    setError(null);
    try {
      const joined = await joinRanges(blob, kept, 0);
      if (!joined) {
        setError(t("editFail"));
        return;
      }
      const created = await library.addProject({
        title: `${title} · ${t("trim")}`.slice(0, 80),
        note: "",
        blob: joined.blob,
        mimeType: "audio/wav",
        durationMs: Math.round(joined.durationMs),
        source: sourceKind,
        peaks: peaks.length ? peaks : [0.2],
        parentId,
      });
      await navigate({ to: "/p/$id", params: { id: created.id } });
    } catch {
      setError(t("storageFail"));
    } finally {
      setBusy(false);
    }
  }

  async function removeCalls() {
    if (busy || !marks.length) return;
    setBusy(true);
    setError(null);
    try {
      const joined = await dropCallMarks(blob, durationMs, marks);
      if (!joined) {
        setError(t("editFail"));
        return;
      }
      const created = await library.addProject({
        title: `${title} · ${t("callMark")}`.slice(0, 80),
        note: "",
        blob: joined.blob,
        mimeType: "audio/wav",
        durationMs: Math.round(joined.durationMs),
        source: sourceKind,
        peaks: peaks.length ? peaks : [0.2],
        parentId,
      });
      await navigate({ to: "/p/$id", params: { id: created.id } });
    } catch {
      setError(t("storageFail"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <header className="flex items-center justify-between gap-3">
        <BackLink />
        <h1 className="truncate text-base font-semibold">{t("edit")}</h1>
        <button type="button" disabled={!canUndo} onClick={undoCut} className="press grid size-10 place-items-center rounded-full border border-line disabled:opacity-40" aria-label={t("undo")}>
          <Undo2 className="size-4" />
        </button>
      </header>
      <p className="mt-4 truncate text-lg font-semibold">{title}</p>
      <p className="mt-1 text-sm text-pretty text-muted">{t("longHint")}</p>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" aria-label={t("zoom")} onClick={() => setZoom((value) => Math.max(1, value / 1.7))} className="press grid size-10 place-items-center rounded-full border border-line"><Minus className="size-4" /></button>
        <button type="button" aria-label={t("zoom")} onClick={() => setZoom((value) => Math.min(durationMs / 1200, value * 1.7))} className="press grid size-10 place-items-center rounded-full border border-line"><Plus className="size-4" /></button>
        <span className="text-xs tabular-nums text-faint">{formatClock(spot * durationMs, span < 0.05)} · {formatClock(span * durationMs)}</span>
      </div>
      <div
        dir="ltr"
        className="relative mt-3 h-24 touch-none overflow-hidden rounded-2xl border border-line bg-bg"
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const origin = event.clientX;
          const from = view;
          const place = (clientX: number) => Math.min(1 - gap, Math.max(gap, from + ((clientX - rect.left) / rect.width) * span));
          const move = (ev: PointerEvent) => {
            if (Math.abs(ev.clientX - origin) < 8) return;
            const delta = ((ev.clientX - origin) / rect.width) * span;
            setView(Math.min(Math.max(0, 1 - span), from - delta));
          };
          const up = (ev: PointerEvent) => {
            event.currentTarget.removeEventListener("pointermove", move);
            event.currentTarget.removeEventListener("pointerup", up);
            if (Math.abs(ev.clientX - origin) < 8) {
              const at = pausesOn ? nearestStop(stops, place(ev.clientX), span * 0.04) : place(ev.clientX);
              setSpot(at);
              const index = segments.findIndex((segment) => at >= segment.start && at < segment.end);
              setSelected(index >= 0 ? index : null);
            }
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.addEventListener("pointermove", move);
          event.currentTarget.addEventListener("pointerup", up);
        }}
      >
        <div className="flex h-full items-end gap-px px-1">
          {(shown.length ? shown : [0.2]).map((peak, index) => (
            <span key={index} className="min-w-0 flex-1 rounded-full bg-violet/80" style={{ height: `${Math.round(18 + peak * 70)}%` }} />
          ))}
        </div>
        {segments.map((segment) => {
          const left = ((segment.start - view) / span) * 100;
          const width = ((segment.end - segment.start) / span) * 100;
          if (segment.end < view || segment.start > view + span) return null;
          const index = segments.indexOf(segment);
          const dead = gone.some((item) => Math.abs(item.start - segment.start) < 1e-5 && Math.abs(item.end - segment.end) < 1e-5);
          if (!dead && selected !== index) return null;
          return <span key={`${segment.start}-${segment.end}`} className={`pointer-events-none absolute inset-y-0 ${dead ? "bg-bg/70" : "bg-cyan/15"}`} style={{ left: `${left}%`, width: `${Math.max(width, 1.5)}%` }} />;
        })}
        {cuts.map((cut) => (
          <span key={cut} className="pointer-events-none absolute inset-y-1 w-0.5 bg-cyan" style={{ left: `${((cut - view) / span) * 100}%` }} />
        ))}
        {marks.map((mark) => (
          <span key={mark} className="pointer-events-none absolute inset-y-1 w-px bg-danger" style={{ left: `${((mark / Math.max(durationMs, 1) - view) / span) * 100}%` }} />
        ))}
        {stops.map((stop) => (
          <span key={stop} className="pointer-events-none absolute inset-y-1 w-px bg-amber-200/80" style={{ left: `${((stop - view) / span) * 100}%` }} />
        ))}
        {[...clicks, ...likes].map((pin) => (
          <span key={pin} className="pointer-events-none absolute inset-y-1 w-0.5 bg-rose-300/90" style={{ left: `${((pin - view) / span) * 100}%` }} />
        ))}
        <span className="pointer-events-none absolute inset-y-1 w-0.5 -translate-x-1/2 bg-fg" style={{ left: `${((spot - view) / span) * 100}%` }} />
      </div>
      <p className="mt-2 text-xs text-pretty text-faint">{t("fadeJoin")}</p>
      {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => jump(-1)} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold">{t("prevMark")}</button>
        <button type="button" onClick={() => jump(1)} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold">{t("nextMark")}</button>
        <button type="button" disabled={busy || cuts.length < 1} onClick={() => { setJoinLoop(false); void hearJoin(); }} className="press col-span-2 min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("hearJoin")}</button>
        <button type="button" disabled={busy || cuts.length < 1} onClick={() => { setJoinLoop(true); void hearJoin(); }} className="press col-span-2 min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("loopJoin")}</button>
        <button type="button" onClick={() => setReviewOn((value) => !value)} className={cn("press min-h-12 rounded-2xl border text-sm font-semibold", reviewOn ? "border-cyan text-cyan" : "border-line")}>{t("reviewFast")}</button>
        <button type="button" disabled={busy} onClick={() => {
          setBusy(true);
          setError(null);
          void streamEnergies(blob).then((energies) => {
            const found = energies ? burstMarks(energies, 0.01) : [];
            setClicks(found);
            if (!found.length) setError(t("noPhrase"));
          }).catch(() => setError(t("editFail"))).finally(() => setBusy(false));
        }} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("coughMarks")}</button>
        <button type="button" disabled={busy} onClick={() => {
          setBusy(true);
          setError(null);
          void streamEnergies(blob).then((energies) => {
            const found = energies ? similarMarks(energies, spot, 0.01) : [];
            setLikes(found);
            if (!found.length) setError(t("noSame"));
          }).catch(() => setError(t("editFail"))).finally(() => setBusy(false));
        }} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("findSame")}</button>
        <button type="button" disabled={selected == null} onClick={() => {
          const segment = selected == null ? null : segments[selected];
          if (!segment) return;
          setLocks((current) => current.some((lock) => Math.abs(lock.start - segment.start) < 1e-5) ? current.filter((lock) => Math.abs(lock.start - segment.start) >= 1e-5) : [...current, segment]);
        }} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("protect")}</button>
        <button type="button" disabled={busy} onClick={addCut} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("cutHere")}</button>
        <button type="button" onClick={() => setPausesOn((value) => !value)} className={cn("press min-h-12 rounded-2xl border text-sm font-semibold", pausesOn ? "border-amber-200 text-amber-100" : "border-line")}>{t("pauseHelp")}</button>
        <button type="button" disabled={busy || selected == null || kept.length < 2} onClick={dropSide} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold text-danger disabled:opacity-40">{t("deleteSide")}</button>
        <button type="button" disabled={busy || kept.length === segments.length} onClick={() => void saveKept()} className="press brand-fill col-span-2 min-h-12 rounded-2xl text-sm font-semibold disabled:opacity-40">{t("saveResult")}</button>
        {marks.length ? (
          <button type="button" disabled={busy} onClick={() => void removeCalls()} className="press col-span-2 min-h-12 rounded-2xl border border-line text-sm font-semibold text-cyan disabled:opacity-40">{t("dropCall")}</button>
        ) : null}
        <button type="button" onClick={() => setDenoise(true)} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold">{t("denoise")}</button>
        <button type="button" onClick={onFull} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold">{t("longFull")}</button>
      </div>
      {joinBlob ? <div className="mt-3"><AudioPlayer blob={joinBlob} peaks={[]} loop={joinLoop} /></div> : null}
      <div className="mt-3"><AudioPlayer blob={blob} peaks={peaks} startRatio={selected == null ? spot : (segments[selected]?.start ?? spot)} endRatio={selected == null ? 1 : (segments[selected]?.end ?? 1)} marks={marks} rate={reviewOn ? reviewRate(heardRatio, [...stops, ...clicks, ...likes, ...cuts], 0.012) : 1} onRatio={setHeardRatio} /></div>
      {denoise ? <DenoiseSheet blob={blob} title={title} source={sourceKind} onClose={() => setDenoise(false)} /> : null}
    </Frame>
  );
}

export function EditorScreen({ id }: { id: string }) {
  const { t } = useI18n();
  const library = useLibrary();
  const navigate = useNavigate();
  const project = library.projects.find((item) => item.id === id);
  const [original, setOriginal] = useState<Pcm | null>(null);
  const [source, setSource] = useState<{ blob: Blob; durationMs: number; peaks: number[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [ops, setOps] = useState<EditOp[]>([]);
  const [future, setFuture] = useState<EditOp[]>([]);
  const [cuts, setCuts] = useState<number[]>([]);
  const [cutPast, setCutPast] = useState<number[][]>([]);
  const [pausesOn, setPausesOn] = useState(false);
  const [marker, setMarker] = useState(0.5);
  const [selected, setSelected] = useState<number | null>(null);
  const [zoomSpan, setZoomSpan] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const [reversed, setReversed] = useState(false);
  const [rawEar, setRawEar] = useState(false);
  const [scraps, setScraps] = useState<Pcm[]>([]);
  const [take2, setTake2] = useState<Pcm | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const playRatio = useRef(0);
  const takeRef = useRef<HTMLInputElement>(null);
  const [gain, setGain] = useState(1);
  const [locks, setLocks] = useState<Range[]>([]);
  const [clicks, setClicks] = useState<number[]>([]);
  const [likes, setLikes] = useState<number[]>([]);
  const [reviewOn, setReviewOn] = useState(false);
  const [loopBlob, setLoopBlob] = useState<Blob | null>(null);
  const [heardRatio, setHeardRatio] = useState(0);
  const [fade, setFade] = useState(0.8);
  const [joining, setJoining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [preview, setPreview] = useState<Blob | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!library.ready) return;
    let cancel = false;
    setOriginal(null);
    setSource(null);
    setFailed(false);
    setOps([]);
    setFuture([]);
    void library.getAudio(id).then(async (blob) => {
      if (cancel) return;
      if (!blob) {
        setFailed(true);
        return;
      }
      try {
        const known = library.projects.find((item) => item.id === id)?.durationMs ?? 0;
        const durationMs = known || (await readDuration(blob)) || 0;
        if (durationMs > 30000) {
          const peaks = (await streamPeaks(blob, 1000)) ?? [];
          if (!cancel) setSource({ blob, durationMs, peaks });
          return;
        }
        const pcm = await decodePcm(blob);
        if (!cancel) setOriginal(pcm);
      } catch {
        if (!cancel) setFailed(true);
      }
    });
    return () => {
      cancel = true;
    };
  }, [library.ready, library.getAudio, id]);

  useEffect(() => {
    if (!original) return;
    try {
      if (sessionStorage.getItem("nibras-join") === "1") {
        sessionStorage.removeItem("nibras-join");
        setJoining(true);
      }
    } catch {
      /* ignore */
    }
  }, [original]);

  const working = useMemo(() => (original ? applyOps(original, ops) : null), [original, ops]);
  const heard = useMemo(() => {
    if (!working || !reversed) return working;
    const samples = new Float32Array(working.samples.length);
    for (let i = 0; i < samples.length; i++) samples[i] = working.samples[samples.length - 1 - i] ?? 0;
    return { samples, sampleRate: working.sampleRate };
  }, [working, reversed]);
  const shown = rawEar && original ? original : heard;
  const hot = useMemo(() => (working ? peakOf(working.samples) > 0.98 : false), [working]);
  const secondPhrases = useMemo(() => (take2 ? findPhrases(take2.samples, take2.sampleRate) : []), [take2]);
  const peaks = useMemo(() => (working ? peaksFromPcm(working.samples) : []), [working]);
  const seconds = Math.max(1.2, (working ? pcmDuration(working) : 1000) / 1000);
  const windowPeaks = useMemo(() => {
    if (!working) return [];
    const from = Math.floor(viewStart * working.samples.length);
    const to = Math.max(from + 1, Math.ceil((viewStart + zoomSpan) * working.samples.length));
    return peaksFromPcm(working.samples.subarray(from, to), 96);
  }, [working, viewStart, zoomSpan]);
  const phrases = useMemo(() => (working ? findPhrases(working.samples, working.sampleRate) : []), [working]);
  const stops = useMemo(() => (pausesOn && working ? stopsInPcm(working.samples, working.sampleRate) : []), [pausesOn, working]);
  const points = [0, ...cuts, 1];
  const piece = selected != null ? { start: points[selected] ?? 0, end: points[selected + 1] ?? 1 } : null;
  const others = library.projects.filter((item) => item.id !== id);

  useEffect(() => {
    if (!shown) return;
    let stop = false;
    if (shown.samples.length < 48000 * 20) {
      setPreview(pcmToWav(shown));
      setRendering(false);
      return;
    }
    setRendering(true);
    const job = encodeInBackground(shown.samples, shown.sampleRate, "wav", () => undefined);
    void job.done.then(
      (blob) => {
        if (stop) return;
        setPreview(blob);
        setRendering(false);
      },
      () => {
        if (!stop) setRendering(false);
      },
    );
    return () => {
      stop = true;
      job.cancel();
    };
  }, [shown]);

  function commit(op: EditOp) {
    setOps((prev) => [...prev, op]);
    setFuture([]);
    setCuts([]);
    setCutPast([]);
    setSelected(null);
    setMarker(0.5);
    setError(null);
  }

  function undo() {
    if (cutPast.length) {
      const previous = cutPast[cutPast.length - 1] ?? [];
      setCutPast((past) => past.slice(0, -1));
      setCuts(previous);
      setSelected(null);
      return;
    }
    const last = ops[ops.length - 1];
    if (!last) return;
    setOps(ops.slice(0, -1));
    setFuture([last, ...future]);
    setCuts([]);
    setCutPast([]);
    setSelected(null);
  }

  function redo() {
    const [next, ...rest] = future;
    if (!next) return;
    setOps([...ops, next]);
    setFuture(rest);
    setCuts([]);
    setCutPast([]);
    setSelected(null);
  }

  function keepScrap(start: number, end: number) {
    if (!working) return;
    const slice = slicePcm(working, start, end);
    if (slice.samples.length < 8) return;
    setScraps((prev) => [...prev, slice].slice(-12));
  }

  function listenPhrase(index: number) {
    const phrase = phrases[index];
    if (!phrase || !working) return;
    const slice = slicePcm(working, phrase.start, phrase.end);
    const url = URL.createObjectURL(pcmToWav(slice));
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    void audio.play().catch(() => URL.revokeObjectURL(url));
  }

  function listenSlice(pcm: Pcm, phrase: { start: number; end: number }) {
    const slice = slicePcm(pcm, phrase.start, phrase.end);
    const url = URL.createObjectURL(pcmToWav(slice));
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    void audio.play().catch(() => URL.revokeObjectURL(url));
  }

  async function loadTake(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const pcm = await decodePcm(file);
      if (pcm.samples.length < 8) throw new Error("short");
      setTake2(pcm);
      setPicks([]);
    } catch {
      setError(t("editFail"));
    }
  }

  function buildTakes() {
    if (!working || !take2) return;
    const rows = Math.max(phrases.length, secondPhrases.length);
    const parts: Float32Array[] = [];
    let total = 0;
    for (let index = 0; index < rows; index++) {
      const useSecond = (picks[index] ?? 0) === 1 && secondPhrases[index];
      const phrase = useSecond ? secondPhrases[index] : phrases[index];
      const source = useSecond ? take2 : working;
      if (!phrase) continue;
      const slice = slicePcm(source, phrase.start, phrase.end);
      const samples = slice.sampleRate === working.sampleRate ? slice.samples : resample(slice.samples, slice.sampleRate, working.sampleRate);
      parts.push(samples);
      total += samples.length;
    }
    if (total < 8) return;
    const samples = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
    }
    commit({ kind: "replace", samples, sampleRate: working.sampleRate });
    setTake2(null);
    setPicks([]);
  }

  function markerFree(value: number) {
    if (!working) return false;
    const near = ratioOf(0.04, pcmDuration(working));
    if (value < near || value > 1 - near) return false;
    return cuts.every((cut) => Math.abs(cut - value) > near);
  }

  async function savePcm(pcm: Pcm, suffix: string) {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    setStatus(t("processing"));
    try {
      const job = encodeInBackground(pcm.samples, pcm.sampleRate, "wav", (ratio) => setStatus(`${t("processing")} ${Math.round(ratio * 100)}%`));
      const blob = await job.done;
      if (blob.size < 44) throw new Error("incomplete");
      const meta = await library.addProject({
        title: `${project.title} · ${suffix}`.slice(0, 80),
        note: "",
        blob,
        mimeType: "audio/wav",
        durationMs: Math.round(pcmDuration(pcm)),
        source: project.source,
        peaks: peaksFromPcm(pcm.samples),
        parentId: project.id,
      });
      await navigate({ to: "/p/$id", params: { id: meta.id } });
    } catch {
      setError(t("storageFail"));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  async function appendProject(otherId: string) {
    if (!working) return;
    setError(null);
    try {
      const blob = await library.getAudio(otherId);
      if (!blob) {
        setError(t("editFail"));
        return;
      }
      const pcm = await decodePcm(blob);
      commit({ kind: "append", samples: pcm.samples, sampleRate: pcm.sampleRate });
      setJoining(false);
    } catch {
      setError(t("editFail"));
    }
  }

  if (!library.ready || (project && !original && !source && !failed)) {
    return (
      <Frame>
        <BackLink />
        <p className="mt-8 text-sm text-muted">{t("loading")}</p>
      </Frame>
    );
  }

  if (source && !original && project) {
    return <LongTake title={project.title} sourceKind={project.source} blob={source.blob} durationMs={source.durationMs} peaks={source.peaks} marks={project.marks ?? []} parentId={project.id} onFull={() => {
      setStatus(t("processing"));
      void decodePcm(source.blob).then((pcm) => {
        setOriginal(pcm);
        setSource(null);
        setStatus(null);
      }).catch(() => {
        setFailed(true);
        setStatus(null);
      });
    }} />;
  }

  if (!project || failed || !working) {
    return (
      <Frame>
        <BackLink />
        <h1 className="mt-8 text-2xl font-semibold">{t("editFail")}</h1>
      </Frame>
    );
  }

  return (
    <Frame>
      <header className="flex items-center justify-between gap-3">
        <BackLink />
        <h1 className="truncate text-base font-semibold">{t("edit")}</h1>
        <span className="w-16" />
      </header>
      <p className="mt-4 truncate text-lg font-semibold">{project.title}</p>
      <p className="mt-1 text-sm text-pretty text-muted">{t("originalKept")}</p>
      <p className="mt-3 text-sm tabular-nums text-muted">{formatClock(marker * pcmDuration(working), zoomSpan < 0.25)} / {formatClock(pcmDuration(working))}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={t("zoom")}
          onClick={() => {
            const next = clampSpan(zoomSpan * 1.7, seconds);
            setZoomSpan(next);
            setViewStart(clampView(marker - next / 2, next));
          }}
          className="press inline-flex size-10 items-center justify-center rounded-full border border-line"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t("zoom")}
          onClick={() => {
            const next = clampSpan(zoomSpan / 1.7, seconds);
            setZoomSpan(next);
            setViewStart(clampView(marker - next / 2, next));
          }}
          className="press inline-flex size-10 items-center justify-center rounded-full border border-line"
        >
          <Plus className="size-4" />
        </button>
        <span className="text-xs tabular-nums text-faint">{formatClock(zoomSpan * pcmDuration(working))}</span>
        <button type="button" onClick={() => {
          const next = clamp(marker - 80 / Math.max(pcmDuration(working), 1));
          setMarker(next);
          if (next < viewStart + zoomSpan * 0.12) setViewStart(clampView(next - zoomSpan * 0.25, zoomSpan));
        }} className="press min-h-10 rounded-full border border-line px-3 text-sm font-semibold">
          −0.08s
        </button>
        <button type="button" onClick={() => {
          const next = clamp(marker + 80 / Math.max(pcmDuration(working), 1));
          setMarker(next);
          if (next > viewStart + zoomSpan * 0.88) setViewStart(clampView(next - zoomSpan * 0.75, zoomSpan));
        }} className="press min-h-10 rounded-full border border-line px-3 text-sm font-semibold">
          +0.08s
        </button>
        <button
          type="button"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setRawEar(true);
          }}
          onPointerUp={() => setRawEar(false)}
          onPointerCancel={() => setRawEar(false)}
          className={cn("press min-h-10 rounded-full border px-3 text-sm font-semibold", rawEar ? "border-cyan text-cyan" : "border-line")}
          title={t("holdOriginal")}
        >
          {t("holdOriginal")}
        </button>
        <button type="button" disabled={phrases.length < 2} onClick={() => commit({ kind: "tighten", gap: 0.5 })} className="press min-h-10 rounded-full border border-line px-3 text-sm font-semibold disabled:opacity-40">
          {t("tighten")}
          {working && phrases.length > 1 ? ` · −${formatClock(tightenSavings(working.samples.length, working.sampleRate, phrases, 0.5).removedMs)}` : ""}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!working) return;
            const room = roomSlice(working, 0.4);
            commit({ kind: "insert", at: marker, samples: room.samples, sampleRate: room.sampleRate });
          }}
          className="press min-h-10 rounded-full border border-line px-3 text-sm font-semibold"
        >
          {t("roomTone")}
        </button>
      </div>

      <div className="px-1">
        <CutLane
          bars={windowPeaks}
          overview={peaks}
          cuts={cuts}
          marker={marker}
          selected={selected}
          viewStart={viewStart}
          span={zoomSpan}
          duration={pcmDuration(working)}
          stops={stops}
          pins={[...clicks, ...likes]}
          onMarker={(value) => {
            const next = pausesOn ? nearestStop(stops, clamp(value), Math.max(ratioOf(0.03, pcmDuration(working)), zoomSpan * 0.035)) : clamp(value);
            setMarker(next);
            if (next < viewStart + zoomSpan * 0.08) setViewStart(clampView(next - zoomSpan * 0.2, zoomSpan));
            if (next > viewStart + zoomSpan * 0.92) setViewStart(clampView(next - zoomSpan * 0.8, zoomSpan));
          }}
          onSelect={(index) => setSelected((current) => (current === index ? null : index))}
          onView={(start, nextSpan) => {
            setZoomSpan(clampSpan(nextSpan, seconds));
            setViewStart(clampView(start, clampSpan(nextSpan, seconds)));
          }}
        />
      </div>
      <p className="mt-2 text-sm text-pretty text-faint">{t("editHint")}</p>

      <section className="mt-4">
        <h2 className="text-sm font-medium text-faint">{t("phrases")}</h2>
        {phrases.length < 2 ? (
          <p className="mt-2 text-sm text-muted">{t("noPhrase")}</p>
        ) : (
          <ul className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {phrases.map((phrase, index) => (
              <li key={`${phrase.start}-${phrase.end}`} className="w-36 shrink-0 rounded-2xl border border-line bg-surface p-2">
                <button type="button" onClick={() => listenPhrase(index)} className="press min-h-10 w-full text-start text-sm font-semibold">
                  {formatClock(phrase.start * pcmDuration(working))}
                </button>
                <div className="mt-1 grid grid-cols-3 gap-1">
                  <button type="button" disabled={index === 0} onClick={() => {
                    const left = phrases[index - 1];
                    const right = phrase;
                    if (!left) return;
                    commit({ kind: "swap", a0: left.start, a1: left.end, b0: right.start, b1: right.end });
                  }} className="press min-h-9 rounded-xl border border-line text-[11px] font-semibold disabled:opacity-40">{t("phraseEarlier")}</button>
                  <button type="button" disabled={index === phrases.length - 1} onClick={() => {
                    const right = phrases[index + 1];
                    if (!right) return;
                    commit({ kind: "swap", a0: phrase.start, a1: phrase.end, b0: right.start, b1: right.end });
                  }} className="press min-h-9 rounded-xl border border-line text-[11px] font-semibold disabled:opacity-40">{t("phraseLater")}</button>
                  <button type="button" onClick={() => {
                    const pieces = guardDrop(phrase.start, phrase.end, locks);
                    if (!pieces.length) {
                      setError(t("protectKept"));
                      return;
                    }
                    for (const part of pieces) {
                      keepScrap(part.start, part.end);
                      commit({ kind: "drop", start: part.start, end: part.end });
                    }
                  }} className="press min-h-9 rounded-xl border border-line text-[11px] font-semibold text-danger">{t("phraseDrop")}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {scraps.length > 0 ? (
        <section className="mt-4">
          <h2 className="text-sm font-medium text-faint">{t("scraps")}</h2>
          <ul className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {scraps.map((scrap, index) => (
              <li key={`${scrap.samples.length}-${index}`}>
                <button
                  type="button"
                  onClick={() => {
                    if (!working) return;
                    const neighbor = slicePcm(working, Math.max(0, marker - 0.15), Math.min(1, marker + 0.15));
                    const gain = matchGain(scrap.samples, neighbor.samples);
                    const matched = scaleSamples(scrap.samples, gain);
                    commit({ kind: "insert", at: marker, samples: matched, sampleRate: scrap.sampleRate });
                    setScraps((prev) => prev.filter((_, item) => item !== index));
                  }}
                  className="press min-h-11 rounded-full border border-line bg-surface px-3 text-sm font-semibold"
                >
                  {t("putBack")} · {formatClock(pcmDuration(scrap))}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={!markerFree(marker)}
          onClick={() => {
            setCutPast((past) => [...past, cuts]);
            setCuts((prev) => [...prev, marker].sort((a, b) => a - b));
            setSelected(null);
            setError(null);
          }}
          className="press inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-line bg-surface text-sm font-semibold disabled:opacity-40"
        >
          <Scissors className="size-4" />
          {t("trim")}
        </button>
        <button
          type="button"
          onClick={() => setPausesOn((value) => !value)}
          className={cn("press min-h-12 rounded-2xl border text-sm font-semibold", pausesOn ? "border-amber-200 text-amber-100" : "border-line")}
        >
          {t("pauseHelp")}
        </button>
        <button type="button" disabled={!working} onClick={() => {
          if (!working) return;
          const span = loopAround(marker, 2, pcmDuration(working) / 1000);
          setLoopBlob(pcmToWav(slicePcm(working, span.start, span.end)));
        }} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("loopJoin")}</button>
        <button type="button" onClick={() => setReviewOn((value) => !value)} className={cn("press min-h-12 rounded-2xl border text-sm font-semibold", reviewOn ? "border-cyan text-cyan" : "border-line")}>{t("reviewFast")}</button>
        <button type="button" disabled={!working} onClick={() => {
          if (!working) return;
          const found = burstMarks(energiesFromPcm(working.samples, working.sampleRate), 0.01);
          setClicks(found);
          if (!found.length) setError(t("noPhrase"));
        }} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("coughMarks")}</button>
        <button type="button" disabled={!working} onClick={() => {
          if (!working) return;
          const found = similarMarks(energiesFromPcm(working.samples, working.sampleRate), marker, 0.01);
          setLikes(found);
          if (!found.length) setError(t("noSame"));
          else setMarker(found[0] ?? marker);
        }} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("findSame")}</button>
        <button type="button" disabled={!piece} onClick={() => {
          if (!piece) return;
          setLocks((current) => current.some((lock) => Math.abs(lock.start - piece.start) < 1e-5 && Math.abs(lock.end - piece.end) < 1e-5) ? current.filter((lock) => Math.abs(lock.start - piece.start) >= 1e-5) : [...current, piece]);
        }} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40">{t("protect")}</button>
        <button
          type="button"
          disabled={!piece || points.length < 3}
          onClick={() => {
            if (!piece) return;
            const pieces = guardDrop(piece.start, piece.end, locks);
            if (!pieces.length) {
              setError(t("protectKept"));
              return;
            }
            for (const part of pieces) {
              keepScrap(part.start, part.end);
              commit({ kind: "drop", start: part.start, end: part.end });
            }
          }}
          className="press min-h-12 rounded-2xl border border-line bg-surface text-sm font-semibold text-danger disabled:opacity-40"
        >
          {t("deleteSide")}
        </button>
        <button
          type="button"
          disabled={busy || !piece || pcmDuration(working) * (piece.end - piece.start) < 40}
          onClick={() => {
            if (!piece || !working) return;
            const slice = slicePcm(working, piece.start, piece.end);
            if (pcmDuration(slice) < 40) {
              setError(t("tooShort"));
              return;
            }
            void savePcm(slice, t("saveSelection"));
          }}
          className="press col-span-2 min-h-12 rounded-2xl border border-line bg-surface text-sm font-semibold disabled:opacity-40"
        >
          {t("saveSelection")}
        </button>
      </div>

      <div className="mt-5 rounded-3xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">{t("volume")}</span>
          <span className="tabular-nums">{Math.round(gain * 100)}%</span>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" aria-label={t("volume")} onClick={() => setGain((value) => Math.max(0.25, Math.round((value - 0.1) * 10) / 10))} className="press grid size-11 place-items-center rounded-full border border-line">
            <Minus className="size-4" />
          </button>
          <input className="nibras-range" type="range" min={0.25} max={2} step={0.05} value={gain} onChange={(event) => setGain(Number(event.target.value))} />
          <button type="button" aria-label={t("volume")} onClick={() => setGain((value) => Math.min(2, Math.round((value + 0.1) * 10) / 10))} className="press grid size-11 place-items-center rounded-full border border-line">
            <Plus className="size-4" />
          </button>
        </div>
        <button
          type="button"
          disabled={Math.abs(gain - 1) < 0.02}
          onClick={() => {
            commit({ kind: "gain", gain });
            setGain(1);
          }}
          className="press mt-3 min-h-11 w-full rounded-2xl border border-line text-sm font-semibold disabled:opacity-40"
        >
          {t("apply")}
        </button>
      </div>

      <div className="mt-3 rounded-3xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">{t("seconds")}</span>
          <span className="tabular-nums">{fade.toFixed(1)}</span>
        </div>
        <input className="nibras-range mt-2" type="range" min={0.1} max={8} step={0.1} value={fade} onChange={(event) => setFade(Number(event.target.value))} />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button type="button" onClick={() => commit({ kind: "fadeIn", seconds: fade })} className="press min-h-11 rounded-2xl border border-line text-sm font-semibold">
            {t("fadeIn")}
          </button>
          <button type="button" onClick={() => commit({ kind: "fadeOut", seconds: fade })} className="press min-h-11 rounded-2xl border border-line text-sm font-semibold">
            {t("fadeOut")}
          </button>
        </div>
      </div>

      <div className="mt-4">
        {rendering ? <p className="mb-2 text-sm text-muted">{t("preparing")}</p> : null}
        {loopBlob ? <div className="mt-3"><AudioPlayer blob={loopBlob} peaks={[]} loop /></div> : null}
        {preview ? <AudioPlayer blob={preview} peaks={peaks} startRatio={piece?.start ?? playRatio.current} endRatio={piece?.end ?? 1} rate={reviewOn ? reviewRate(heardRatio, [...stops, ...clicks, ...likes, ...cuts], 0.012) : 1} onRatio={(ratio) => { playRatio.current = ratio; setHeardRatio(ratio); }} /> : null}
      </div>

      {hot ? <p className="mt-3 text-sm font-semibold text-danger" role="alert">{t("clipHot")}</p> : null}
      {status ? <p className="mt-3 text-sm text-muted" role="status">{status}</p> : null}
      {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}

      <div className="mt-4 grid grid-cols-3 gap-2">
        <button type="button" disabled={!ops.length && !cutPast.length} onClick={undo} className="press inline-flex min-h-12 items-center justify-center gap-1 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40" aria-label={t("undo")}>
          <Undo2 className="size-4" />
          {t("undo")}
        </button>
        <button type="button" disabled={!future.length} onClick={redo} className="press inline-flex min-h-12 items-center justify-center gap-1 rounded-2xl border border-line text-sm font-semibold disabled:opacity-40" aria-label={t("redo")}>
          <Redo2 className="size-4" />
          {t("redo")}
        </button>
        <button type="button" onClick={() => setJoining(true)} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold">
          {t("join")}
        </button>
      </div>

      <section className="mt-4 rounded-3xl border border-line bg-surface p-4">
        <input ref={takeRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm" className="sr-only" onChange={(event) => void loadTake(event.target.files?.[0])} />
        <button type="button" onClick={() => takeRef.current?.click()} className="press min-h-11 w-full rounded-2xl border border-line text-sm font-semibold">
          {t("secondTake")}
        </button>
        {take2 ? (
          <div className="mt-3 grid gap-2">
            {Array.from({ length: Math.max(phrases.length, secondPhrases.length) }, (_, index) => {
              const chosen = (picks[index] ?? 0) === 1;
              return (
                <div key={index} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <button
                    type="button"
                    disabled={!phrases[index]}
                    onClick={() => {
                      if (phrases[index] && working) listenSlice(working, phrases[index]);
                      setPicks((prev) => {
                        const next = prev.slice();
                        next[index] = 0;
                        return next;
                      });
                    }}
                    className={cn("press min-h-10 rounded-xl border text-sm font-semibold disabled:opacity-40", !chosen ? "border-cyan text-cyan" : "border-line")}
                  >
                    {t("takeA")}
                  </button>
                  <span className="text-xs tabular-nums text-faint">{index + 1}</span>
                  <button
                    type="button"
                    disabled={!secondPhrases[index]}
                    onClick={() => {
                      const phrase = secondPhrases[index];
                      if (phrase && take2) listenSlice(take2, phrase);
                      setPicks((prev) => {
                        const next = prev.slice();
                        next[index] = 1;
                        return next;
                      });
                    }}
                    className={cn("press min-h-10 rounded-xl border text-sm font-semibold disabled:opacity-40", chosen ? "border-cyan text-cyan" : "border-line")}
                  >
                    {t("takeB")}
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={buildTakes} className="press brand-fill min-h-11 rounded-2xl text-sm font-semibold">
              {t("takeBuild")}
            </button>
          </div>
        ) : null}
      </section>

      <button
        type="button"
        disabled={busy || !ops.length}
        onClick={() => void savePcm(working, t("edit"))}
        className="press brand-fill mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-2xl text-base font-semibold disabled:opacity-40"
      >
        {busy ? t("loading") : t("saveResult")}
      </button>
      <Link to="/p/$id" params={{ id }} className="mt-3 block text-center text-sm text-muted">
        {t("back")}
      </Link>

      {joining ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={() => setJoining(false)} />
          <div className="safe-b relative z-10 m-4 max-h-[70vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
            <h2 className="text-lg font-semibold">{t("joinTitle")}</h2>
            {others.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{t("joinEmpty")}</p>
            ) : (
              <ul className="mt-4 grid gap-2">
                {others.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void appendProject(item.id)}
                      className="press min-h-12 w-full rounded-2xl border border-line bg-surface px-4 text-start text-sm font-medium"
                    >
                      <span className="block truncate">{item.title}</span>
                      <span className="text-muted">{formatClock(item.durationMs)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" onClick={() => setJoining(false)} className="press mt-4 min-h-11 w-full rounded-full border border-line text-sm font-semibold">
              {t("close")}
            </button>
          </div>
        </div>
      ) : null}
    </Frame>
  );
}
