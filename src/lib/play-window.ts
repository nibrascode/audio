export function playWindow(durationSec: number, startRatio: number, endRatio: number) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { start: 0, stop: 0 };
  const start = Math.min(durationSec, Math.max(0, startRatio * durationSec));
  const stop = Math.min(durationSec, Math.max(start, endRatio * durationSec));
  return { start, stop };
}

export function stopInMs(timeSec: number, stopSec: number, endRatio: number) {
  if (!(endRatio < 0.999999)) return null;
  const remain = stopSec - timeSec;
  if (remain <= 0) return 0;
  return Math.max(1, Math.round(remain * 1000));
}
