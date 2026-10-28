import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AudioPlayer } from "@/components/player";
import { denoiseBlob } from "@/lib/denoise";
import { useI18n } from "@/lib/i18n";
import { useLibrary } from "@/lib/library";
import { cn } from "@/lib/utils";

function bars(peaks: number[]) {
  if (!peaks.length) return [];
  const count = 42;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * peaks.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / count));
    let max = 0;
    for (let j = from; j < to && j < peaks.length; j++) max = Math.max(max, peaks[j] ?? 0);
    out.push(max);
  }
  const top = Math.max(...out, 0.001);
  return out.map((value) => Math.min(1, value / top));
}

export function DenoiseSheet({
  blob,
  title,
  source,
  onClose,
}: {
  blob: Blob;
  title: string;
  source: "record" | "import";
  onClose: () => void;
}) {
  const { t } = useI18n();
  const library = useLibrary();
  const navigate = useNavigate();
  const [amount, setAmount] = useState(80);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cleaned, setCleaned] = useState<{ blob: Blob; peaks: number[]; frames: number; sampleRate: number } | null>(null);
  const [raw, setRaw] = useState(false);
  const [saving, setSaving] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const ratioRef = useRef(0);

  async function run() {
    if (progress != null) return;
    setNote(null);
    setProgress(0.02);
    const job = denoiseBlob(blob, amount / 100, setProgress);
    cancelRef.current = job.cancel;
    try {
      const result = await job.done;
      if (result.blob.size < 44) throw new Error("incomplete");
      setCleaned({ blob: result.blob, peaks: bars(result.peaks), frames: result.frames, sampleRate: result.sampleRate });
    } catch (err) {
      if (!(err instanceof Error && err.message === "cancelled")) setNote(t("denoiseFail"));
    } finally {
      setProgress(null);
      cancelRef.current = null;
    }
  }

  async function keep() {
    if (!cleaned || saving) return;
    setSaving(true);
    setNote(null);
    try {
      const created = await library.addProject({
        title: `${t("cleaned")} — ${title}`.slice(0, 80),
        note: "",
        blob: cleaned.blob,
        mimeType: "audio/wav",
        durationMs: Math.round((cleaned.frames / cleaned.sampleRate) * 1000),
        source,
        peaks: cleaned.peaks,
      });
      onClose();
      await navigate({ to: "/p/$id", params: { id: created.id } });
    } catch {
      setNote(t("denoiseFail"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={onClose} />
      <div className="safe-b relative z-10 m-4 max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
        <h2 className="text-lg font-semibold">{t("denoise")}</h2>
        <p className="mt-2 text-sm text-pretty text-muted">{t("denoiseBody")}</p>
        <label className="mt-4 grid gap-2 text-sm text-muted">
          <span className="flex items-center justify-between">
            {t("denoiseAmount")}
            <span className="tabular-nums text-fg">{amount}%</span>
          </span>
          <input className="nibras-range" type="range" min={0} max={100} value={amount} onChange={(event) => setAmount(Number(event.target.value))} />
        </label>
        <p className="mt-3 text-sm text-pretty text-faint">{t("denoiseNote")}</p>
        {progress != null ? (
          <div className="mt-4">
            <div className="h-2 overflow-hidden rounded-full bg-bg">
              <div className="h-full bg-cyan" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mt-2 text-sm text-muted" role="status">
              {t("processing")} {Math.round(progress * 100)}%
            </p>
          </div>
        ) : null}
        {cleaned ? (
          <div className="mt-4">
            <button
              type="button"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setRaw(true);
              }}
              onPointerUp={() => setRaw(false)}
              onPointerCancel={() => setRaw(false)}
              className={cn("press mb-3 min-h-11 w-full rounded-2xl border text-sm font-semibold", raw ? "border-cyan text-cyan" : "border-line")}
            >
              {t("abEar")}
            </button>
            <AudioPlayer blob={raw ? blob : cleaned.blob} peaks={cleaned.peaks} startRatio={ratioRef.current} onRatio={(ratio) => { ratioRef.current = ratio; }} />
          </div>
        ) : null}
        {note ? <p className="mt-3 text-sm text-danger" role="alert">{note}</p> : null}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              cancelRef.current?.();
              onClose();
            }}
            className="press min-h-11 rounded-full border border-line text-sm font-semibold"
          >
            {progress != null ? t("exportStop") : t("close")}
          </button>
          {cleaned ? (
            <button type="button" disabled={saving} onClick={() => void keep()} className="press brand-fill min-h-11 rounded-full text-sm font-semibold disabled:opacity-40">
              {t("saveResult")}
            </button>
          ) : (
            <button type="button" disabled={progress != null} onClick={() => void run()} className={cn("press brand-fill min-h-11 rounded-full text-sm font-semibold", progress != null && "opacity-40")}>
              {t("denoiseRun")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
