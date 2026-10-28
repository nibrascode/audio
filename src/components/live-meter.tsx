import { useEffect, useRef } from "react";

type Mode = "idle" | "live" | "paused";

export function LiveMeter({ analyser, mode }: { analyser: AnalyserNode | null; mode: Mode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef(analyser);
  const modeRef = useRef(mode);
  analyserRef.current = analyser;
  modeRef.current = mode;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const bars = 27;
    let frame = 0;
    let last = Array.from({ length: bars }, () => 0.16);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const freq = new Uint8Array(128);

    const paint = (now: number) => {
      const width = canvas.clientWidth || 320;
      const height = canvas.clientHeight || 176;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bw = Math.floor(width * dpr);
      const bh = Math.floor(height * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const styles = getComputedStyle(document.documentElement);
      const cyan = styles.getPropertyValue("--color-cyan").trim() || "#3ec6ff";
      const violet = styles.getPropertyValue("--color-violet").trim() || "#7c6bff";
      const node = analyserRef.current;
      const live = modeRef.current === "live" && node;

      if (live && node) {
        node.getByteFrequencyData(freq);
        last = Array.from({ length: bars }, (_, i) => {
          const idx = Math.floor((i / bars) * freq.length * 0.72);
          return (freq[idx] ?? 0) / 255;
        });
      } else if (modeRef.current === "idle") {
        last = Array.from({ length: bars }, (_, i) =>
          reduced ? 0.22 : 0.16 + Math.abs(Math.sin(now / 680 + i * 0.42)) * 0.2,
        );
      }

      ctx.beginPath();
      ctx.strokeStyle = cyan;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      const radius = Math.min(width * 0.42, height * 0.78);
      ctx.arc(width / 2, height * 0.62, radius, Math.PI * 1.18, Math.PI * 1.82);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const gradient = ctx.createLinearGradient(0, height * 0.12, 0, height);
      gradient.addColorStop(0, cyan);
      gradient.addColorStop(1, violet);
      ctx.fillStyle = gradient;

      const gap = 5;
      const barW = (width - gap * (bars - 1)) / bars;
      const bottom = height * 0.92;
      last.forEach((value, i) => {
        const h = Math.max(6, value * height * 0.7);
        const x = i * (barW + gap);
        ctx.beginPath();
        ctx.roundRect(x, bottom - h, Math.max(2, barW), h, 99);
        ctx.fill();
      });

      const keepAnimating = !(reduced && modeRef.current !== "live");
      if (keepAnimating) frame = requestAnimationFrame(paint);
    };

    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={ref} className="h-44 w-full" aria-hidden="true" />;
}
