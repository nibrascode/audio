import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.waitForTimeout(400);
const heard = await page.evaluate(async () => {
  const { createFxChain, defaultFx } = await import("/src/lib/fx.ts");
  const render = async (rate, seconds, fill, fx) => {
    const length = Math.round(rate * seconds);
    const offline = new OfflineAudioContext(1, length, rate);
    const chain = createFxChain(offline, offline.destination, fx, 1);
    const buffer = offline.createBuffer(1, length, rate);
    fill(buffer.getChannelData(0), rate);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(chain.input);
    source.start();
    const out = await offline.startRendering();
    return out.getChannelData(0);
  };
  const tone = (hz, rate, i, amp) => Math.sin((2 * Math.PI * hz * i) / rate) * amp;
  const goertzel = (data, freq, rate) => {
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
  const base = defaultFx();
  base.comp = 0;
  base.echo = 0;
  base.reverb = 0;
  base.limit = false;
  base.hum = "off";
  const mix = (data, rate) => {
    for (let i = 0; i < data.length; i++) data[i] = tone(100, rate, i, 0.25) + tone(2000, rate, i, 0.25);
  };
  const dry = await render(16000, 1, mix, base);
  const low = await render(16000, 1, mix, { ...base, low: 12 });
  const air = (data, rate) => {
    for (let i = 0; i < data.length; i++) data[i] = tone(400, rate, i, 0.2) + tone(5000, rate, i, 0.2);
  };
  const airDry = await render(16000, 1, air, base);
  const airWet = await render(16000, 1, air, { ...base, high: 12 });
  const rumbleMix = (data, rate) => {
    for (let i = 0; i < data.length; i++) data[i] = tone(40, rate, i, 0.4) + tone(300, rate, i, 0.25);
  };
  const rumbleDry = await render(16000, 1, rumbleMix, base);
  const rumbleWet = await render(16000, 1, rumbleMix, { ...base, rumble: true });
  const hissMix = (data, rate) => {
    for (let i = 0; i < data.length; i++) data[i] = tone(1000, rate, i, 0.2) + tone(10000, rate, i, 0.3);
  };
  const hissDry = await render(48000, 1, hissMix, base);
  const hissWet = await render(48000, 1, hissMix, { ...base, hiss: true });
  return {
    low100: goertzel(low, 100, 16000) / goertzel(dry, 100, 16000),
    low2000: goertzel(low, 2000, 16000) / goertzel(dry, 2000, 16000),
    high5000: goertzel(airWet, 5000, 16000) / goertzel(airDry, 5000, 16000),
    high400: goertzel(airWet, 400, 16000) / goertzel(airDry, 400, 16000),
    rumble40: goertzel(rumbleWet, 40, 16000) / goertzel(rumbleDry, 40, 16000),
    rumble300: goertzel(rumbleWet, 300, 16000) / goertzel(rumbleDry, 300, 16000),
    hiss10k: goertzel(hissWet, 10000, 48000) / goertzel(hissDry, 10000, 48000),
    hiss1k: goertzel(hissWet, 1000, 48000) / goertzel(hissDry, 1000, 48000),
  };
});
await browser.close();
function assert(ok, message) {
  if (!ok) throw new Error(`${message} ${JSON.stringify(heard)}`);
}
assert(heard.low100 > heard.low2000 * 1.6, "low shelf");
assert(heard.low100 > 1.4, "low boost");
assert(heard.high5000 > heard.high400 * 1.4 && heard.high5000 > 1.4, "high shelf");
assert(heard.rumble40 < 0.35, "rumble");
assert(heard.rumble300 > 0.7, "rumble voice");
assert(heard.hiss10k < 0.45, "hiss");
assert(heard.hiss1k > 0.75, "hiss voice");
console.log("tone hear ok", heard);
