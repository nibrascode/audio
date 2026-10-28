import { isLightDevice } from "@/lib/device";
import { buildRoomImpulse } from "@/lib/room";
import { applyGate, normalizePeak, pitchShift, timeStretch, toMono } from "@/lib/dsp";

export type Fx = {
  low: number;
  mid: number;
  high: number;
  speech: boolean;
  comp: number;
  limit: boolean;
  gate: number;
  echo: number;
  reverb: number;
  pitch: number;
  speed: number;
  keepPitch: boolean;
  soften: number;
  rumble: boolean;
  hiss: boolean;
  hum: "off" | "50" | "60";
  normalize: boolean;
  channels: "mono" | "stereo";
};

export function defaultFx(): Fx {
  return {
    low: 0,
    mid: 0,
    high: 0,
    speech: false,
    comp: 0,
    limit: true,
    gate: 0,
    echo: 0,
    reverb: 0,
    pitch: 0,
    speed: 100,
    keepPitch: true,
    soften: 0,
    rumble: false,
    hiss: false,
    hum: "off",
    normalize: false,
    channels: "stereo",
  };
}

export function mergeFx(fx?: Partial<Fx> | null): Fx {
  return { ...defaultFx(), ...(fx ?? {}) };
}

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>();

function roomImpulse(ctx: BaseAudioContext) {
  const cached = impulses.get(ctx);
  if (cached) return cached;
  const built = buildRoomImpulse(ctx.sampleRate, isLightDevice());
  const buffer = ctx.createBuffer(2, built.left.length, built.sampleRate);
  buffer.copyToChannel(built.left, 0);
  buffer.copyToChannel(built.right, 1);
  impulses.set(ctx, buffer);
  return buffer;
}

function limitCurve() {
  const curve = new Float32Array(256);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    const abs = Math.abs(x);
    const shaped = abs <= 0.9 ? abs : 0.9 + 0.08 * Math.tanh((abs - 0.9) / 0.1);
    curve[i] = Math.sign(x) * shaped;
  }
  return curve;
}

function softenCurve(amount: number) {
  const drive = 1 + (Math.max(0, Math.min(100, amount)) / 100) * 5;
  const curve = new Float32Array(257);
  const normal = Math.tanh(drive);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / normal;
  }
  return curve;
}

const LIMIT = limitCurve();
const LINEAR = Float32Array.of(-1, 1);

export type FxChain = { input: GainNode; update: (fx: Fx, gain: number) => void };

export function createFxChain(ctx: BaseAudioContext, destination: AudioNode, fx: Fx, gain: number): FxChain {
  const input = ctx.createGain();
  const rumble = ctx.createBiquadFilter();
  rumble.type = "highpass";
  rumble.Q.value = 0.707;
  const rumble2 = ctx.createBiquadFilter();
  rumble2.type = "highpass";
  rumble2.Q.value = 0.707;
  const humA = ctx.createBiquadFilter();
  humA.type = "peaking";
  humA.Q.value = 14;
  const humB = ctx.createBiquadFilter();
  humB.type = "peaking";
  humB.Q.value = 14;
  const humC = ctx.createBiquadFilter();
  humC.type = "peaking";
  humC.Q.value = 14;
  const hiss = ctx.createBiquadFilter();
  hiss.type = "lowpass";
  hiss.Q.value = 0.707;
  const hiss2 = ctx.createBiquadFilter();
  hiss2.type = "lowpass";
  hiss2.Q.value = 0.707;
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  high.Q.value = 0.7;
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  const shaper = ctx.createWaveShaper();
  shaper.curve = limitCurve();
  shaper.oversample = isLightDevice() ? "none" : "2x";
  const volume = ctx.createGain();
  const echoDelay = ctx.createDelay(1.2);
  const echoDelay2 = ctx.createDelay(1.2);
  const echoFilter = ctx.createBiquadFilter();
  echoFilter.type = "lowpass";
  echoFilter.Q.value = 0.7;
  const echoFeedback = ctx.createGain();
  const echoWet = ctx.createGain();
  const echoWet2 = ctx.createGain();
  const reverb = ctx.createConvolver();
  reverb.buffer = roomImpulse(ctx);
  const reverbWet = ctx.createGain();

  input.connect(rumble);
  rumble.connect(rumble2);
  rumble2.connect(humA);
  humA.connect(humB);
  humB.connect(humC);
  humC.connect(hiss);
  hiss.connect(hiss2);
  hiss2.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(comp);
  comp.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(shaper);
  shaper.connect(volume);
  volume.connect(destination);
  volume.connect(echoDelay);
  echoDelay.connect(echoFilter);
  echoFilter.connect(echoFeedback);
  echoFeedback.connect(echoDelay);
  echoDelay.connect(echoWet);
  echoWet.connect(destination);
  echoFilter.connect(echoDelay2);
  echoDelay2.connect(echoWet2);
  echoWet2.connect(destination);
  volume.connect(reverb);
  reverb.connect(reverbWet);
  reverbWet.connect(destination);

  const update = (next: Fx, level: number) => {
    const shaped = isLightDevice() ? { ...next, reverb: Math.min(next.reverb, 60), echo: Math.min(next.echo, 50), soften: Math.min(next.soften, 40) } : next;
    const nyquist = Math.max(4000, ctx.sampleRate / 2 - 400);
    rumble.frequency.value = shaped.rumble ? 100 : 18;
    rumble2.frequency.value = shaped.rumble ? 100 : 18;
    const humHz = shaped.hum === "60" ? 60 : 50;
    humA.frequency.value = humHz;
    humB.frequency.value = humHz * 2;
    const humGain = shaped.hum === "off" ? 0 : -34;
    humA.gain.value = humGain;
    humB.gain.value = shaped.hum === "off" ? 0 : -28;
    humC.frequency.value = humHz * 3;
    humC.gain.value = shaped.hum === "off" ? 0 : -22;
    const hissAt = Math.min(nyquist, shaped.hiss ? 7000 : nyquist);
    hiss.frequency.value = hissAt;
    hiss2.frequency.value = hissAt;
    const speech = shaped.speech;
    low.frequency.value = 150;
    low.gain.value = shaped.low + (speech ? -2 : 0);
    mid.frequency.value = speech ? 2800 : 1000;
    mid.Q.value = speech ? 0.8 : 0.7;
    mid.gain.value = shaped.mid + (speech ? 4 : 0);
    high.frequency.value = 3000;
    high.gain.value = shaped.high + (speech ? 3 : 0);
    const amount = Math.max(0, Math.min(100, shaped.comp)) / 100;
    const ratio = 1 + amount * 7;
    comp.threshold.value = -amount * 30;
    comp.knee.value = 12;
    comp.ratio.value = ratio;
    comp.attack.value = 0.008;
    comp.release.value = 0.18;
    const reduction = amount * 30 * (1 - 1 / ratio);
    makeup.gain.value = 10 ** ((reduction * 0.55) / 20);
    limiter.threshold.value = shaped.limit ? -1.5 : 0;
    limiter.knee.value = shaped.limit ? 0 : 0;
    limiter.ratio.value = shaped.limit ? 20 : 1;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.06;
    shaper.curve = shaped.soften > 0 ? softenCurve(shaped.soften) : shaped.limit ? LIMIT : LINEAR;
    volume.gain.value = level;
    echoDelay.delayTime.value = 0.18;
    echoDelay2.delayTime.value = 0.16;
    echoFilter.frequency.value = 2600;
    echoFeedback.gain.value = Math.min(0.58, (shaped.echo / 100) * 0.5);
    echoWet.gain.value = (shaped.echo / 100) * 0.5;
    echoWet2.gain.value = (shaped.echo / 100) * 0.28;
    reverbWet.gain.value = (shaped.reverb / 100) * 0.7;
  };
  update(fx, gain);
  return { input, update };
}

export async function prepareBuffer(ctx: BaseAudioContext, audio: AudioBuffer, offsetMs: number, durationMs: number, fx: Fx) {
  const sampleRate = audio.sampleRate;
  const speed = Math.min(2, Math.max(0.5, fx.speed / 100));
  const offset = Math.min(audio.length - 1, Math.max(0, Math.floor((offsetMs / 1000) * sampleRate)));
  const slot = Math.max(1, Math.floor((durationMs / 1000) * sampleRate));
  const take = Math.min(audio.length - offset, Math.max(1, Math.floor(slot * (fx.keepPitch ? speed : 1))));
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    channels.push(audio.getChannelData(channel).slice(offset, offset + take));
  }
  if (fx.gate > 0) applyGate(channels, fx.gate);
  if (fx.pitch !== 0) {
    for (let channel = 0; channel < channels.length; channel++) channels[channel] = await pitchShift(channels[channel] ?? new Float32Array(), fx.pitch);
  }
  if (fx.keepPitch && Math.abs(speed - 1) > 0.01) {
    for (let channel = 0; channel < channels.length; channel++) {
      const data = channels[channel] ?? new Float32Array();
      channels[channel] = await timeStretch(data, slot / Math.max(1, data.length));
    }
  }
  const length = Math.max(...channels.map((channel) => channel.length), 1);
  let fitted = channels.map((channel) => (channel.length === length ? channel : Float32Array.from({ length }, (_, i) => channel[i] ?? 0)));
  if (fx.channels === "mono") fitted = toMono(fitted);
  if (fx.normalize) normalizePeak(fitted);
  const buffer = ctx.createBuffer(Math.max(1, fitted.length), length, sampleRate);
  fitted.forEach((channel, index) => {
    buffer.getChannelData(index).set(channel.subarray(0, length));
  });
  return { buffer, rate: fx.keepPitch ? 1 : speed };
}
