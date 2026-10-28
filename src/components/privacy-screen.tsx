import { BackLink, Frame } from "@/components/chrome";
import { useI18n } from "@/lib/i18n";

const MAIL = "Nibrascode@gmail.com";

export function PrivacyScreen() {
  const { t } = useI18n();
  const sections = [
    ["privacyLocalTitle", "privacyLocal"],
    ["privacyMicTitle", "privacyMic"],
    ["privacyProcessTitle", "privacyProcess"],
    ["privacyShareTitle", "privacyShare"],
    ["privacyNoTitle", "privacyNo"],
  ] as const;

  return (
    <Frame>
      <BackLink />
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">{t("privacy")}</h1>
      <p className="mt-3 text-sm text-pretty text-muted">{t("privacyIntro")}</p>
      <div className="mt-6 grid gap-3">
        {sections.map(([title, body]) => (
          <section key={title} className="rounded-3xl border border-line bg-surface px-4 py-4">
            <h2 className="text-base font-semibold">{t(title)}</h2>
            <p className="mt-2 text-sm text-pretty text-muted">{t(body)}</p>
          </section>
        ))}
      </div>
      <section className="mt-3 rounded-3xl border border-line bg-surface px-4 py-4">
        <h2 className="text-base font-semibold">{t("privacyContactTitle")}</h2>
        <p className="mt-2 text-sm text-pretty text-muted">{t("privacyContact")}</p>
        <a href={`mailto:${MAIL}`} className="press mt-3 inline-flex min-h-11 items-center text-base font-semibold text-cyan">
          {MAIL}
        </a>
      </section>
    </Frame>
  );
}
