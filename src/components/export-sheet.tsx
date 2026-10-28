import { useEffect, useState } from "react";
import { decodeChannels } from "@/lib/edit";
import { safeName, saveToPhone } from "@/lib/audio";
import { isLightDevice } from "@/lib/device";
import { fileLooksComplete, setExportSheetOpen, startExport, useExportRun, cancelExport, dismissExport } from "@/lib/export-run";
import { canExportM4a } from "@/lib/m4a";
import type { ExportFormat, ExportRate } from "@/lib/jobs";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const RATES: ExportRate[] = [44100, 48000];
const BITRATES = [96, 128, 192, 320] as const;

export function ExportSheet({ blob, title, onClose }: { blob: Blob; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [rate, setRate] = useState<ExportRate>(48000);
  const [bitrate, setBitrate] = useState<(typeof BITRATES)[number]>(192);
  const [channels, setChannels] = useState<"mono" | "stereo">("stereo");
  const [m4aOk, setM4aOk] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const run = useExportRun();
  const light = run.state === "run" ? run.light : isLightDevice();

  useEffect(() => {
    setExportSheetOpen(true);
    void canExportM4a().then(setM4aOk);
    return () => setExportSheetOpen(false);
  }, []);

  async function runExport() {
    if (run.state === "run" || decoding) return;
    setNote(null);
    setDecoding(true);
    try {
      const decoded = await decodeChannels(blob, channels);
      const left = decoded.channels[0];
      if (!left?.length) throw new Error("empty");
      const dualMono = channels === "stereo" && decoded.channels.length < 2;
      const started = startExport({
        title,
        filename: `${safeName(title)}.${format}`,
        format,
        samples: left,
        sampleRate: decoded.sampleRate,
        targetRate: rate,
        bitrate,
        right: dualMono ? undefined : decoded.channels[1],
        dualMono,
      });
      if (!started) setNote(t("exportFail"));
    } catch {
      setNote(t("exportFail"));
    } finally {
      setDecoding(false);
    }
  }

  async function saveReady() {
    if (run.state !== "ready") return;
    if (!(await fileLooksComplete(run.blob, run.format))) {
      setNote(t("exportInterrupted"));
      return;
    }
    const result = await saveToPhone(run.blob, run.filename, run.title);
    if (result === "cancelled") return;
    setNote(result === "saved" ? t("exportSaved") : result === "shared" ? t("shared") : t("shareFallback"));
    dismissExport();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={onClose} />
      <div className="safe-b relative z-10 m-4 max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
        <h2 className="text-lg font-semibold">{t("savePhone")}</h2>
        <p className="mt-2 text-sm text-pretty text-muted">{t("exportBody")}</p>
        <div className="mt-4 grid grid-cols-3 gap-2" role="group" aria-label={t("formatLabel")}>
          {(["wav", "mp3", "m4a"] as const).map((item) => (
            <button
              key={item}
              type="button"
              disabled={item === "m4a" && !m4aOk}
              aria-pressed={format === item}
              onClick={() => setFormat(item)}
              className={cn(
                "press min-h-11 rounded-full text-sm font-semibold disabled:opacity-40",
                format === item ? "brand-fill" : "border border-line bg-surface text-muted",
              )}
            >
              {t(item)}
            </button>
          ))}
        </div>
        {!m4aOk ? <p className="mt-2 text-sm text-faint">{t("m4aExportUnavailable")}</p> : null}
        <div className="mt-4 grid grid-cols-2 gap-2" role="group" aria-label={t("sampleRate")}>
          {RATES.map((item) => (
            <button key={item} type="button" aria-pressed={rate === item} onClick={() => setRate(item)} className={cn("press min-h-11 rounded-full text-sm font-semibold", rate === item ? "brand-fill" : "border border-line bg-surface text-muted")}>
              {item === 44100 ? t("kHz441") : t("kHz48")}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label={t("channels")}>
          {(["mono", "stereo"] as const).map((item) => (
            <button key={item} type="button" aria-pressed={channels === item} onClick={() => setChannels(item)} className={cn("press min-h-11 rounded-full text-sm font-semibold", channels === item ? "brand-fill" : "border border-line bg-surface text-muted")}>
              {t(item)}
            </button>
          ))}
        </div>
        {format === "wav" ? (
          <p className="mt-3 text-sm text-muted">{t("lossless")}</p>
        ) : (
          <div className="mt-3 grid grid-cols-4 gap-2" role="group" aria-label={t("bitrate")}>
            {BITRATES.map((item) => (
              <button key={item} type="button" aria-pressed={bitrate === item} onClick={() => setBitrate(item)} className={cn("press min-h-11 rounded-full text-sm font-semibold", bitrate === item ? "brand-fill" : "border border-line bg-surface text-muted")}>
                {item}
              </button>
            ))}
          </div>
        )}
        {light ? <p className="mt-3 text-sm text-faint">{t("lightDevice")}</p> : null}
        <p className="mt-3 text-sm text-pretty text-muted">{t("exportKeeps")}</p>
        {run.state === "run" || decoding ? (
          <div className="mt-4">
            <div className="h-2 overflow-hidden rounded-full bg-bg">
              <div className="h-full bg-cyan" style={{ width: `${Math.round((run.state === "run" ? run.progress : 0.04) * 100)}%` }} />
            </div>
            <p className="mt-2 text-sm text-muted" role="status">
              {t("processing")} {Math.round((run.state === "run" ? run.progress : 0.04) * 100)}%
            </p>
          </div>
        ) : null}
        {run.state === "note" ? (
          <p className="mt-3 text-sm text-muted" role="status">
            {run.kind === "interrupted" ? t("exportInterrupted") : run.kind === "cancelled" ? t("exportCancelled") : t("exportFail")}
          </p>
        ) : null}
        {run.state === "ready" ? <p className="mt-3 text-sm text-cyan" role="status">{t("exportReady")}</p> : null}
        {note ? <p className="mt-3 text-sm text-cyan" role="status">{note}</p> : null}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="press min-h-11 rounded-full border border-line text-sm font-semibold"
          >
            {run.state === "run" ? t("exportHide") : t("close")}
          </button>
          <button
            type="button"
            disabled={decoding || (run.state !== "run" && run.state !== "ready" && format === "m4a" && !m4aOk)}
            onClick={() => void (run.state === "ready" ? saveReady() : run.state === "run" ? cancelExport() : runExport())}
            className="press brand-fill min-h-11 rounded-full text-sm font-semibold disabled:opacity-40"
          >
            {run.state === "run" ? t("exportStop") : t("savePhone")}
          </button>
        </div>
      </div>
    </div>
  );
}
