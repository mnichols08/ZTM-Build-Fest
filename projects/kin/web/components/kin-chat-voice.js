// Voice messages in the chat (#134): the player shown in a message and the
// recorder panel in the composer. Both are plain DOM built with textContent;
// no transcription, no uploads outside the chat's own sealed attachment path.
import { VoiceError, VoiceRecorder, formatDuration, voiceLabel, voicePeaks, voiceSupport } from "../chat/chat-voice.js";

const SPEEDS = [1, 1.5, 2];

const button = (className, text, label) => {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  if (label) element.setAttribute("aria-label", label);
  return element;
};

/**
 * One voice message: play/pause, a waveform you can drag along, the time and
 * a speed button. `load()` resolves the decrypted recording the first time
 * it is played; its object URL is released by `dispose()`.
 */
export function voicePlayer({ author, voice, load, Audio = globalThis.Audio, createUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url) }) {
  const root = document.createElement("div");
  root.className = "chat-voice";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", voiceLabel(author, voice.durationMs));
  const play = button("chat-voice-play", "Play", `Play voice message from ${author}`);
  const wave = document.createElement("div");
  wave.className = "chat-voice-wave";
  wave.setAttribute("aria-hidden", "true");
  const bars = voice.peaks.map((peak) => {
    const bar = document.createElement("span");
    bar.style.height = `${Math.max(8, Math.round((peak / 255) * 100))}%`;
    wave.append(bar);
    return bar;
  });
  const seek = document.createElement("input");
  seek.type = "range";
  seek.className = "chat-voice-seek";
  seek.min = "0";
  seek.max = String(voice.durationMs);
  seek.step = "100";
  seek.value = "0";
  seek.setAttribute("aria-label", `Position in voice message from ${author}`);
  seek.setAttribute("aria-valuetext", `0:00 of ${formatDuration(voice.durationMs)}`);
  const time = document.createElement("span");
  time.className = "chat-voice-time";
  time.textContent = formatDuration(voice.durationMs);
  const speed = button("chat-voice-speed", "1×", "Playback speed 1×");
  const problem = document.createElement("span");
  problem.className = "chat-voice-problem";
  problem.setAttribute("role", "status");
  const track = document.createElement("div");
  track.className = "chat-voice-track";
  track.append(wave, seek);
  root.append(play, track, time, speed, problem);

  let audio = null;
  let url = null;
  let rate = 1;
  let loading = null;

  const paint = (ms) => {
    const played = Math.round((ms / voice.durationMs) * bars.length);
    bars.forEach((bar, index) => bar.classList.toggle("played", index < played));
    seek.value = String(Math.round(ms));
    seek.setAttribute("aria-valuetext", `${formatDuration(ms)} of ${formatDuration(voice.durationMs)}`);
    time.textContent = formatDuration(audio && !audio.paused ? ms : ms || voice.durationMs);
  };
  const setPlaying = (playing) => {
    play.textContent = playing ? "Pause" : "Play";
    play.setAttribute("aria-label", `${playing ? "Pause" : "Play"} voice message from ${author}`);
  };
  const ensure = () => {
    if (audio) return Promise.resolve(audio);
    loading ??= (async () => {
      const blob = await load();
      url = createUrl(blob);
      audio = new Audio(url);
      audio.preload = "auto";
      audio.playbackRate = rate;
      audio.addEventListener("timeupdate", () => paint(Math.min(audio.currentTime * 1000, voice.durationMs)));
      audio.addEventListener("ended", () => { setPlaying(false); paint(0); });
      audio.addEventListener("pause", () => setPlaying(false));
      audio.addEventListener("play", () => setPlaying(true));
      return audio;
    })().finally(() => { loading = null; });
    return loading;
  };

  play.addEventListener("click", async () => {
    problem.textContent = "";
    try {
      const element = await ensure();
      if (element.paused) await element.play();
      else element.pause();
    } catch {
      problem.textContent = "Couldn't play this voice message.";
    }
  });
  seek.addEventListener("input", async () => {
    const ms = Number(seek.value);
    paint(ms);
    try { (await ensure()).currentTime = ms / 1000; } catch { problem.textContent = "Couldn't play this voice message."; }
  });
  speed.addEventListener("click", () => {
    rate = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
    speed.textContent = `${rate}×`;
    speed.setAttribute("aria-label", `Playback speed ${rate}×`);
    if (audio) audio.playbackRate = rate;
  });

  root.dispose = () => {
    audio?.pause();
    audio = null;
    if (url) revokeUrl(url);
    url = null;
  };
  return root;
}

/**
 * The recorder in the composer. `host` is the element it fills; `send`
 * receives `{ blob, durationMs }` and sends it (the caller adds peaks).
 * States: closed → starting → recording → review → closed. The microphone is
 * released when recording stops, and a recording stopped by the page
 * hiding or locking is kept for review, not sent.
 */
export class VoiceComposer {
  constructor({ host, say = () => {}, send, support = voiceSupport, recorderOptions = {}, createUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url), onChange = () => {} }) {
    Object.assign(this, { host, say, sendRecording: send, support, createUrl, revokeUrl, onChange });
    this.recorderOptions = recorderOptions;
    this.recorder = null;
    this.result = null;
    this.url = null;
    this.busy = false;
    host.hidden = true;
  }

  get open() { return !this.host.hidden; }

  /** Starts a recording (asks for the microphone when this is the first). */
  async begin() {
    if (this.open) return;
    const support = this.support();
    if (!support.ok) { this.show("problem", support.reason); return; }
    this.show("starting");
    this.recorder = new VoiceRecorder({
      ...this.recorderOptions,
      onTick: (ms) => { if (this.clock) this.clock.textContent = formatDuration(ms); },
      // At the limit the recording ends on its own and goes to review.
      onLimit: () => { this.say("Five minutes reached. Recording stopped."); void this.stop(); },
    });
    try {
      await this.recorder.start();
    } catch (error) {
      if (error?.code === "voice_cancelled") return;
      this.recorder = null;
      this.show("problem", error instanceof VoiceError ? error.message : "Kin couldn't start recording.");
      return;
    }
    this.show("recording");
    this.say("Recording");
  }

  async stop() {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== "recording" && recorder.state !== "stopping") return;
    try {
      this.result = await recorder.stop();
    } catch (error) {
      if (error?.code === "voice_cancelled") return;
      this.recorder = null;
      this.show("problem", error instanceof VoiceError ? error.message : "Recording failed.");
      return;
    }
    this.recorder = null;
    this.url = this.createUrl(this.result.blob);
    this.show("review");
    this.say(`Recorded ${formatDuration(this.result.durationMs)}. Review it, then send or discard.`);
  }

  /** The page hid or the chat locked: stop and keep what was said. */
  interrupt() {
    if (this.recorder?.state === "recording") void this.stop();
  }

  discard() {
    this.recorder?.cancel();
    this.recorder = null;
    this.clear();
    this.show(null);
    this.onChange();
  }

  /** Closes everything, e.g. when the element leaves the page. */
  dispose() {
    this.recorder?.cancel();
    this.recorder = null;
    this.clear();
    this.host.replaceChildren();
    this.host.hidden = true;
  }

  clear() {
    this.result = null;
    if (this.url) this.revokeUrl(this.url);
    this.url = null;
  }

  async send() {
    if (!this.result || this.busy) return;
    this.busy = true;
    this.show("sending");
    try {
      await this.sendRecording(this.result);
      this.clear();
      this.show(null);
    } catch (error) {
      this.busy = false;
      this.show("review", error?.message && error.code === "chat_attachment_invalid" ? error.message : "Kin couldn't send that. Your recording is still here.");
      return;
    }
    this.busy = false;
    this.onChange();
  }

  show(state, text = "") {
    this.state = state;
    const host = this.host;
    host.replaceChildren();
    host.hidden = state === null;
    if (state === null) { this.clock = null; this.onChange(); return; }
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", "Voice message");
    const status = document.createElement("p");
    status.className = "chat-voice-status";
    if (state === "starting") status.textContent = "Starting the microphone…";
    else if (state === "sending") status.textContent = "Sending voice message…";
    else if (state === "problem") status.textContent = text;
    else if (state === "recording") status.textContent = "Recording ";
    else if (state === "review") status.textContent = text || "Voice message ready";
    if (state === "problem") status.setAttribute("role", "alert");
    host.append(status);
    this.clock = null;
    if (state === "recording") {
      this.clock = document.createElement("span");
      this.clock.className = "chat-voice-clock";
      this.clock.textContent = "0:00";
      status.append(this.clock);
      const stop = button("chat-voice-stop", "Stop", "Stop recording");
      stop.addEventListener("click", () => void this.stop());
      const discard = button("chat-voice-discard", "Discard", "Discard recording");
      discard.addEventListener("click", () => this.discard());
      host.append(stop, discard);
      stop.focus();
    } else if (state === "review") {
      const player = document.createElement("audio");
      player.controls = true;
      player.src = this.url;
      player.setAttribute("aria-label", `Your recording, ${formatDuration(this.result.durationMs)}`);
      const send = button("chat-voice-send", "Send voice message", "Send voice message");
      send.addEventListener("click", () => void this.send());
      const discard = button("chat-voice-discard", "Discard", "Discard recording");
      discard.addEventListener("click", () => this.discard());
      host.append(player, send, discard);
      send.focus();
    } else if (state === "problem") {
      const close = button("chat-voice-discard", "Close", "Close voice message");
      close.addEventListener("click", () => this.discard());
      host.append(close);
      close.focus();
    }
    this.onChange();
  }
}

export { voicePeaks };
