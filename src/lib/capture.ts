import { wavFromPcm } from "@/lib/wav";
import { holdScreen, notifyRecording, releaseScreen } from "@/lib/android";
import { flushAfterFrames, mergeInt16, pushCapture, pushCaptureBlob } from "@/lib/checkpoint";

export type RecordFormat = "wav" | "m4a";
export type MicLoss = "muted" | "ended" | "suspended";

const M4A_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/aac"];

export function m4aMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of M4A_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

type Events = {
  onMicLost: (kind: MicLoss) => void;
  onMicBack: () => void;
  onControl: (action: "pause" | "play" | "stop") => void;
};

export type CaptureSession = {
  format: RecordFormat;
  mimeType: string;
  sampleRate: number;
  analyser: AnalyserNode;
  pause: () => void;
  resume: () => Promise<"ok" | "denied" | "missing" | "busy">;
  stop: () => Promise<Blob>;
  release: () => void;
};

function audioContext(): AudioContext {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("no-audio");
  return new Ctx();
}

export async function startCapture(stream: MediaStream, format: RecordFormat, events: Events): Promise<CaptureSession> {
  const mime = format === "m4a" ? m4aMime() : "audio/wav";
  if (format === "m4a" && !mime) throw new Error("no-m4a");

  const ctx = audioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.78;
  source.connect(analyser);

  let armed = true;
  let stopped = false;
  let currentStream = stream;
  let currentSource = source;
  let wake: WakeLockSentinel | null = null;
  const pcmChunks: Int16Array[] = [];
  let recorder: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  let checkpointParts: Int16Array[] = [];
  let checkpointFrames = 0;
  let processor: AudioNode | null = null;
  let keeper: OscillatorNode | null = null;

  const pushPcm = (input: Float32Array) => {
    if (!armed || stopped || !input.length) return;
    const copy = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
      copy[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    pcmChunks.push(copy);
    checkpointParts.push(copy);
    checkpointFrames += copy.length;
    if (checkpointFrames >= flushAfterFrames(ctx.sampleRate)) {
      void pushCapture(ctx.sampleRate, mergeInt16(checkpointParts));
      checkpointParts = [];
      checkpointFrames = 0;
    }
  };

  if (format === "wav") {
    const silent = ctx.createGain();
    silent.gain.value = 0;
    let attached = false;
    if (ctx.audioWorklet) {
      const sourceText =
        'class NibrasPcm extends AudioWorkletProcessor{constructor(){super();this.hold=new Float32Array(2048);this.at=0;this.port.onmessage=()=>this.flush()}flush(){if(!this.at)return;const copy=this.hold.slice(0,this.at);this.port.postMessage(copy,[copy.buffer]);this.at=0}process(inputs){const ch=inputs[0]&&inputs[0][0];if(ch){for(let i=0;i<ch.length;i++){this.hold[this.at++]=ch[i];if(this.at>=this.hold.length)this.flush()}}return true}}registerProcessor("nibras-pcm",NibrasPcm);';
      const url = URL.createObjectURL(new Blob([sourceText], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(ctx, "nibras-pcm");
        node.port.onmessage = (event: MessageEvent<Float32Array>) => pushPcm(event.data);
        processor = node;
        currentSource.connect(node);
        node.connect(silent);
        silent.connect(ctx.destination);
        attached = true;
      } catch {
        attached = false;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (!attached) {
      const node = ctx.createScriptProcessor(4096, 1, 1);
      processor = node;
      node.onaudioprocess = (event) => pushPcm(event.inputBuffer.getChannelData(0));
      currentSource.connect(node);
      node.connect(silent);
      silent.connect(ctx.destination);
    }
  } else {
    recorder = new MediaRecorder(currentStream, { mimeType: mime });
    recorder.ondataavailable = (event) => {
      if (event.data.size) {
        chunks.push(event.data);
        void pushCaptureBlob(event.data);
      }
    };
    recorder.start(250);
  }

  const tone = ctx.createOscillator();
  const toneGain = ctx.createGain();
  toneGain.gain.value = 0.0002;
  tone.frequency.value = 20;
  tone.connect(toneGain);
  toneGain.connect(ctx.destination);
  tone.start();
  keeper = tone;

  const setSession = (state: "playing" | "paused" | "none") => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = state;
  };

  const holdWake = async () => {
    wake = await holdScreen();
  };
  void holdWake();
  notifyRecording(true);

  const keepAlive = async () => {
    try {
      if (ctx.state !== "running") await ctx.resume();
    } catch {
      /* the browser may refuse while hidden */
    }
    void holdWake();
  };

  const onVisible = () => {
    if (stopped) return;
    void keepAlive();
    if (document.visibilityState === "visible") events.onMicBack();
  };
  document.addEventListener("visibilitychange", onVisible);
  const flushCheckpoint = () => {
    if (checkpointFrames <= 0) return;
    void pushCapture(ctx.sampleRate, mergeInt16(checkpointParts));
    checkpointParts = [];
    checkpointFrames = 0;
  };
  const onHide = () => {
    if (stopped) return;
    flushCheckpoint();
    void keepAlive();
  };
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onHide);
  window.addEventListener("focus", onHide);
  const beat = window.setInterval(() => {
    if (!stopped) void keepAlive();
  }, 2000);

  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Nibras Audio", artist: "Nibras" });
    } catch {
      /* metadata is optional */
    }
    setSession("playing");
  }

  const wire = (next: MediaStream) => {
    const track = next.getAudioTracks()[0];
    if (!track) return;
    track.onmute = () => {
      if (stopped || !armed) return;
      events.onMicLost("muted");
    };
    track.onunmute = () => {
      if (stopped) return;
      events.onMicBack();
    };
    track.onended = () => {
      if (stopped) return;
      events.onMicLost("ended");
    };
  };
  wire(currentStream);

  ctx.onstatechange = () => {
    const state = ctx.state as AudioContextState | "interrupted";
    if (stopped || !armed) return;
    if (state === "suspended" || state === "interrupted") {
      void keepAlive().then(() => {
        if (stopped || !armed) return;
        if (ctx.state === "running") return;
        events.onMicLost("suspended");
      });
    }
  };

  const connectStream = (next: MediaStream) => {
    currentSource.disconnect();
    currentSource = ctx.createMediaStreamSource(next);
    currentSource.connect(analyser);
    if (processor) currentSource.connect(processor);
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = next;
    wire(next);
  };

  let released = false;
  const session: CaptureSession = {
    format,
    mimeType: format === "wav" ? "audio/wav" : mime,
    sampleRate: ctx.sampleRate,
    analyser,
    pause() {
      armed = false;
      if (recorder && recorder.state === "recording") {
        try {
          recorder.pause();
        } catch {
          /* pause unsupported */
        }
      }
      setSession("paused");
    },
    async resume() {
      const track = currentStream.getAudioTracks()[0];
      if (!track || track.readyState === "ended") {
        if (format !== "wav") return "busy";
        try {
          const fresh = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            video: false,
          });
          connectStream(fresh);
        } catch (err) {
          const name = err instanceof DOMException ? err.name : "";
          if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
          if (name === "NotAllowedError" || name === "SecurityError") return "denied";
          return "busy";
        }
      }
      try {
        if (ctx.state !== "running") await ctx.resume();
      } catch {
        return "busy";
      }
      if (recorder && recorder.state === "paused") {
        try {
          recorder.resume();
        } catch {
          return "busy";
        }
      }
      armed = true;
      setSession("playing");
      void holdWake();
      return "ok";
    },
    stop() {
      if (stopped) return Promise.resolve(new Blob([], { type: session.mimeType }));
      return (async () => {
        if (processor instanceof AudioWorkletNode) {
          processor.port.postMessage("flush");
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        stopped = true;
        armed = false;
      currentStream.getAudioTracks().forEach((track) => {
        track.onmute = null;
        track.onunmute = null;
        track.onended = null;
      });
      if (recorder) {
        return new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve(new Blob(chunks, { type: recorder?.mimeType || mime }));
          };
          recorder.onstop = done;
          try {
            if (recorder.state !== "inactive") recorder.stop();
            else done();
          } catch {
            done();
          }
          window.setTimeout(done, 1500);
        });
      }
      let total = 0;
      for (const chunk of pcmChunks) total += chunk.length;
      if (checkpointFrames > 0) {
        void pushCapture(ctx.sampleRate, mergeInt16(checkpointParts));
        checkpointParts = [];
        checkpointFrames = 0;
      }
      const pcm = new Int16Array(total);
      let offset = 0;
      for (const chunk of pcmChunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      return wavFromPcm(pcm, ctx.sampleRate);
      })();
    },
    release() {
      if (released) return;
      released = true;
      stopped = true;
      armed = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onHide);
      window.removeEventListener("focus", onHide);
      window.clearInterval(beat);
      try {
        keeper?.stop();
      } catch {
        /* already stopped */
      }
      processor?.disconnect();
      currentSource.disconnect();
      currentStream.getTracks().forEach((track) => track.stop());
      releaseScreen(wake);
      wake = null;
      notifyRecording(false);
      void ctx.close();
      setSession("none");
      if ("mediaSession" in navigator) {
        try {
          navigator.mediaSession.setActionHandler("pause", null);
          navigator.mediaSession.setActionHandler("play", null);
          navigator.mediaSession.setActionHandler("stop", null);
        } catch {
          /* ignore */
        }
      }
    },
  };

  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.setActionHandler("pause", () => {
        if (!stopped) events.onControl("pause");
      });
      navigator.mediaSession.setActionHandler("play", () => {
        if (!stopped) events.onControl("play");
      });
      navigator.mediaSession.setActionHandler("stop", () => {
        if (!stopped) events.onControl("stop");
      });
    } catch {
      /* some handlers are unsupported */
    }
  }

  return session;
}
