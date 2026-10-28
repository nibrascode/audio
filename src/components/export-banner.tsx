import { fileLooksComplete, useExportRun, cancelExport, dismissExport } from "@/lib/export-run";
import { saveToPhone } from "@/lib/audio";
import { useI18n } from "@/lib/i18n";
import { useState } from "react";

export function ExportBanner() {
  const { t } = useI18n();
  const run = useExportRun();
  const [note, setNote] = useState<string | null>(null);
  if (run.state === "idle" || run.sheet) return null;

  async function save() {
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
    <div className="safe-b pointer-events-none fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-lg px-4 pb-3">
      <div className="pointer-events-auto rounded-2xl border border-line bg-surface-2 p-3">
        {run.state === "run" ? (
          <>
            <p className="text-sm font-semibold">{t("processing")} {Math.round(run.progress * 100)}%</p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg">
              <div className="h-full bg-cyan" style={{ width: `${Math.round(run.progress * 100)}%` }} />
            </div>
            <p className="mt-2 text-sm text-pretty text-muted">{t("exportKeeps")}</p>
            {run.light ? <p className="mt-1 text-sm text-faint">{t("lightDevice")}</p> : null}
            <button type="button" onClick={cancelExport} className="press mt-3 min-h-11 rounded-full border border-line px-4 text-sm font-semibold">
              {t("exportStop")}
            </button>
          </>
        ) : null}
        {run.state === "ready" ? (
          <>
            <p className="text-sm font-semibold">{t("exportReady")}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={dismissExport} className="press min-h-11 rounded-full border border-line text-sm font-semibold">
                {t("close")}
              </button>
              <button type="button" onClick={() => void save()} className="press brand-fill min-h-11 rounded-full text-sm font-semibold">
                {t("savePhone")}
              </button>
            </div>
          </>
        ) : null}
        {run.state === "note" ? (
          <>
            <p className="text-sm text-pretty text-muted">{run.kind === "interrupted" ? t("exportInterrupted") : run.kind === "cancelled" ? t("exportCancelled") : t("exportFail")}</p>
            <button type="button" onClick={dismissExport} className="press mt-3 min-h-11 rounded-full border border-line px-4 text-sm font-semibold">
              {t("close")}
            </button>
          </>
        ) : null}
        {note ? <p className="mt-2 text-sm text-cyan">{note}</p> : null}
      </div>
    </div>
  );
}
