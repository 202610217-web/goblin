// 효과음: 파일 없이 WebAudio로 즉석 합성 (짧은 잡음·톤 조합). iOS는 첫 터치 뒤에만 소리가 나서 그때 깨운다.
type Sfx = "swing" | "shot" | "hit" | "hurt" | "kill" | "streak" | "pickup" | "ult" | "ready";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function wake() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
}
for (const ev of ["pointerdown", "keydown", "touchend"]) addEventListener(ev, wake, { capture: true, passive: true });

/** 톤 하나: f0 → f1 으로 미끄러지며 dur 초 동안 */
function tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, at = 0) {
  const c = ctx!, t = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** 잡음 한 번 (바람 소리·타격음): 대역 필터 주파수 f, dur 초 */
function noise(f: number, dur: number, vol: number, at = 0, q = 1) {
  const c = ctx!, t = c.currentTime + at;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
  s.buffer = buf;
  bp.type = "bandpass";
  bp.frequency.value = f;
  bp.Q.value = q;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(bp).connect(g).connect(master!);
  s.start(t);
}

export function play(kind: Sfx) {
  if (!ctx || ctx.state !== "running") return;
  switch (kind) {
    case "swing": noise(1800, 0.14, 0.35, 0, 0.8); break;
    case "shot": tone("triangle", 520, 180, 0.12, 0.25); noise(3000, 0.06, 0.15); break;
    case "hit": noise(400, 0.1, 0.6, 0, 1.5); tone("square", 160, 60, 0.08, 0.2); break;
    case "hurt": tone("sawtooth", 220, 90, 0.18, 0.18); break;
    case "kill": [660, 880, 1320].forEach((f, i) => tone("triangle", f, f, 0.16, 0.22, i * 0.06)); break;
    case "streak": [523, 659, 784, 1047].forEach((f, i) => tone("square", f, f, 0.18, 0.12, i * 0.08)); break;
    case "pickup": [988, 1319, 1976].forEach((f, i) => tone("sine", f, f * 1.02, 0.14, 0.25, i * 0.05)); break;
    case "ult": tone("sawtooth", 120, 40, 0.6, 0.3); noise(200, 0.5, 0.6, 0, 0.7); break;
    case "ready": tone("sine", 740, 1480, 0.25, 0.2); break;
  }
}
