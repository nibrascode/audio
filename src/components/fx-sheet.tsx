import { mergeFx, type Fx } from "@/lib/fx";
import { useI18n } from "@/lib/i18n";

function Slider({
  label,
  min,
  max,
  value,
  text,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  text: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-sm text-muted">
      <span className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="tabular-nums text-fg">{text}</span>
      </span>
      <input type="range" min={min} max={max} value={value} className="nibras-range mt-2" onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function FxSheet({ fx, onChange, onClose }: { fx?: Fx; onChange: (patch: Partial<Fx>) => void; onClose: () => void }) {
  const { t } = useI18n();
  const current = mergeFx(fx);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button type="button" className="absolute inset-0 bg-bg/75" aria-label={t("close")} onClick={onClose} />
      <div className="safe-b relative z-10 m-4 max-h-[78dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-line bg-surface-2 p-5">
        <h2 className="text-lg font-semibold">{t("effects")}</h2>
        <p className="mt-2 text-sm text-pretty text-muted">{t("fxHint")}</p>
        <button
          type="button"
          aria-pressed={current.speech}
          onClick={() => onChange({ speech: !current.speech })}
          className={current.speech ? "press brand-fill mt-4 min-h-11 w-full rounded-full text-sm font-semibold" : "press mt-4 min-h-11 w-full rounded-full border border-line text-sm font-semibold"}
        >
          {t("speechClear")}
        </button>
        <div className="mt-4 grid gap-4">
          <Slider label={t("bass")} min={-12} max={12} value={current.low} text={`${current.low} dB`} onChange={(low) => onChange({ low })} />
          <Slider label={t("mid")} min={-12} max={12} value={current.mid} text={`${current.mid} dB`} onChange={(mid) => onChange({ mid })} />
          <Slider label={t("high")} min={-12} max={12} value={current.high} text={`${current.high} dB`} onChange={(high) => onChange({ high })} />
          <Slider label={t("compressor")} min={0} max={100} value={current.comp} text={`${current.comp}%`} onChange={(comp) => onChange({ comp })} />
          <Slider label={t("gate")} min={0} max={100} value={current.gate} text={`${current.gate}%`} onChange={(gate) => onChange({ gate })} />
          <Slider label={t("echo")} min={0} max={100} value={current.echo} text={`${current.echo}%`} onChange={(echo) => onChange({ echo })} />
          <Slider label={t("reverb")} min={0} max={100} value={current.reverb} text={`${current.reverb}%`} onChange={(reverb) => onChange({ reverb })} />
          <Slider label={t("pitch")} min={-12} max={12} value={current.pitch} text={`${current.pitch > 0 ? "+" : ""}${current.pitch}`} onChange={(pitch) => onChange({ pitch })} />
          <Slider label={t("speed")} min={50} max={200} value={current.speed} text={`${current.speed}%`} onChange={(speed) => onChange({ speed })} />
          <Slider label={t("soften")} min={0} max={100} value={current.soften} text={`${current.soften}%`} onChange={(soften) => onChange({ soften })} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={current.rumble} onClick={() => onChange({ rumble: !current.rumble })} className={current.rumble ? "press brand-fill min-h-11 rounded-full text-sm font-semibold" : "press min-h-11 rounded-full border border-line text-sm font-semibold"}>
            {t("rumble")}
          </button>
          <button type="button" aria-pressed={current.hiss} onClick={() => onChange({ hiss: !current.hiss })} className={current.hiss ? "press brand-fill min-h-11 rounded-full text-sm font-semibold" : "press min-h-11 rounded-full border border-line text-sm font-semibold"}>
            {t("hiss")}
          </button>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(["off", "50", "60"] as const).map((item) => (
            <button key={item} type="button" aria-pressed={current.hum === item} onClick={() => onChange({ hum: item })} className={current.hum === item ? "press brand-fill min-h-11 rounded-full text-sm font-semibold" : "press min-h-11 rounded-full border border-line text-sm font-semibold"}>
              {item === "off" ? t("humOff") : item === "50" ? t("hum50") : t("hum60")}
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={current.normalize} onClick={() => onChange({ normalize: !current.normalize })} className={current.normalize ? "press brand-fill min-h-11 rounded-full text-sm font-semibold" : "press min-h-11 rounded-full border border-line text-sm font-semibold"}>
            {t("normalize")}
          </button>
          <button type="button" aria-pressed={current.channels === "mono"} onClick={() => onChange({ channels: "mono" })} className={current.channels === "mono" ? "press brand-fill min-h-11 rounded-full text-sm font-semibold" : "press min-h-11 rounded-full border border-line text-sm font-semibold"}>
            {t("mono")}
          </button>
          <button type="button" aria-pressed={current.channels === "stereo"} onClick={() => onChange({ channels: "stereo" })} className={current.channels === "stereo" ? "press brand-fill min-h-11 rounded-full text-sm font-semibold" : "press min-h-11 rounded-full border border-line text-sm font-semibold"}>
            {t("stereo")}
          </button>
        </div>
        <p className="mt-3 text-sm text-pretty text-faint">{t("qualityNote")}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={current.limit} onClick={() => onChange({ limit: !current.limit })} className={current.limit ? "press brand-fill min-h-11 rounded-full text-sm font-semibold" : "press min-h-11 rounded-full border border-line text-sm font-semibold"}>
            {t("limiter")}
          </button>
          <button type="button" aria-pressed={current.keepPitch} onClick={() => onChange({ keepPitch: !current.keepPitch })} className={current.keepPitch ? "press brand-fill min-h-11 rounded-full text-sm font-semibold" : "press min-h-11 rounded-full border border-line text-sm font-semibold"}>
            {t("keepPitch")}
          </button>
        </div>
        <button type="button" onClick={onClose} className="press mt-4 min-h-11 w-full rounded-full border border-line text-sm font-semibold">
          {t("close")}
        </button>
      </div>
    </div>
  );
}
