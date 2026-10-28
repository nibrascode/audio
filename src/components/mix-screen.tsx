import { Link } from "@tanstack/react-router";
import { Minus, Pause, Play, Plus, Scissors, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BackLink, Frame } from "@/components/chrome";
import { FxSheet } from "@/components/fx-sheet";
import { formatClock, readDuration } from "@/lib/audio";
import { streamPeaks } from "@/lib/stream";
import { createFxChain, defaultFx, mergeFx, prepareBuffer, type Fx } from "@/lib/fx";
import { useI18n } from "@/lib/i18n";
import { useLibrary } from "@/lib/library";
import { TRACKS, renderMix, shiftClip, splitClip, timelineEnd, type Clip, type TrackKind } from "@/lib/mix";
import { cn } from "@/lib/utils";

function uid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function MixScreen({ id }: { id: string }) {
  const { t } = useI18n();
  const library = useLibrary();
  const project = library.projects.find((item) => item.id === id);
  const [clips, setClips] = useState<Clip[]>([]);
  const [zoom, setZoom] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [persist, setPersist] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [fxOpen, setFxOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const chainsRef = useRef<Map<string, { update: (fx: Fx, gain: number) => void }>>(new Map());
  const [pickKind, setPickKind] = useState<TrackKind>("voice");
  const fileRef = useRef<HTMLInputElement>(null);
  const kindRef = useRef<TrackKind>("voice");
  const dragRef = useRef<{ id: string; mode: "move" | "left" | "right"; originX: number; clip: Clip } | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<AudioBufferSourceNode[]>([]);
  const audiosRef = useRef<HTMLAudioElement[]>([]);
  const rafRef = useRef(0);
  const clipsRef = useRef(clips);
  const playheadRef = useRef(0);
  const zoomRef = useRef(zoom);
  clipsRef.current = clips;
  playheadRef.current = playhead;
  zoomRef.current = zoom;
  const px = 36 * zoom;
  const content = timelineEnd(clips);
  const length = Math.max(content + 2000, 8000);
  const width = Math.max(length / 1000 * px + 48, 280);
  const active = clips.find((clip) => clip.id === selected) ?? null;

  const projectsRef = useRef(library.projects);
  projectsRef.current = library.projects;

  useEffect(() => {
    if (!library.ready) return;
    let cancel = false;
    setLoaded(false);
    void (async () => {
      const session = await library.getSession(id);
      if (cancel) return;
      if (session) {
        setClips(session.clips.map((clip) => ({ ...clip, fx: mergeFx(clip.fx) })));
        setZoom(session.zoom || 1);
        setPersist(true);
        setLoaded(true);
        return;
      }
      const current = projectsRef.current.find((item) => item.id === id);
      const blob = await library.getAudio(id);
      if (cancel) return;
      if (!current || !blob) {
        setClips([]);
        setPersist(false);
        setLoaded(true);
        return;
      }
      let sourceMs = current.durationMs;
      let peaks = current.peaks;
      if (!sourceMs) {
        sourceMs = (await readDuration(blob)) || 0;
        peaks = (await streamPeaks(blob, 96)) ?? peaks;
      }
      if (cancel) return;
      setClips([
        {
          id: uid(),
          audioId: id,
          name: current.title,
          kind: "voice",
          startMs: 0,
          offsetMs: 0,
          durationMs: Math.max(80, sourceMs),
          sourceMs: Math.max(80, sourceMs),
          gain: 1,
          peaks: peaks.length ? peaks : [0.2],
          fx: defaultFx(),
        },
      ]);
      setPersist(true);
      setLoaded(true);
    })();
    return () => {
      cancel = true;
    };
  }, [library.ready, library.getSession, library.getAudio, id]);

  useEffect(() => {
    if (!loaded || !persist) return;
    const timer = window.setTimeout(() => {
      void library.saveSession({ id, clips, zoom, updatedAt: Date.now() });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [loaded, persist, clips, zoom, id, library.saveSession]);

  useEffect(() => {
    const flush = () => {
      if (!loaded || !persist) return;
      void library.saveSession({ id, clips: clipsRef.current, zoom: zoomRef.current, updatedAt: Date.now() });
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [loaded, persist, id, library.saveSession]);

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(rafRef.current);
      for (const node of nodesRef.current) node.stop();
      void ctxRef.current?.close();
    };
  }, []);

  function stop() {
    window.cancelAnimationFrame(rafRef.current);
    for (const node of nodesRef.current) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    nodesRef.current = [];
    for (const audio of audiosRef.current) {
      audio.pause();
      audio.src = "";
    }
    audiosRef.current = [];
    chainsRef.current.clear();
    setPlaying(false);
  }

  const hearRef = useRef(0);

  const playRef = useRef<(force?: boolean) => Promise<void>>(async () => {});

  function hearNow(patch: Partial<Fx>) {
    if (!("gate" in patch) && !("pitch" in patch) && !("speed" in patch) && !("keepPitch" in patch)) return;
    window.clearTimeout(hearRef.current);
    hearRef.current = window.setTimeout(() => {
      void playRef.current(true);
    }, 280);
  }

  async function play(force = false) {
    if (playing && !force) {
      stop();
      return;
    }
    if (playing) stop();
    const list = clipsRef.current;
    if (!list.length) return;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = ctxRef.current && ctxRef.current.state !== "closed" ? ctxRef.current : new Ctx();
    ctxRef.current = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const from = playheadRef.current >= timelineEnd(list) - 40 ? 0 : playheadRef.current;
    if (from === 0) setPlayhead(0);
    const startAt = ctx.currentTime + 0.05;
    const heavy = list.some((clip) => {
      const fx = mergeFx(clip.fx);
      return fx.pitch !== 0 || fx.gate > 0 || (fx.keepPitch && fx.speed !== 100);
    });
    if (!heavy) {
      for (const clip of list) {
        const blob = await library.getAudio(clip.audioId);
        if (!blob) continue;
        const audio = new Audio(URL.createObjectURL(blob));
        audiosRef.current.push(audio);
        const elapsed = Math.max(0, from - clip.startMs) / 1000;
        const delay = Math.max(0, clip.startMs - from);
        audio.volume = Math.max(0, Math.min(1, clip.gain));
        window.setTimeout(() => {
          if (!audiosRef.current.includes(audio)) return;
          audio.currentTime = clip.offsetMs / 1000 + elapsed;
          void audio.play().catch(() => undefined);
        }, delay);
      }
      setNote(null);
      setPlaying(true);
      const begun = performance.now();
      const tick = () => {
        const ms = from + (performance.now() - begun);
        if (ms >= timelineEnd(clipsRef.current)) {
          stop();
          setPlayhead(0);
          return;
        }
        setPlayhead(ms);
        rafRef.current = window.requestAnimationFrame(tick);
      };
      rafRef.current = window.requestAnimationFrame(tick);
      return;
    }
    const nodes: AudioBufferSourceNode[] = [];
    if (heavy) setNote(t("preparing"));
    chainsRef.current.clear();
    for (const clip of list) {
      const blob = await library.getAudio(clip.audioId);
      if (!blob) continue;
      const fx = mergeFx(clip.fx);
      const audio = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0));
      const prepared = await prepareBuffer(ctx, audio, clip.offsetMs, clip.durationMs, fx);
      const source = ctx.createBufferSource();
      source.buffer = prepared.buffer;
      source.playbackRate.value = prepared.rate;
      const chain = createFxChain(ctx, ctx.destination, fx, clip.gain);
      source.connect(chain.input);
      chainsRef.current.set(clip.id, chain);
      const elapsed = Math.max(0, from - clip.startMs) / 1000;
      const bufferOffset = elapsed * prepared.rate;
      if (bufferOffset >= prepared.buffer.duration - 0.02) continue;
      const when = startAt + Math.max(0, clip.startMs - from) / 1000;
      source.start(when, bufferOffset);
      nodes.push(source);
    }
    setNote(null);
    nodesRef.current = nodes;
    setPlaying(true);
    const begun = performance.now();
    const tick = () => {
      const ms = from + (performance.now() - begun);
      if (ms >= timelineEnd(clipsRef.current)) {
        stop();
        setPlayhead(0);
        return;
      }
      setPlayhead(ms);
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }

  playRef.current = play;

  async function addBlob(blob: Blob, name: string, kind: TrackKind) {
    setBusy(true);
    setNote(null);
    try {
      const sourceMs = Math.max(80, Math.round((await readDuration(blob)) || 0));
      const peaks = (await streamPeaks(blob, 96)) ?? [0.2];
      const audioId = `clip-${uid()}`;
      await library.putAudio(audioId, blob);
      const clip: Clip = {
        id: uid(),
        audioId,
        name: name.slice(0, 48) || t(kind),
        kind,
        startMs: 0,
        offsetMs: 0,
        durationMs: sourceMs,
        sourceMs,
        gain: 1,
        peaks: peaks.length ? peaks : [0.2],
        fx: defaultFx(),
      };
      setClips((current) => [...current, clip]);
      setSelected(clip.id);
    } catch {
      setNote(t("importFail"));
    } finally {
      setBusy(false);
    }
  }

  async function saveMix() {
    if (!clips.length || busy) return;
    setBusy(true);
    setNote(t("preparing"));
    try {
      const blob = await renderMix(clips, library.getAudio, (ratio) => setNote(`${t("processing")} ${Math.round(ratio * 100)}%`));
      if (blob.size < 44) throw new Error("incomplete");
      const created = await library.addProject({
        title: `${t("mix")} — ${project?.title ?? "Nibras"}`.slice(0, 80),
        note: "",
        blob,
        mimeType: "audio/wav",
        durationMs: timelineEnd(clips),
        source: "import",
        peaks: [],
      });
      setSavedId(created.id);
      setNote(t("mixSaved"));
    } catch {
      setNote(t("mixFail"));
    } finally {
      setBusy(false);
    }
  }

  function seek(clientX: number, box: DOMRect) {
    const ms = Math.max(0, Math.min(length, ((clientX - box.left) / px) * 1000));
    if (playing) stop();
    setPlayhead(ms);
  }

  if (!library.ready || !loaded) {
    return (
      <Frame>
        <p className="p-5 text-sm text-muted">{t("loading")}</p>
      </Frame>
    );
  }

  if (!project) {
    return (
      <Frame>
        <div className="p-5">
          <p className="text-base">{t("notFound")}</p>
          <Link to="/" className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-cyan">{t("goHome")}</Link>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <div className="flex flex-1 flex-col px-4 py-4">
        <BackLink />
        <h1 className="mt-3 text-2xl font-semibold leading-tight">{t("mix")}</h1>
        <p className="mt-2 text-sm text-pretty text-muted">{t("mixHint")}</p>
        <p className="mt-1 text-sm text-faint">{t("arrangementKept")}</p>

        <div className="mt-4 flex items-center gap-3">
          <button type="button" onClick={() => void play()} className="press brand-fill inline-flex size-12 items-center justify-center rounded-full" aria-label={playing ? t("pause") : t("play")}>
            {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </button>
          <span className="font-mono text-sm tabular-nums">{formatClock(playhead, zoom >= 4)} / {formatClock(content, false)}</span>
          <div className="ms-auto flex items-center gap-1">
            <button type="button" aria-label={t("zoom")} onClick={() => setZoom((value) => Math.max(1, Math.round((value - 0.5) * 2) / 2))} className="press inline-flex size-10 items-center justify-center rounded-full border border-line">
              <Minus className="size-4" />
            </button>
            <button type="button" aria-label={t("zoom")} onClick={() => setZoom((value) => Math.min(8, Math.round((value + 0.5) * 2) / 2))} className="press inline-flex size-10 items-center justify-center rounded-full border border-line">
              <Plus className="size-4" />
            </button>
          </div>
        </div>

        <div className="mt-4 flex overflow-hidden rounded-2xl border border-line bg-surface">
          <div className="w-14 shrink-0 border-e border-line">
            <div className="h-8" />
            {TRACKS.map((kind) => (
              <div key={kind} className="flex h-16 items-center px-1 text-[11px] font-semibold text-faint">{t(kind)}</div>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto" dir="ltr">
          <div className="relative" style={{ width }}>
            <button
              type="button"
              className="relative block h-8 w-full"
              onClick={(event) => seek(event.clientX, event.currentTarget.getBoundingClientRect())}
            >
              {Array.from({ length: Math.ceil(length / 1000) + 1 }, (_, second) => (
                <span key={second} className="absolute top-2 text-[10px] text-faint" style={{ left: second * px }}>{second}s</span>
              ))}
            </button>
            {TRACKS.map((kind) => (
              <div key={kind} className="relative h-16 border-t border-line">
                <button type="button" className="absolute inset-0" aria-label={t(kind)} onClick={(event) => seek(event.clientX, event.currentTarget.getBoundingClientRect())} />
                {clips.filter((clip) => clip.kind === kind).map((clip) => (
                  <div
                    key={clip.id}
                    className={cn(
                      "absolute top-5 z-10 flex h-9 cursor-grab items-stretch overflow-hidden rounded-lg border bg-bg/90 touch-none",
                      clip.kind === "voice" && "border-cyan",
                      clip.kind === "music" && "border-violet",
                      clip.kind === "fx" && "border-line",
                      selected === clip.id && "ring-2 ring-cyan",
                    )}
                    style={{ left: (clip.startMs / 1000) * px, width: Math.max(28, (clip.durationMs / 1000) * px) }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      stop();
                      dragRef.current = { id: clip.id, mode: "move", originX: event.clientX, clip };
                      setSelected(clip.id);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const drag = dragRef.current;
                      if (!drag || drag.id !== clip.id) return;
                      const delta = ((event.clientX - drag.originX) / px) * 1000;
                      setClips((current) => current.map((item) => (item.id === drag.id ? shiftClip(drag.clip, drag.mode, delta) : item)));
                    }}
                    onPointerUp={() => {
                      dragRef.current = null;
                    }}
                  >
                    <span
                      className="w-2 shrink-0 bg-fg/50"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        dragRef.current = { id: clip.id, mode: "left", originX: event.clientX, clip };
                        event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
                      }}
                    />
                    <span className="flex min-w-0 flex-1 items-end gap-px px-1 pb-1">
                      {clip.peaks.slice(0, 48).map((peak, index) => (
                        <span key={index} className="w-0.5 flex-1 rounded-full bg-cyan/80" style={{ height: `${Math.max(8, peak * 100)}%` }} />
                      ))}
                    </span>
                    <span
                      className="w-2 shrink-0 bg-fg/50"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        dragRef.current = { id: clip.id, mode: "right", originX: event.clientX, clip };
                        event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
                      }}
                    />
                  </div>
                ))}
              </div>
            ))}
            <div className="pointer-events-none absolute inset-y-0 w-px bg-cyan" style={{ left: (playhead / 1000) * px }} />
          </div>
          </div>
        </div>

        {active ? (
          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <p className="truncate text-sm font-semibold">{active.name}</p>
            <label className="mt-3 block text-sm text-muted">
              {t("trackVolume")} · {Math.round(active.gain * 100)}%
              <input
                type="range"
                min={0}
                max={150}
                value={Math.round(active.gain * 100)}
                className="nibras-range mt-2"
                onChange={(event) => {
                  const gain = Number(event.target.value) / 100;
                  chainsRef.current.get(active.id)?.update(mergeFx(active.fx), gain);
                  setClips((current) => current.map((clip) => (clip.id === active.id ? { ...clip, gain } : clip)));
                }}
              />
            </label>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setFxOpen(true)} className="press col-span-2 min-h-11 rounded-full border border-line text-sm font-semibold">
                {t("effects")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const parts = splitClip(active, playhead);
                  if (!parts) {
                    setNote(t("tooShort"));
                    return;
                  }
                  setClips((current) => current.flatMap((clip) => (clip.id === active.id ? parts : [clip])));
                  setNote(null);
                }}
                className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line text-sm font-semibold"
              >
                <Scissors className="size-4" />
                {t("split")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setClips((current) => current.filter((clip) => clip.id !== active.id));
                  setSelected(null);
                }}
                className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-full text-sm font-semibold text-danger"
              >
                <Trash2 className="size-4" />
                {t("removeClip")}
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-2">
          {TRACKS.map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={busy}
              onClick={() => {
                kindRef.current = kind;
                fileRef.current?.click();
              }}
              className="press min-h-11 rounded-full border border-line text-sm font-semibold disabled:opacity-40"
            >
              + {t(kind)}
            </button>
          ))}
          <button type="button" disabled={busy} onClick={() => setPicking(true)} className="press min-h-11 rounded-full border border-line text-sm font-semibold disabled:opacity-40">
            {t("fromProject")}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void addBlob(file, file.name.replace(/\.[^.]+$/, ""), kindRef.current);
          }}
        />

        <button type="button" disabled={busy || !clips.length} onClick={() => void saveMix()} className="press brand-fill mt-4 min-h-12 rounded-2xl text-sm font-semibold disabled:opacity-40">
          {t("saveMix")}
        </button>
        {note ? <p className="mt-3 text-center text-sm text-cyan" role="status">{note}</p> : null}
        {savedId ? (
          <Link to="/p/$id" params={{ id: savedId }} className="mt-2 text-center text-sm font-semibold text-cyan">
            {t("mixSaved")}
          </Link>
        ) : null}
      </div>

      {fxOpen && active ? (
        <FxSheet
          fx={active.fx}
          onClose={() => setFxOpen(false)}
          onChange={(patch) => {
            const fx = { ...mergeFx(active.fx), ...patch };
            chainsRef.current.get(active.id)?.update(fx, active.gain);
            setClips((current) => current.map((clip) => (clip.id === active.id ? { ...clip, fx } : clip)));
            hearNow(patch);
          }}
        />
      ) : null}
      {picking ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={() => setPicking(false)} />
          <div className="safe-b relative z-10 m-4 max-h-[70dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
            <h2 className="text-lg font-semibold">{t("fromProject")}</h2>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {TRACKS.map((kind) => (
                <button key={kind} type="button" aria-pressed={pickKind === kind} onClick={() => setPickKind(kind)} className={cn("min-h-10 rounded-full text-sm font-semibold", pickKind === kind ? "brand-fill" : "border border-line")}>
                  {t(kind)}
                </button>
              ))}
            </div>
            <ul className="mt-4 grid gap-2">
              {library.projects.filter((item) => item.id !== id).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="press min-h-11 w-full rounded-2xl border border-line px-3 text-start text-sm font-semibold"
                    onClick={() => {
                      setPicking(false);
                      void library.getAudio(item.id).then((blob) => {
                        if (blob) void addBlob(blob, item.title, pickKind);
                      });
                    }}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
            {library.projects.filter((item) => item.id !== id).length === 0 ? <p className="mt-3 text-sm text-muted">{t("joinEmpty")}</p> : null}
          </div>
        </div>
      ) : null}
    </Frame>
  );
}
