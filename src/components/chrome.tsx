import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronLeft, Settings } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import mark from "@/assets/nibras-mark.jpg";
import type { MicPerm } from "@/lib/audio";
import { useI18n, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const LOCALES: { id: Locale; label: string }[] = [
  { id: "az", label: "Azərbaycan" },
  { id: "tr", label: "Türkçe" },
  { id: "en", label: "English" },
  { id: "ru", label: "Русский" },
  { id: "ar", label: "العربية" },
];

export function Frame({ children, wide, app }: { children: ReactNode; wide?: boolean; app?: boolean }) {
  const { locale } = useI18n();
  return (
    <div
      dir={locale === "ar" ? "rtl" : "ltr"}
      lang={locale}
      className={cn(
        "safe-x safe-t relative mx-auto flex w-full flex-col",
        app ? "h-dvh overflow-hidden" : "safe-b min-h-dvh",
        wide ? "max-w-none" : "max-w-lg",
      )}
    >
      <div className="studio-glow pointer-events-none fixed inset-0" aria-hidden="true" />
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </div>
  );
}

export function Wordmark() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3">
      <img src={mark} alt="" width={48} height={48} className="size-12 rounded-2xl" />
      <div>
        <h1 className="text-lg font-semibold leading-tight">{t("appName")}</h1>
        <p className="text-sm text-muted">{t("tagline")}</p>
      </div>
    </div>
  );
}

export function SettingsButton() {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [langs, setLangs] = useState(false);
  const current = LOCALES.find((item) => item.id === locale) ?? LOCALES[0];

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label={t("settings")}
        aria-expanded={open}
        onClick={() => {
          setLangs(false);
          setOpen(true);
        }}
        className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-fg"
      >
        <Settings className="size-5" />
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={() => setOpen(false)} />
          <div className="safe-b relative z-10 m-4 max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
            <h2 className="text-lg font-semibold">{t("settings")}</h2>
            <button
              type="button"
              aria-expanded={langs}
              onClick={() => setLangs((value) => !value)}
              className="press mt-4 flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 text-start text-sm font-semibold"
            >
              <span>{t("lang")}</span>
              <span className="inline-flex items-center gap-1 text-muted">
                {current.label}
                <ChevronDown className={cn("size-4 transition", langs && "rotate-180")} />
              </span>
            </button>
            {langs ? (
              <div className="mt-2 grid gap-2" role="group" aria-label={t("lang")}>
                {LOCALES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={locale === item.id}
                    onClick={() => {
                      setLocale(item.id);
                      setLangs(false);
                    }}
                    className={cn(
                      "press min-h-11 rounded-2xl px-4 text-start text-sm font-semibold",
                      locale === item.id ? "brand-fill" : "border border-line bg-bg text-fg",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
            <Link
              to="/privacy"
              onClick={() => setOpen(false)}
              className="press mt-2 flex min-h-12 w-full items-center rounded-2xl border border-line bg-surface px-4 text-start text-sm font-semibold"
            >
              {t("privacy")}
            </Link>
            <a href="mailto:Nibrascode@gmail.com" className="press mt-2 flex min-h-12 w-full items-center rounded-2xl px-4 text-sm font-semibold text-cyan">
              Nibrascode@gmail.com
            </a>
            <button type="button" onClick={() => setOpen(false)} className="press mt-4 min-h-11 w-full rounded-full border border-line text-sm font-semibold">
              {t("close")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium text-faint">{children}</h2>
      {action}
    </div>
  );
}

export function MicStatus({ perm }: { perm: MicPerm }) {
  const { t } = useI18n();
  const label =
    perm === "granted"
      ? t("micReady")
      : perm === "denied"
        ? t("micDenied")
        : perm === "unsupported"
          ? t("micUnsupported")
          : perm === "insecure"
            ? t("micInsecure")
            : perm === "missing"
              ? t("micMissing")
              : perm === "busy"
                ? t("micBusy")
                : perm === "requesting"
                  ? t("micRequesting")
                  : t("micPrompt");
  const dot =
    perm === "granted" ? "bg-cyan" : perm === "denied" || perm === "busy" || perm === "missing" ? "bg-danger" : "bg-faint";
  return (
    <p className="inline-flex items-center gap-2 text-sm text-muted">
      <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden="true" />
      {label}
    </p>
  );
}

export function NoteSheet({
  open,
  title,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  title: string;
  initial: string;
  onClose: () => void;
  onSave: (body: string) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <button type="button" className="absolute inset-0 bg-bg/70" aria-label={t("close")} onClick={onClose} />
      <form
        className="safe-b relative z-10 w-full max-w-lg rounded-t-3xl border border-line bg-surface-2 p-5 sm:rounded-3xl"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const body = String(data.get("body") ?? "").trim();
          if (!body) return;
          onSave(body);
        }}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <textarea
          name="body"
          key={initial}
          defaultValue={initial}
          autoFocus
          rows={5}
          maxLength={8000}
          placeholder={t("noteBody")}
          aria-label={t("noteBody")}
          className="mt-4 w-full resize-none rounded-2xl border border-line bg-bg px-4 py-3 text-fg outline-none focus:border-cyan"
        />
        <div className="mt-4 flex items-center gap-3">
          {onDelete ? (
            <button type="button" onClick={onDelete} className="press min-h-11 px-2 text-sm font-medium text-danger">
              {t("deleteNote")}
            </button>
          ) : (
            <span />
          )}
          <div className="ms-auto flex gap-2">
            <button type="button" onClick={onClose} className="press min-h-11 rounded-full px-4 text-sm font-medium text-muted">
              {t("cancel")}
            </button>
            <button type="submit" className="press brand-fill min-h-11 rounded-full px-5 text-sm font-semibold">
              {t("save")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function BackLink() {
  const { t } = useI18n();
  return (
    <Link to="/" className="press inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted">
      <ChevronLeft className="size-4 rtl:rotate-180" />
      {t("back")}
    </Link>
  );
}

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <Frame>
      <div className="flex flex-1 flex-col items-start justify-center gap-4">
        <h1 className="text-2xl font-semibold">{t("notFound")}</h1>
        <Link to="/" className="press brand-fill inline-flex min-h-11 items-center rounded-full px-5 text-sm font-semibold">
          {t("goHome")}
        </Link>
      </div>
    </Frame>
  );
}
