import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { DenoiseSheet } from "@/components/denoise-sheet";
import { ExportSheet } from "@/components/export-sheet";
import { Frame, MicStatus, NoteSheet, SettingsButton } from "@/components/chrome";
import mark from "@/assets/nibras-mark.jpg";
import iconRecord from "@/assets/icons/record.jpg";
import iconOpen from "@/assets/icons/open.jpg";
import iconShare from "@/assets/icons/share.jpg";
import iconEdit from "@/assets/icons/edit.jpg";
import iconJoin from "@/assets/icons/join.jpg";
import iconBatch from "@/assets/icons/batch.jpg";
import iconMix from "@/assets/icons/mix.jpg";
import iconFx from "@/assets/icons/fx.jpg";
import iconDenoise from "@/assets/icons/denoise.jpg";
import iconExport from "@/assets/icons/export.jpg";
import iconNotes from "@/assets/icons/notes.jpg";
import { fileExt, formatClock, formatStamp, mimeFromName, readDuration, readShape, safeName, shareAudio, sniffAudio, useMicWatch } from "@/lib/audio";
import { toneColor } from "@/lib/tone";
import { useI18n } from "@/lib/i18n";
import { useLibrary } from "@/lib/library";

const MAX_BYTES = 80 * 1024 * 1024;

type Banner = "big" | "import" | "storage" | null;
type Sheet =
  | null
  | { kind: "new" }
  | { kind: "note"; id: string; body: string }
  | { kind: "project"; id: string; body: string };

function looksLikeAudio(file: File) {
  if (!file.type || file.type.startsWith("audio") || file.type === "application/octet-stream") return true;
  return /\.(mp3|m4a|wav|aac|ogg|flac|webm|mpeg|mp4|caf)$/i.test(file.name);
}

function isQuota(err: unknown) {
  return err instanceof DOMException && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

export function HomeScreen() {
  const { t, locale } = useI18n();
  const library = useLibrary();
  const navigate = useNavigate();
  const perm = useMicWatch();
  const fileRef = useRef<HTMLInputElement>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [opening, setOpening] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [needSound, setNeedSound] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [tool, setTool] = useState<null | { kind: "denoise" | "export"; blob: Blob; title: string; source: "record" | "import" }>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [pick, setPick] = useState<null | "edit" | "mix" | "denoise" | "export" | "share" | "join">(null);

  const noteItems = [
    ...library.notes.map((note) => ({
      key: note.id,
      body: note.body,
      updatedAt: note.updatedAt,
      sheet: { kind: "note" as const, id: note.id, body: note.body },
      meta: formatStamp(note.updatedAt, locale, t("today")),
    })),
    ...library.projects
      .filter((project) => project.note.trim())
      .map((project) => ({
        key: `p-${project.id}`,
        body: project.note,
        updatedAt: project.updatedAt,
        sheet: { kind: "project" as const, id: project.id, body: project.note },
        meta: `${t("linkedProject")} · ${project.title}`,
      })),
  ].sort((a, b) => b.updatedAt - a.updatedAt);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBanner(null);
    const sniffed = await sniffAudio(file).catch(() => null);
    if (!looksLikeAudio(file) && !sniffed) {
      setBanner("import");
      return;
    }
    if (file.size > MAX_BYTES) {
      setBanner("big");
      return;
    }
    setOpening(true);
    try {
      const durationMs = await readDuration(file);
      let peaks: number[] = [];
      let tone: "warm" | "cold" | "deep" | undefined;
      try {
        const shape = await readShape(file);
        peaks = shape.peaks;
        tone = shape.tone;
      } catch {
        peaks = [];
      }
      const base = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 80);
      const meta = await library.addProject({
        title: base || `${t("take")} · ${formatStamp(Date.now(), locale, t("today"))}`,
        note: "",
        blob: file,
        mimeType: sniffed?.mime || (file.type.startsWith("audio/") ? file.type : mimeFromName(file.name) || "application/octet-stream"),
        durationMs,
        source: "import",
        peaks,
        tone,
      });
      await navigate({ to: "/p/$id", params: { id: meta.id } });
    } catch (err) {
      setBanner(isQuota(err) ? "storage" : "import");
    } finally {
      setOpening(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveSheet(body: string) {
    if (!sheet || sheet.kind === "new") {
      await library.addNote(body);
    } else if (sheet.kind === "note") {
      await library.updateNote(sheet.id, body);
    } else {
      await library.updateProject(sheet.id, { note: body });
    }
    setSheet(null);
  }

  async function deleteSheet() {
    if (!sheet || sheet.kind === "new") return;
    if (sheet.kind === "note") await library.deleteNote(sheet.id);
    else await library.updateProject(sheet.id, { note: "" });
    setSheet(null);
  }

  const projects = [...library.projects].sort((a, b) => b.updatedAt - a.updatedAt);

  function ask(kind: NonNullable<typeof pick>) {
    if (!projects.length) {
      setNeedSound(true);
      return;
    }
    setPick(kind);
  }

  async function runPicked(id: string) {
    const kind = pick;
    const project = projects.find((item) => item.id === id);
    setPick(null);
    if (!kind || !project) return;
    if (kind === "edit" || kind === "join") {
      if (kind === "join") {
        try {
          sessionStorage.setItem("nibras-join", "1");
        } catch {
          /* ignore */
        }
      }
      await navigate({ to: "/e/$id", params: { id: project.id } });
      return;
    }
    if (kind === "mix") {
      await navigate({ to: "/m/$id", params: { id: project.id } });
      return;
    }
    const blob = await library.getAudio(project.id);
    if (!blob) {
      setNeedSound(true);
      return;
    }
    if (kind === "share") {
      const filename = `${safeName(project.title)}.${fileExt(project.mimeType, project.title)}`;
      const result = await shareAudio(blob, filename, project.title);
      setShareNote(result === "downloaded" ? t("shareFallback") : result === "shared" ? t("shared") : null);
      return;
    }
    setTool({ kind, blob, title: project.title, source: project.source });
  }

  function openNotes() {
    if (noteItems.length === 0) setSheet({ kind: "new" });
    else setNotesOpen(true);
  }

  const tools: { key: string; label: string; art: string; onClick: () => void }[] = [
    { key: "record", label: t("newRecording"), art: iconRecord, onClick: () => void navigate({ to: "/record" }) },
    { key: "open", label: opening ? t("opening") : t("openFile"), art: iconOpen, onClick: () => fileRef.current?.click() },
    { key: "share", label: t("share"), art: iconShare, onClick: () => ask("share") },
    { key: "edit", label: t("edit"), art: iconEdit, onClick: () => ask("edit") },
    { key: "join", label: t("join"), art: iconJoin, onClick: () => ask("join") },
    { key: "batch", label: t("batch"), art: iconBatch, onClick: () => void navigate({ to: "/batch" }) },
    { key: "mix", label: t("mix"), art: iconMix, onClick: () => ask("mix") },
    { key: "fx", label: t("effects"), art: iconFx, onClick: () => ask("mix") },
    { key: "denoise", label: t("denoise"), art: iconDenoise, onClick: () => ask("denoise") },
    { key: "export", label: t("savePhone"), art: iconExport, onClick: () => ask("export") },
    { key: "notes", label: t("notes"), art: iconNotes, onClick: openNotes },
  ];

  return (
    <Frame wide app>
      <div className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <img src={mark} alt="" width={40} height={40} className="size-10 rounded-2xl" />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold leading-tight">{t("appName")}</h1>
              <p className="truncate text-xs text-faint">{t("offline")}</p>
            </div>
          </div>
          <SettingsButton />
        </header>

        <div className="safe-b min-h-0 flex-1 overflow-y-auto">
          <MicStatus perm={perm} />
          {library.memoryOnly ? (
            <p className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-muted" role="status">
              {t("memoryOnly")}
            </p>
          ) : null}
          {banner ? (
            <p className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-danger" role="alert">
              {banner === "big" ? t("fileTooBig") : banner === "storage" ? t("storageFail") : t("importFail")}
            </p>
          ) : null}
          {shareNote ? <p className="mt-3 text-sm text-cyan" role="status">{shareNote}</p> : null}

          <div className="mt-5 grid grid-cols-3 gap-x-4 gap-y-6">
            {tools.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={item.key === "open" && (!library.ready || opening)}
                onClick={item.onClick}
                className="press flex flex-col items-center gap-2 text-center disabled:opacity-50"
              >
                <img src={item.art} alt="" className="aspect-square w-full rounded-[28%] object-cover shadow-[0_14px_28px_rgba(0,0,0,0.35)]" />
                <span className="line-clamp-2 text-xs font-medium leading-tight">{item.label}</span>
              </button>
            ))}
          </div>

          {projects.length > 0 ? (
            <section className="panel mt-8 overflow-hidden rounded-[1.35rem]">
              <h2 className="px-4 pt-4 text-sm text-faint">{t("recent")}</h2>
              <ul className="mt-1">
                {projects.map((project, index) => (
                  <li key={project.id} className={index > 0 ? "border-t border-white/6" : undefined}>
                    <Link to="/p/$id" params={{ id: project.id }} className="press flex min-h-[3.4rem] items-center gap-3 px-4">
                      <span className="size-1.5 shrink-0 rounded-full" style={{ background: toneColor(project.tone) || "#667396" }} />
                      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{project.title}</span>
                      <span className="shrink-0 text-xs tabular-nums text-faint">{formatClock(project.durationMs)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="mt-8 text-sm text-faint">{t("emptyProjects")}</p>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac,.webm,.mpeg,.mp4,.caf"
          className="sr-only"
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </div>

      {pick ? (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
          <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={() => setPick(null)} />
          <div className="safe-b relative z-10 m-4 max-h-[80dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
            <p className="text-sm font-medium text-cyan">{pick === "edit" || pick === "join" ? t("edit") : pick === "mix" ? t("mix") : pick === "denoise" ? t("denoise") : pick === "export" ? t("savePhone") : t("share")}</p>
            <h2 className="mt-1 text-lg font-semibold">{t("pickSound")}</h2>
            <ul className="mt-4 grid gap-2">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => void runPicked(project.id)}
                    className="press flex min-h-14 w-full items-center gap-3 rounded-2xl border border-line bg-surface px-4 text-start"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{project.title}</span>
                      <span className="mt-0.5 block text-sm text-muted">{formatClock(project.durationMs)} · {formatStamp(project.updatedAt, locale, t("today"))}</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-faint rtl:rotate-180" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {needSound ? (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
          <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={() => setNeedSound(false)} />
          <div className="safe-b relative z-10 m-4 w-full max-w-sm rounded-3xl border border-line bg-surface-2 p-5">
            <p className="text-sm text-pretty text-muted">{t("needSound")}</p>
            <div className="mt-4 grid gap-2">
              <Link to="/record" className="press brand-fill inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl text-sm font-semibold">
                <img src={iconRecord} alt="" className="size-6 rounded-md object-cover" />
                {t("newRecording")}
              </Link>
              <button
                type="button"
                onClick={() => {
                  setNeedSound(false);
                  fileRef.current?.click();
                }}
                className="press inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-line text-sm font-semibold"
              >
                <img src={iconOpen} alt="" className="size-6 rounded-md object-cover" />
                {t("openFile")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notesOpen ? (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
          <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={() => setNotesOpen(false)} />
          <div className="safe-b relative z-10 m-4 max-h-[80dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{t("notes")}</h2>
              <button
                type="button"
                onClick={() => {
                  setNotesOpen(false);
                  setSheet({ kind: "new" });
                }}
                className="press min-h-11 text-sm font-semibold text-cyan"
              >
                {t("addNote")}
              </button>
            </div>
            <ul className="mt-3 grid gap-2">
              {noteItems.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setNotesOpen(false);
                      setSheet(item.sheet);
                    }}
                    className="press w-full rounded-2xl border border-line bg-surface px-4 py-3 text-start"
                  >
                    <span className="line-clamp-3 text-sm">{item.body}</span>
                    <span className="mt-2 block text-sm text-faint">{item.meta}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {tool?.kind === "denoise" ? (
        <DenoiseSheet blob={tool.blob} title={tool.title} source={tool.source} onClose={() => setTool(null)} />
      ) : null}
      {tool?.kind === "export" ? <ExportSheet blob={tool.blob} title={tool.title} onClose={() => setTool(null)} /> : null}

      <NoteSheet
        open={sheet !== null}
        title={sheet?.kind === "new" ? t("newNote") : t("editNote")}
        initial={sheet && sheet.kind !== "new" ? sheet.body : ""}
        onClose={() => setSheet(null)}
        onSave={(body) => void saveSheet(body)}
        onDelete={sheet && sheet.kind !== "new" ? () => void deleteSheet() : undefined}
      />
    </Frame>
  );
}
