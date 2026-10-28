import { buildRoomImpulse, impulseEnergy } from "../src/lib/room.ts";
import { packAacFrames, AAC_FRAME } from "../src/lib/aac-pack.ts";
import { flushAfterFrames, mergeInt16 } from "../src/lib/checkpoint.ts";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const room = buildRoomImpulse(48000, false);
assert(room.left.length === Math.floor(48000 * 1.8), "reverb length");
assert(room.left.length > room.right.length - 1, "stereo length");
let peak = 0;
for (let i = 0; i < room.left.length; i++) {
  const l = room.left[i];
  const r = room.right[i];
  assert(Number.isFinite(l) && Number.isFinite(r), "finite");
  peak = Math.max(peak, Math.abs(l), Math.abs(r));
}
assert(peak <= 0.901, `peak ${peak}`);
const earlyAt = Math.floor(0.011 * 48000);
assert(Math.abs(room.left[earlyAt]) > 0.2, "early reflection");
const head = impulseEnergy(room.left, 0, 48000 * 0.1);
const tail = impulseEnergy(room.left, Math.floor(48000 * 1.2), room.left.length);
assert(head > tail * 4, `decay head ${head} tail ${tail}`);
assert(tail > 0, "tail exists");
let differ = 0;
for (let i = 0; i < 4000; i++) if (room.left[i] !== room.right[i]) differ += 1;
assert(differ > 10, "stereo image");
const light = buildRoomImpulse(48000, true);
assert(light.left.length < room.left.length, "light room shorter");
assert(light.left.length >= Math.floor(48000 * 0.9), "light room still a room");

const short = packAacFrames(Float32Array.from([0.5, -0.25]));
assert(short.frames.length === 1, "one aac frame");
assert(short.frames[0].length === AAC_FRAME, "padded mono frame");
assert(short.frames[0][0] === 0.5 && short.frames[0][1] === -0.25 && short.frames[0][AAC_FRAME - 1] === 0, "pad zeros");
const long = new Float32Array(AAC_FRAME + 10);
long[0] = 0.5;
long[AAC_FRAME] = -0.5;
const split = packAacFrames(long, undefined, true);
assert(split.channels === 2 && split.frames.length === 2, "two stereo frames");
assert(split.frames[0][0] === 0.5 && split.frames[0][1] === 0.5, "dual mono");
assert(split.frames[1][0] === -0.5 && split.frames[1][2] === 0, "second frame padded");

const merged = mergeInt16([Int16Array.from([1, 2]), Int16Array.from([3, 4, 5])]);
assert(merged.length === 5 && merged[0] === 1 && merged[4] === 5, "checkpoint merge");
assert(flushAfterFrames(48000) === 12000, "flush every 250ms");

console.log("strengthen ok", {
  reverbSeconds: room.left.length / 48000,
  early: room.left[earlyAt],
  head,
  tail,
  aacFrames: split.frames.length,
  flushFrames: flushAfterFrames(48000),
});

const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": "/workspace/src" } });
const { applyGate } = await jiti.import("../src/lib/dsp.ts");
const { spanAroundMark, dropCallMarks } = await jiti.import("../src/lib/join-ranges.ts");
const { wavFromPcm } = await jiti.import("../src/lib/wav.ts");
const { parseWav, wavWindow } = await jiti.import("../src/lib/stream.ts");

const rate = 8000;
const noise = new Float32Array(rate);
const toneAt = Math.floor(rate * 0.25);
for (let i = 0; i < noise.length; i++) noise[i] = ((i * 17) % 11) / 11 * 0.02 - 0.01;
for (let i = toneAt; i < toneAt + rate * 0.3; i++) noise[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.45;
const beforeStart = Math.max(...Array.from({ length: 40 }, (_, n) => Math.abs(Math.sin((2 * Math.PI * 220 * (toneAt + n)) / rate) * 0.45)));
applyGate([noise], 80);
let quiet = 0;
let quietCount = 0;
for (let i = 0; i < toneAt - 400; i++) {
  quiet += noise[i] ** 2;
  quietCount += 1;
}
let loud = 0;
let loudCount = 0;
for (let i = toneAt + 200; i < toneAt + rate * 0.25; i++) {
  loud += noise[i] ** 2;
  loudCount += 1;
}
const quietRms = Math.sqrt(quiet / quietCount);
const loudRms = Math.sqrt(loud / loudCount);
let attack = 0;
for (let i = toneAt; i < toneAt + 40; i++) attack = Math.max(attack, Math.abs(noise[i]));
assert(quietRms < 0.002, `gate quiet ${quietRms}`);
assert(loudRms > 0.2, `gate speech ${loudRms}`);
assert(attack > beforeStart * 0.45, `gate lookahead ${attack} vs ${beforeStart}`);

const call = new Int16Array(rate);
const click = Math.floor(rate * 0.3);
for (let i = 0; i < click; i++) call[i] = Math.round(Math.sin((2 * Math.PI * 180 * i) / rate) * 5000);
call[click] = 30000;
for (let i = Math.floor(rate * 0.62); i < call.length; i++) call[i] = Math.round(Math.sin((2 * Math.PI * 180 * i) / rate) * 5000);
const local = spanAroundMark(call, click, rate);
assert(local.from <= click && local.to > click + rate * 0.2, `span ${local.from}-${local.to}`);
assert(local.to < rate * 0.7, "span does not eat the next phrase");
const cleaned = await dropCallMarks(wavFromPcm(call, rate), 1000, [300]);
assert(cleaned && cleaned.durationMs < 800 && cleaned.durationMs > 400, `call duration ${cleaned?.durationMs}`);
const bytes = await cleaned.blob.arrayBuffer();
const info = parseWav(bytes, bytes.byteLength);
assert(info, "cleaned wav");
const back = wavWindow(new DataView(bytes), info, 0, info.frames);
let max = 0;
let step = 0;
for (let i = 1; i < back.length; i++) {
  max = Math.max(max, Math.abs(back[i]));
  step = Math.max(step, Math.abs(back[i] - back[i - 1]));
}
assert(max < 0.5, `click remains ${max}`);
assert(step < 0.35, `join click ${step}`);
console.log("gate and call ok", { quietRms, loudRms, kept: cleaned.durationMs, max, step });

function tone(hz, seconds, sampleRate, amp = 0.6) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * amp;
  return out;
}
function hzOf(samples, sampleRate) {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] ?? 0) <= 0 && (samples[i] ?? 0) > 0) {
      if (first < 0) first = i;
      last = i;
      count += 1;
    }
  }
  if (count < 2) return 0;
  return (sampleRate * (count - 1)) / (last - first);
}
function rms(samples, from, to) {
  let energy = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    energy += (samples[i] ?? 0) ** 2;
    count += 1;
  }
  return Math.sqrt(energy / Math.max(1, count));
}
const { pitchShift, timeStretch } = await jiti.import("../src/lib/dsp.ts");
const { applyOps, roomSlice, resample } = await jiti.import("../src/lib/edit.ts");
const sr = 16000;
const src = tone(220, 0.6, sr);
const raised = await pitchShift(src, 12);
const slowed = await timeStretch(src, 2);
const raisedHz = hzOf(raised, sr);
const slowedHz = hzOf(slowed, sr);
const slowTail = rms(slowed, slowed.length - 2000, slowed.length);
assert(Math.abs(raised.length - src.length) < sr * 0.03, `pitch length ${raised.length}`);
assert(raisedHz > 436 && raisedHz < 445, `pitch hz ${raisedHz}`);
assert(Math.abs(slowed.length - src.length * 2) < 8, `slow length ${slowed.length}`);
assert(slowedHz > 216 && slowedHz < 226, `slow hz ${slowedHz}`);
assert(slowTail > 0.15, `slow tail ${slowTail}`);

const speech = new Float32Array(Math.round(sr * 1.3));
const burst = (from, to) => {
  const fade = Math.round(sr * 0.012);
  for (let i = from; i < to; i++) {
    let amp = 0.5;
    if (i - from < fade) amp *= (i - from) / fade;
    if (to - i < fade) amp *= (to - i) / fade;
    speech[i] = Math.sin((2 * Math.PI * 180 * i) / sr) * amp;
  }
};
burst(0, Math.round(sr * 0.36));
burst(Math.round(sr * 0.95), Math.round(sr * 1.28));
const tight = applyOps({ samples: speech, sampleRate: sr }, [{ kind: "tighten", gap: 0.08 }]);
assert(tight.samples.length < speech.length * 0.8, `tighten length ${tight.samples.length}`);
let join = 0;
for (let i = 1; i < tight.samples.length; i++) join = Math.max(join, Math.abs((tight.samples[i] ?? 0) - (tight.samples[i - 1] ?? 0)));
assert(join < 0.2, `tighten click ${join}`);

const bed = new Float32Array(sr);
for (let i = 0; i < bed.length; i++) bed[i] = 0.003;
bed[5] = 0.95;
for (let i = Math.round(sr * 0.5); i < bed.length; i++) bed[i] = (i % 5) * 0.004;
const bedSlice = roomSlice({ samples: bed, sampleRate: sr }, 0.12);
let roomPeak = 0;
for (let i = 0; i < bedSlice.samples.length; i++) roomPeak = Math.max(roomPeak, Math.abs(bedSlice.samples[i] ?? 0));
assert(roomPeak < 0.2, `room peak ${roomPeak}`);
console.log("pitch and tighten ok", { raisedHz, slowedHz, slowTail, kept: tight.samples.length, join, roomPeak });

const exact = new Float32Array(8000);
for (let i = 0; i < exact.length; i++) exact[i] = 0.2;
exact[4000] = 0.9;
exact[500] = 0.33;
const cut = applyOps({ samples: exact, sampleRate: 8000 }, [{ kind: "drop", start: 0.4, end: 0.6 }]);
assert(cut.samples.length === 6400, `exact length ${cut.samples.length}`);
assert(!cut.samples.some((sample) => sample > 0.8), "deleted spike leaked");
assert(Math.abs((cut.samples[500] ?? 0) - 0.33) < 0.0001, "kept sample changed");
const { clipFrame } = await jiti.import("../src/lib/stream.ts");
const clipped = clipFrame(Float32Array.from([1, 2, 3, 4, 5, 6]), 10, 12, 15);
assert(clipped && clipped.length === 3 && clipped[0] === 3 && clipped[2] === 5, "slice trim");
const { speechStops, nearestStop: nearStop } = await jiti.import("../src/lib/phrases.ts");
const energy = [];
for (let i = 0; i < 60; i++) energy.push(i >= 20 && i < 40 ? 0.001 : 0.4);
const found = speechStops(energy);
assert(found.length === 1 && found[0] > 0.3 && found[0] < 0.45, `stops ${found.join(",")}`);
assert(nearStop(found, found[0] + 0.01, 0.02) === found[0], "snap to pause");
assert(nearStop(found, 0.9, 0.02) === 0.9, "mid-word stays exact");
console.log("exact cut ok", { length: cut.samples.length, stops: found });

const { normalizePeak, toMono } = await jiti.import("../src/lib/dsp.ts");
function rmsOf(samples) {
  let energy = 0;
  for (const value of samples) energy += value * value;
  return Math.sqrt(energy / Math.max(1, samples.length));
}
function peakOf(samples) {
  let max = 0;
  for (const value of samples) max = Math.max(max, Math.abs(value));
  return max;
}
const level = [new Float32Array(8000), new Float32Array(8000)];
for (let i = 0; i < 8000; i++) {
  const value = Math.sin((2 * Math.PI * 220 * i) / 8000) * 0.05;
  level[0][i] = value;
  level[1][i] = value;
}
normalizePeak(level);
assert(peakOf(level[0]) > 0.8 && peakOf(level[0]) <= 1, `quiet peak ${peakOf(level[0])}`);
assert(Math.abs(level[0][10] - level[1][10]) < 0.0001, "channels diverged");
const spiked = [new Float32Array(8000)];
for (let i = 0; i < 8000; i++) spiked[0][i] = Math.sin((2 * Math.PI * 220 * i) / 8000) * 0.05;
spiked[0][100] = 1;
normalizePeak(spiked);
assert(peakOf(spiked[0]) <= 1, `spike peak ${peakOf(spiked[0])}`);
assert(rmsOf(spiked[0]) > 0.4, `spike body ${rmsOf(spiked[0])}`);
const left = new Float32Array(2000);
const right = new Float32Array(2000);
for (let i = 0; i < left.length; i++) {
  left[i] = Math.sin(i * 0.2) * 0.5;
  right[i] = -left[i];
}
const saved = toMono([left, right]);
assert(rmsOf(saved[0]) > 0.3, `phase mono ${rmsOf(saved[0])}`);
const twin = new Float32Array(left);
for (let i = 0; i < twin.length; i++) twin[i] = left[i];
const averaged = toMono([left, twin]);
assert(Math.abs(rmsOf(averaged[0]) - rmsOf(left)) < 0.02, "in-phase mono changed");
console.log("level ok", { quiet: peakOf(level[0]), body: rmsOf(spiked[0]), phase: rmsOf(saved[0]) });

const { keptSpans, joinEdges, stepTo, ratioOf } = await jiti.import("../src/lib/fix.ts");
const spans = keptSpans([0.4, 0.6], [{ start: 0.4, end: 0.6 }]);
const edges = joinEdges(spans, 0.5, 1.4, 1800);
assert(spans.length === 2 && spans[0].end === 0.4 && spans[1].start === 0.6, "kept spans");
assert(edges && edges.leftTo <= 0.401 && edges.rightFrom >= 0.599, "join skips the mistake");
assert(edges.leftTo - edges.leftFrom < 0.001, `pad ${edges.leftTo - edges.leftFrom}`);
assert(stepTo(0.1, [0.3, 0.7], 1) === 0.3, "next mark");
assert(stepTo(0.5, [0.3, 0.7], -1) === 0.3, "prev mark");
assert(stepTo(0.2, [0.8], -1) === 0.2, "no earlier mark");
const word = 5 / 1800;
const wordSpans = keptSpans([word], []);
assert(wordSpans.length === 2 && Math.abs(wordSpans[0].end - word) < 1e-9, "a word on a 30 minute file");
assert(ratioOf(0.04, 1800000) < word, "gap is shorter than five seconds");
const breath = 0.3 / 1800;
const keptWord = keptSpans([10 / 1800, 10 / 1800 + breath], []);
assert(keptWord.some((span) => Math.abs(span.end - span.start - breath) < 1e-9), "a 0.3s word stays");
assert(stepTo(0, [0.0003, 0.001], 1) === 0.0003, "next pause can be under a second");
console.log("fix flow ok", edges);

const { mixPlan, mixSpan, splitClip } = await jiti.import("../src/lib/mix.ts");
const plan = mixPlan(30000);
const planned = plan.reduce((sum, piece) => sum + piece.keepMs, 0);
assert(planned === 30000 && plan[0].keepMs === 8000 && plan.length === 4, `mix plan ${planned}`);
const warm = mixSpan(8000, 30000);
assert(warm.from === 7300 && warm.skipMs === 700 && warm.keepMs === 8000, `warm ${warm.from}`);
const clip = { id: "a", audioId: "a", name: "a", kind: "voice", startMs: 1000, offsetMs: 200, durationMs: 5000, sourceMs: 8000, gain: 1, peaks: [] };
const parts = splitClip(clip, 3000);
assert(parts && parts[0].durationMs + parts[1].durationMs === 5000, "split length");
assert(parts[1].offsetMs === 2200 && parts[1].startMs === 3000, `split place ${parts[1].offsetMs}`);

const frames = 1000;
const stereoBytes = new ArrayBuffer(frames * 4);
const stereoView = new DataView(stereoBytes);
for (let i = 0; i < frames; i++) {
  const sample = Math.round(Math.sin(i / 8) * 16000);
  stereoView.setInt16(i * 4, sample, true);
  stereoView.setInt16(i * 4 + 2, -sample, true);
}
const folded = wavWindow(stereoView, { rate: 16000, channels: 2, dataStart: 0, frames }, 0, frames);
let foldedEnergy = 0;
for (const value of folded) foldedEnergy += value * value;
assert(foldedEnergy / frames > 0.05, `phase energy ${foldedEnergy / frames}`);

const loudIn = new Float32Array(4000);
for (let i = 0; i < loudIn.length; i++) loudIn[i] = Math.sin(i / 5) * 0.8;
const louder = applyOps({ samples: loudIn, sampleRate: 16000 }, [{ kind: "gain", gain: 4 }]);
let loudPeak = 0;
let flat = 0;
for (const value of louder.samples) {
  loudPeak = Math.max(loudPeak, Math.abs(value));
  if (Math.abs(Math.abs(value) - 1) < 1e-5) flat += 1;
}
assert(loudPeak < 0.999 && flat === 0 && rmsOf(louder.samples) > 0.5, `gain ${loudPeak} ${flat}`);
const high = new Float32Array(1600);
for (let i = 0; i < high.length; i++) high[i] = Math.sin((2 * Math.PI * 3000 * i) / 16000);
const trip = resample(resample(high, 16000, 48000), 48000, 16000);
let agree = 0;
let power = 0;
const n = Math.min(high.length, trip.length);
for (let i = 20; i < n - 20; i++) {
  agree += (high[i] ?? 0) * (trip[i] ?? 0);
  power += (high[i] ?? 0) ** 2;
}
assert(agree / power > 0.9, `resample ${agree / power}`);
console.log("studio ok", { planned, phase: foldedEnergy / frames, loudPeak, resample: agree / power });

const { createDenoiseSession } = await jiti.import("../src/lib/denoise-session.ts");
const denoiseRate = 48000;
const noisy = new Float32Array(denoiseRate);
let seed = 1;
for (let i = 0; i < noisy.length; i++) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  const noise = (seed / 4294967296 * 2 - 1) * 0.08;
  const voice = i > denoiseRate * 0.25 && i < denoiseRate * 0.7 ? Math.sin((2 * Math.PI * 180 * i) / denoiseRate) * 0.35 : 0;
  noisy[i] = noise + voice;
}
const session = await createDenoiseSession(denoiseRate, 0.8);
const cleanedPcm = session.push(noisy, true);
session.close();
const rms16 = (samples, a, b) => {
  let energy = 0;
  let count = 0;
  for (let i = a; i < b; i++) {
    const value = (samples[i] ?? 0) / 32768;
    energy += value * value;
    count += 1;
  }
  return Math.sqrt(energy / Math.max(1, count));
};
const denoiseNoise = rms16(cleanedPcm, Math.floor(denoiseRate * 0.05), Math.floor(denoiseRate * 0.18));
const denoiseVoice = rms16(cleanedPcm, Math.floor(denoiseRate * 0.4), Math.floor(denoiseRate * 0.55));
const denoiseHead = rms16(cleanedPcm, 0, 400);
assert(cleanedPcm.length > denoiseRate * 0.95, `denoise length ${cleanedPcm.length}`);
assert(denoiseHead > 0.01, `denoise ate the start ${denoiseHead}`);
assert(denoiseVoice / Math.max(1e-6, denoiseNoise) > 8, `denoise ratio ${denoiseVoice / denoiseNoise}`);
console.log("denoise ok", { denoiseHead, denoiseNoise, denoiseVoice });

const { joinRanges } = await jiti.import("../src/lib/join-ranges.ts");
const shortTone = new Int16Array(48000 * 10);
for (let i = 0; i < shortTone.length; i++) shortTone[i] = Math.round(Math.sin(i / 12) * 8000);
const joined = await joinRanges(wavFromPcm(shortTone, 48000), [{ start: 0.1, end: 0.1015 }], 2);
assert(joined && joined.durationMs > 10 && joined.durationMs < 30, `short piece ${joined?.durationMs}`);
console.log("short cut ok", joined.durationMs);

const { sliceFrames, streamSlice } = await jiti.import("../src/lib/stream.ts");
const boundaryFrames = 48000;
const cutAt = 1000 / boundaryFrames;
const leftSide = sliceFrames(boundaryFrames, 0, cutAt);
const rightSide = sliceFrames(boundaryFrames, cutAt, 1);
assert(leftSide.to === 1000 && rightSide.from === 1000, `boundary ${leftSide.to} ${rightSide.from}`);
const marked = new Int16Array(boundaryFrames);
marked[1000] = 20000;
const markedWav = wavFromPcm(marked, boundaryFrames);
const headSlice = await streamSlice(markedWav, 0, cutAt);
const tailSlice = await streamSlice(markedWav, cutAt, 1);
assert(headSlice && Math.max(...headSlice.samples) === 0, "deleted sample leaked into the keep");
assert(tailSlice && Math.abs((tailSlice.samples[0] ?? 0) - 20000) <= 1, `kept sample moved ${tailSlice?.samples[0]}`);
console.log("sample boundary ok", { keep: headSlice.samples.length, next: tailSlice.samples.length });

const { playWindow, stopInMs } = await jiti.import("../src/lib/play-window.ts");
const heard = playWindow(1800, 5 / 1800, 5.3 / 1800);
assert(Math.abs(heard.start - 5) < 1e-6 && Math.abs(heard.stop - 5.3) < 1e-6, `play ${heard.start}-${heard.stop}`);
assert(stopInMs(5, 5.3, 5.3 / 1800) === 300, "stops at the cut, not a quarter second later");
assert(stopInMs(0, 1800, 1) === null, "full file is not cut short");
const early = playWindow(1800, 0.002, 0.003);
assert(early.start > 3 && early.start < 4, `early word ${early.start}`);
console.log("play window ok", heard);

const side = [new Float32Array(4000), new Float32Array(4000)];
for (let i = 0; i < 4000; i++) {
  side[0][i] = Math.sin(i * 0.2) * 0.01;
  side[1][i] = Math.sin(i * 0.2) * 0.5;
}
normalizePeak(side);
assert(peakOf(side[1]) > 0.8 && peakOf(side[1]) <= 0.995, `right peak ${peakOf(side[1])}`);
assert(peakOf(side[0]) < 0.08, `left climbed ${peakOf(side[0])}`);
const gatedRight = new Float32Array(8000);
const gatedLeft = new Float32Array(8000);
for (let i = 0; i < 8000; i++) {
  gatedLeft[i] = ((i * 13) % 7) * 0.001;
  gatedRight[i] = i > 2000 && i < 5000 ? Math.sin(i * 0.3) * 0.4 : gatedLeft[i];
}
applyGate([gatedLeft, gatedRight], 70);
let rightSpeech = 0;
let rightQuiet = 0;
for (let i = 2500; i < 4500; i++) rightSpeech += gatedRight[i] ** 2;
for (let i = 5600; i < 7600; i++) rightQuiet += gatedRight[i] ** 2;
assert(Math.sqrt(rightSpeech / 2000) > 0.2, "gate missed the loud channel");
assert(Math.sqrt(rightQuiet / 2000) < 0.02, "gate left the loud channel open");
const { phrasesFromEnergy } = await jiti.import("../src/lib/phrases.ts");
const words = new Array(100).fill(0.001);
for (let i = 10; i < 18; i++) words[i] = 0.5;
for (let i = 40; i < 48; i++) words[i] = 0.5;
const two = phrasesFromEnergy(words);
assert(two.length === 2, `short words ${two.length}`);
const dip = new Array(40).fill(0.4);
dip[15] = 0.001;
assert(speechStops(dip).length === 0, "one quiet frame is not a pause");
const row = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const moved = applyOps({ samples: row, sampleRate: 8000 }, [{ kind: "swap", a0: 0, a1: 0.41, b0: 0.61, b1: 1 }]);
assert(moved.samples[0] === 6 && moved.samples[4] === 4, `swap ${moved.samples.join(",")}`);
const fadeFlat = new Float32Array(8000);
fadeFlat.fill(1);
const faded = applyOps({ samples: fadeFlat, sampleRate: 8000 }, [{ kind: "fadeIn", seconds: 0.1 }]);
assert((faded.samples[399] ?? 0) > 0.65, `fade mid ${(faded.samples[399] ?? 0).toFixed(3)}`);
console.log("functions ok", { right: peakOf(side[1]), words: two.length, fade: faded.samples[399] });

const { matchGain, reviewRate, loopAround, tightenSavings, guardDrop, burstMarks, similarMarks } = await jiti.import("../src/lib/studio-tools.ts");
const quietInsert = new Float32Array(1000).fill(0.05);
const loudNeighbor = new Float32Array(1000).fill(0.25);
assert(Math.abs(matchGain(quietInsert, loudNeighbor) - 4) < 0.01, "match caps the jump");
assert(reviewRate(0.5, [0.2], 0.01) === 1.5, "review stays fast away from a mark");
assert(reviewRate(0.2, [0.205], 0.01) === 1, "review slows at a mark");
const loop = loopAround(0.5, 2, 100);
assert(Math.abs(loop.start - 0.48) < 1e-6 && Math.abs(loop.end - 0.52) < 1e-6, `loop ${loop.start}`);
const tightenPreview = tightenSavings(48000 * 30, 48000, [{ start: 0, end: 0.1 }, { start: 0.8, end: 1 }], 0.2);
assert(tightenPreview.removedMs > 20000 && tightenPreview.removedMs < 40000, `tighten preview ${tightenPreview.removedMs}`);
const guarded = guardDrop(0.2, 0.8, [{ start: 0.4, end: 0.5 }]);
assert(guarded.length === 2 && Math.abs(guarded[0].end - 0.4) < 1e-6 && Math.abs(guarded[1].start - 0.5) < 1e-6, "lock keeps the middle");
const burstEnergy = new Array(200).fill(0.001);
for (let i = 40; i < 48; i++) burstEnergy[i] = 0.2;
for (let i = 80; i < 160; i++) burstEnergy[i] = 0.2;
const bursts = burstMarks(burstEnergy, 0.01);
assert(bursts.length === 1 && bursts[0] > 0.2 && bursts[0] < 0.28, `cough ${bursts.join(",")}`);
const shape = [0.01, 0.02, 0.2, 0.45, 0.2, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01];
const repeated = [...shape, ...new Array(20).fill(0.001), ...shape, ...new Array(20).fill(0.001)];
const likes = similarMarks(repeated, 8 / repeated.length, 0.01);
assert(likes.length === 1, `similar ${likes.length}`);
console.log("studio tools ok", { saved: Math.round(tightenPreview.removedMs), bursts, likes });












