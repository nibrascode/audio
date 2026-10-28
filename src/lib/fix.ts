export type Span = { start: number; end: number };

export function ratioOf(seconds: number, durationMs: number) {
  return seconds / Math.max(seconds, durationMs / 1000);
}

export function keptSpans(cuts: number[], gone: Span[], edge = 0.00002): Span[] {
  const edges = [0, ...cuts.filter((cut) => cut > edge && cut < 1 - edge), 1];
  const points = [...new Set(edges.map((cut) => Math.min(1, Math.max(0, cut))))].sort((a, b) => a - b);
  const spans: Span[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index] ?? 0;
    const end = points[index + 1] ?? 1;
    const dead = gone.some((item) => Math.abs(item.start - start) < 1e-5 && Math.abs(item.end - end) < 1e-5);
    if (!dead && end - start > edge) spans.push({ start, end });
  }
  return spans;
}

export function joinEdges(spans: Span[], spot: number, seconds: number, durationSec: number) {
  if (spans.length < 2 || durationSec <= 0) return null;
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < spans.length - 1; index++) {
    const at = spans[index]?.end ?? 0;
    const distance = Math.abs(spot - at);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  const left = spans[best];
  const right = spans[best + 1];
  if (!left || !right) return null;
  const pad = Math.min(2.5, Math.max(0.45, seconds)) / durationSec;
  return {
    leftFrom: Math.max(left.start, left.end - pad),
    leftTo: left.end,
    rightFrom: right.start,
    rightTo: Math.min(right.end, right.start + pad),
  };
}

export function stepTo(spot: number, marks: number[], direction: 1 | -1, minGap = 0.00002) {
  const sorted = marks.filter((mark) => mark > 0.00002 && mark < 0.99998).sort((a, b) => a - b);
  if (direction > 0) return sorted.find((mark) => mark > spot + minGap) ?? spot;
  for (let index = sorted.length - 1; index >= 0; index--) {
    const mark = sorted[index] ?? 0;
    if (mark < spot - minGap) return mark;
  }
  return spot;
}
