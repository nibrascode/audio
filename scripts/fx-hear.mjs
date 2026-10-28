import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/", { waitUntil: "domcontentloaded" });
const heard = await page.evaluate(async () => {
  const { createFxChain, defaultFx } = await import("/src/lib/fx.ts");
  const rate = 16000;
  const render = async (fill, fx) => {
    const offline = new OfflineAudioContext(1, rate, rate);
    const chain = createFxChain(offline, offline.destination, fx, 1);
    const buffer = offline.createBuffer(1, rate, rate);
    fill(buffer.getChannelData(0), rate);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(chain.input);
    source.start();
    const out = await offline.startRendering();
    return out.getChannelData(0);
  };
  const rms = (data, from, to) => {
    let energy = 0;
    for (let i = from; i < to; i++) energy += data[i] ** 2;
    return Math.sqrt(energy / Math.max(1, to - from));
  };
  const peak = (data, from, to) => {
    let max = 0;
    for (let i = from; i < to; i++) max = Math.max(max, Math.abs(data[i]));
    return max;
  };
  const tone = (hz, sampleRate, i) => Math.sin((2 * Math.PI * hz * i) / sampleRate);
  const goertzel = (data, freq) => {
    const k = Math.round((freq * data.length) / rate);
    const coeff = 2 * Math.cos((2 * Math.PI * k) / data.length);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < data.length; i++) {
      const s0 = data[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
  };
  const plain = defaultFx();
  plain.comp = 0;
  plain.echo = 0;
  plain.reverb = 0;
  plain.limit = true;
  const squeezed = { ...plain, comp: 85 };
  const fillLevel = (data, sampleRate) => {
    for (let i = 0; i < data.length; i++) data[i] = tone(440, sampleRate, i) * (i < sampleRate / 2 ? 0.08 : 0.9);
  };
  const dry = await render(fillLevel, plain);
  const wet = await render(fillLevel, squeezed);
  const dryQuiet = rms(dry, Math.floor(rate * 0.2), Math.floor(rate * 0.45));
  const dryLoud = rms(dry, Math.floor(rate * 0.7), Math.floor(rate * 0.95));
  const wetQuiet = rms(wet, Math.floor(rate * 0.2), Math.floor(rate * 0.45));
  const wetLoud = rms(wet, Math.floor(rate * 0.7), Math.floor(rate * 0.95));
  const echoed = await render((data, sampleRate) => {
    for (let i = 0; i < sampleRate * 0.02; i++) data[i] = tone(1000, sampleRate, i);
  }, { ...plain, echo: 100, limit: false });
  const scan = [];
  for (let t = 0; t < 0.96; t += 0.04) scan.push(Number(rms(echoed, Math.floor(rate * t), Math.floor(rate * (t + 0.04))).toFixed(4)));
  const open = defaultFx();
  open.echo = 0;
  open.reverb = 0;
  open.comp = 0;
  open.limit = false;
  open.hum = "off";
  const notched = { ...open, hum: "50" };
  const fillHum = (data, sampleRate) => {
    for (let i = 0; i < data.length; i++) data[i] = tone(50, sampleRate, i) * 0.45 + tone(1000, sampleRate, i) * 0.2;
  };
  const humDry = await render(fillHum, open);
  const humWet = await render(fillHum, notched);
  return {
    dryRatio: dryLoud / dryQuiet,
    wetRatio: wetLoud / wetQuiet,
    wetQuiet,
    wetPeak: peak(wet, 0, wet.length),
    scan,
    humBefore: goertzel(humDry, 50),
    humAfter: goertzel(humWet, 50),
    voiceBefore: goertzel(humDry, 1000),
    voiceAfter: goertzel(humWet, 1000),
  };
});
await browser.close();
console.log(JSON.stringify(heard));
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
const first = Math.max(...heard.scan.slice(3, 7));
const second = Math.max(...heard.scan.slice(7, 12));
assert(heard.wetRatio < heard.dryRatio * 0.75, `comp ratio ${heard.wetRatio} vs ${heard.dryRatio}`);
assert(heard.wetQuiet > 0.03, `comp quiet ${heard.wetQuiet}`);
assert(heard.wetPeak <= 1.01, `comp peak ${heard.wetPeak}`);
assert(first > 0.02, `echo one ${first} ${heard.scan.join(" ")}`);
assert(second > 0.008 && second < first, `echo two ${second} vs ${first}`);
assert(heard.humAfter < heard.humBefore * 0.45, `hum ${heard.humAfter} vs ${heard.humBefore}`);
assert(heard.voiceAfter > heard.voiceBefore * 0.7, `voice ${heard.voiceAfter} vs ${heard.voiceBefore}`);
console.log("fx hear ok", { first, second, wetRatio: heard.wetRatio, dryRatio: heard.dryRatio, hum: heard.humAfter / heard.humBefore });
