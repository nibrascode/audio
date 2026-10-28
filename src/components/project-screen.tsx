import { Link, useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BackLink, Frame } from "@/components/chrome";
import { AudioPlayer } from "@/components/player";
import { ExportSheet } from "@/components/export-sheet";
import { DenoiseSheet } from "@/components/denoise-sheet";
import { fileExt, formatBytes, formatClock, formatName, formatStamp, safeName, shareAudio } from "@/lib/audio";
import { useI18n } from "@/lib/i18n";
import { useLibrary } from "@/lib/library";
import { dropCallMarks } from "@/lib/join-ranges";
import { toneColor } from "@/lib/tone";
import iconEdit from "@/assets/icons/edit.jpg";
import iconMix from "@/assets/icons/mix.jpg";
import iconFx from "@/assets/icons/fx.jpg";
import iconDenoise from "@/assets/icons/denoise.jpg";
import iconExport from "@/assets/icons/export.jpg";
import iconShare from "@/assets/icons/share.jpg";

export function ProjectScreen({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const library = useLibrary();
  const navigate = useNavigate();
  const project = library.projects.find((item) => item.id === id);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [shareNote, setShareNote] = useState<"shared" | "downloaded" | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [denoiseOpen, setDenoiseOpen] = useState(false);
  const [callBusy, setCallBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [seek, setSeek] = useState<{ ratio: number; token: number } | null>(null);
  const [chapter, setChapter] = useState("");
  const updateRef = useRef(library.updateProject);
  updateRef.current = library.updateProject;

  useEffect(() => {
    setHydrated(false);
    setBlob(null);
    setMissing(false);
    setConfirm(false);
    setSavedFlash(false);
    setShareNote(null);
  }, [id]);

  useEffect(() => {
    if (!library.ready) return;
    let cancel = false;
    void library.getAudio(id).then((next) => {
      if (cancel) return;
      if (!next) setMissing(true);
      else setBlob(next);
    });
    return () => {
      cancel = true;
    };
  }, [library.ready, library.getAudio, id]);

  useEffect(() => {
    if (!project || hydrated) return;
    setTitle(project.title);
    setNote(project.note);
    setHydrated(true);
  }, [project, hydrated]);

  useEffect(() => {
    if (!hydrated || !project) return;
    if (title === project.title && note === project.note) return;
    const handle = window.setTimeout(() => {
      const current = project;
      void updateRef.current(current.id, { title: title.trim() || current.title, note }).then(() => setSavedFlash(true));
    }, 450);
    return () => window.clearTimeout(handle);
  }, [title, note, hydrated, project]);

  useEffect(() => {
    if (!savedFlash) return;
    const handle = window.setTimeout(() => setSavedFlash(false), 1200);
    return () => window.clearTimeout(handle);
  }, [savedFlash]);

  if (!library.ready) {
    return (
      <Frame>
        <BackLink />
        <p className="mt-8 text-sm text-muted">{t("loading")}</p>
      </Frame>
    );
  }

  if (!project) {
    return (
      <Frame>
        <BackLink />
        <h1 className="mt-8 text-2xl font-semibold">{t("notFound")}</h1>
      </Frame>
    );
  }

  const current = project;
  const label = formatName(current.mimeType, current.title);
  const filename = `${safeName(title || current.title)}.${fileExt(current.mimeType, current.title)}`;

  async function share() {
    if (!blob) return;
    const result = await shareAudio(blob, filename, title.trim() || current.title);
    if (result === "cancelled") return;
    setShareNote(result);
  }

  return (
    <Frame>
      <header className="flex items-center justify-between gap-3">
        <BackLink />
        <p className="text-sm text-cyan" aria-live="polite">
          {savedFlash ? t("saved") : ""}
        </p>
      </header>

      <label className="mt-4 grid gap-2 text-sm text-muted">
        {t("fileName")}
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={80}
          className="min-h-12 rounded-2xl border border-line bg-bg px-4 text-base font-semibold text-fg outline-none focus:border-cyan"
        />
      </label>

      <dl className="mt-4 grid grid-cols-3 gap-2">
        <div className="rounded-2xl border border-line bg-surface px-3 py-3">
          <dt className="text-xs text-faint">{t("duration")}</dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums">{formatClock(project.durationMs)}</dd>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-3 py-3">
          <dt className="text-xs text-faint">{t("size")}</dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums">{formatBytes(project.byteSize)}</dd>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-3 py-3">
          <dt className="text-xs text-faint">{t("formatLabel")}</dt>
          <dd className="mt-1 text-sm font-semibold">{label}</dd>
        </div>
      </dl>
      <p className="mt-2 text-sm text-muted">
        {project.source === "import" ? t("imported") : t("recorded")} · {formatStamp(project.createdAt, locale, t("today"))}
      </p>
      {toneColor(project.tone) ? <div className="mt-3 h-1.5 rounded-full" style={{ background: toneColor(project.tone) }} /> : null}
      {project.marks && project.marks.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm text-cyan">{t("callMark")}: {project.marks.map((mark) => formatClock(mark)).join(" · ")}</p>
          <button
            type="button"
            disabled={!blob || callBusy}
            onClick={() => {
              if (!blob) return;
              setCallBusy(true);
              setCallError(null);
              void dropCallMarks(blob, project.durationMs, project.marks ?? [])
                .then(async (joined) => {
                  if (!joined) throw new Error("empty");
                  const created = await library.addProject({
                    title: `${project.title} · ${t("callMark")}`.slice(0, 80),
                    note: project.note,
                    blob: joined.blob,
                    mimeType: "audio/wav",
                    durationMs: Math.round(joined.durationMs),
                    source: project.source,
                    peaks: project.peaks,
                  });
                  await navigate({ to: "/p/$id", params: { id: created.id } });
                })
                .catch(() => setCallError(t("editFail")))
                .finally(() => setCallBusy(false));
            }}
            className="press mt-2 min-h-11 rounded-2xl border border-line px-4 text-sm font-semibold text-cyan disabled:opacity-40"
          >
            {t("dropCall")}
          </button>
          {callError ? <p className="mt-2 text-sm text-danger" role="alert">{callError}</p> : null}
        </div>
      ) : null}

      <div className="mt-5">
        {blob ? (
          <AudioPlayer
            blob={blob}
            peaks={project.peaks}
            marks={project.marks}
            seekTo={seek}
            onRatio={setPlayhead}
            onDuration={(ms) => {
              if (project.durationMs > 500 || ms < 500) return;
              void library.updateProject(project.id, { durationMs: Math.round(ms) });
            }}
          />
        ) : null}
        {missing ? <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-danger">{t("noAudio")}</p> : null}
        {!blob && !missing ? <div className="h-28 animate-pulse rounded-3xl bg-surface" /> : null}
      </div>

      <section className="mt-5">
        <h2 className="text-sm font-medium text-faint">{t("chapters")}</h2>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = chapter.trim().slice(0, 40);
            if (!name) return;
            const next = [...(current.chapters ?? []), { at: Math.round(playhead * current.durationMs), name }]
              .sort((a, b) => a.at - b.at)
              .slice(0, 24);
            void library.updateProject(current.id, { chapters: next });
            setChapter("");
          }}
        >
          <input
            value={chapter}
            onChange={(event) => setChapter(event.target.value)}
            maxLength={40}
            placeholder={t("chapterName")}
            className="min-h-11 min-w-0 flex-1 rounded-2xl border border-line bg-bg px-3 text-sm text-fg outline-none focus:border-cyan"
          />
          <button type="submit" className="press min-h-11 rounded-2xl border border-line px-3 text-sm font-semibold">{t("addChapter")}</button>
        </form>
        {current.chapters && current.chapters.length > 0 ? (
          <ul className="mt-2 grid gap-2">
            {current.chapters.map((item) => (
              <li key={`${item.at}-${item.name}`}>
                <button
                  type="button"
                  onClick={() => setSeek({ ratio: current.durationMs > 0 ? item.at / current.durationMs : 0, token: Date.now() })}
                  className="press flex min-h-11 w-full items-center justify-between rounded-2xl border border-line bg-surface px-3 text-sm"
                >
                  <span className="font-semibold">{item.name}</span>
                  <span className="tabular-nums text-faint">{formatClock(item.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {library.projects.some((item) => item.id !== current.id && (item.parentId === current.id || (current.parentId && (item.id === current.parentId || item.parentId === current.parentId)))) ? (
        <section className="mt-5">
          <h2 className="text-sm font-medium text-faint">{t("versions")}</h2>
          <ul className="mt-2 grid gap-2">
            {library.projects
              .filter((item) => item.id !== current.id && (item.parentId === current.id || (current.parentId && (item.id === current.parentId || item.parentId === current.parentId))))
              .map((item) => (
                <li key={item.id}>
                  <Link to="/p/$id" params={{ id: item.id }} className="press flex min-h-11 items-center justify-between rounded-2xl border border-line px-3 text-sm">
                    <span className="truncate font-semibold">{item.title}</span>
                    <span className="shrink-0 tabular-nums text-faint">{formatClock(item.durationMs)}</span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <label className="mt-5 grid gap-2 text-sm text-muted">
        {t("notes")}
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          maxLength={8000}
          placeholder={t("notePlaceholder")}
          className="resize-none rounded-2xl border border-line bg-bg px-4 py-3 text-base text-fg outline-none focus:border-cyan"
        />
      </label>

      <div className="mt-6 grid grid-cols-3 gap-x-4 gap-y-5">
        <Link to="/e/$id" params={{ id: project.id }} className="press flex flex-col items-center gap-2 text-center">
          <img src={iconEdit} alt="" className="aspect-square w-full rounded-[28%] object-cover shadow-[0_14px_28px_rgba(0,0,0,0.35)]" />
          <span className="text-xs font-medium">{t("edit")}</span>
        </Link>
        <Link to="/m/$id" params={{ id: project.id }} className="press flex flex-col items-center gap-2 text-center">
          <img src={iconMix} alt="" className="aspect-square w-full rounded-[28%] object-cover shadow-[0_14px_28px_rgba(0,0,0,0.35)]" />
          <span className="text-xs font-medium">{t("mix")}</span>
        </Link>
        <Link to="/m/$id" params={{ id: project.id }} className="press flex flex-col items-center gap-2 text-center">
          <img src={iconFx} alt="" className="aspect-square w-full rounded-[28%] object-cover shadow-[0_14px_28px_rgba(0,0,0,0.35)]" />
          <span className="text-xs font-medium">{t("effects")}</span>
        </Link>
        <button type="button" disabled={!blob} onClick={() => setDenoiseOpen(true)} className="press flex flex-col items-center gap-2 text-center disabled:opacity-40">
          <img src={iconDenoise} alt="" className="aspect-square w-full rounded-[28%] object-cover shadow-[0_14px_28px_rgba(0,0,0,0.35)]" />
          <span className="text-xs font-medium">{t("denoise")}</span>
        </button>
        <button type="button" disabled={!blob} onClick={() => setExportOpen(true)} className="press flex flex-col items-center gap-2 text-center disabled:opacity-40">
          <img src={iconExport} alt="" className="aspect-square w-full rounded-[28%] object-cover shadow-[0_14px_28px_rgba(0,0,0,0.35)]" />
          <span className="text-xs font-medium">{t("savePhone")}</span>
        </button>
        <button type="button" disabled={!blob} onClick={() => void share()} className="press flex flex-col items-center gap-2 text-center disabled:opacity-40">
          <img src={iconShare} alt="" className="aspect-square w-full rounded-[28%] object-cover shadow-[0_14px_28px_rgba(0,0,0,0.35)]" />
          <span className="text-xs font-medium">{t("share")}</span>
        </button>
      </div>
        {shareNote ? (
          <p className="text-center text-sm text-cyan" role="status">
            {shareNote === "shared" ? t("shared") : t("shareFallback")}
          </p>
        ) : null}
        {confirm ? (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setConfirm(false)} className="press min-h-12 rounded-2xl border border-line text-sm font-semibold">
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                void library.deleteProject(project.id).then(() => navigate({ to: "/" }));
              }}
              className="press min-h-12 rounded-2xl text-sm font-semibold text-danger"
            >
              {t("confirmDelete")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className="press mt-2 inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl text-sm font-semibold text-danger"
          >
            <Trash2 className="size-4" />
            {t("delete")}
          </button>
        )}
      {exportOpen && blob ? <ExportSheet blob={blob} title={title.trim() || project.title} onClose={() => setExportOpen(false)} /> : null}
      {denoiseOpen && blob ? (
        <DenoiseSheet blob={blob} title={title.trim() || project.title} source={project.source} onClose={() => setDenoiseOpen(false)} />
      ) : null}
    </Frame>
  );
}
