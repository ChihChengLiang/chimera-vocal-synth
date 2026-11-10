/**
 * An offline bowed-string cello: a digital waveguide string (McIntyre–Schumacher–Woodhouse: two
 * delay lines either side of the bow, a friction table at the bow, a lossy bridge) through a few
 * body resonances. It renders a melody file to a wav, beside what `chimera render notes` renders.
 *
 *   bun tools/cello.ts <score.json> <out.wav> [--rate 48000]
 *
 * A score is the melody file's shape, `{"bpm", "t0", "notes": [[midi, beats], ...]}` (midi 0 is a
 * rest; notes follow one another), or `{"bpm", "t0", "events": [[startBeat, midi, beats, vel?], ...]}`
 * for notes that overlap (a drone under a tune). `t0` (s) is where beat 0 falls: leave it equal to
 * the voice render's (0.3 by default) and the two line up. Optional: `"vibrato"` (cents, default 18),
 * `"bright"` (0..1 bow pressure, default 0.5), `"gain"`.
 *
 * Not the engine: the engine models voices, and a cello is made here, in the open, to be mixed with
 * them. Each note is normalised to the same loudness (the string is weaker low down), then scaled by
 * its velocity.
 */
import { readFileSync } from "node:fs";
import { writeWav } from "./lib/wav.ts";

const args = process.argv.slice(2);
const rateAt = args.indexOf("--rate");
const FS = rateAt >= 0 ? Number(args[rateAt + 1]) : 48000;
const pos = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--rate");

/** a delay line with linear interpolation; its length may move while it runs (vibrato) */
class Delay {
  private buf: Float64Array;
  private w = 0;
  delay = 1;
  constructor(max: number) {
    this.buf = new Float64Array(Math.ceil(max) + 4);
  }
  out(): number {
    const n = this.buf.length;
    let r = this.w - this.delay;
    while (r < 0) r += n;
    const i = Math.floor(r);
    const f = r - i;
    return this.buf[i % n] * (1 - f) + this.buf[(i + 1) % n] * f;
  }
  push(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) % this.buf.length;
  }
}

/** a biquad (RBJ cookbook) */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private b0: number, private b1: number, private b2: number, private a1: number, private a2: number) {}
  static peak(f: number, q: number, db: number): Biquad {
    const A = 10 ** (db / 40);
    const w = (2 * Math.PI * f) / FS;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al / A;
    return new Biquad((1 + al * A) / a0, (-2 * c) / a0, (1 - al * A) / a0, (-2 * c) / a0, (1 - al / A) / a0);
  }
  static lowpass(f: number, q: number): Biquad {
    const w = (2 * Math.PI * f) / FS;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }
  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** small deterministic noise for the bow's hiss */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2147483648 - 1;
  };
}

/** the delays the loop's filters add, in samples (found by tuning: see `--check` below) */
const LOOP_COMP = 1.05;
/** where the bow sits, as a fraction of the string from the bridge */
const BOW_AT = 0.13;

interface Note {
  t: number;
  dur: number;
  midi: number;
  vel: number;
}

/** one bowed note: attack and release on the bow's speed, vibrato on the string's length */
export function bowNote(n: Note, vibCents: number, pressure: number, seed: number): Float64Array {
  const f0 = 440 * 2 ** ((n.midi - 69) / 12);
  const attack = 0.07 + 0.05 * (1 - n.vel);
  const release = Math.min(0.18, 0.4 * n.dur + 0.05);
  const total = Math.ceil((n.dur + release + 0.25) * FS);
  const base = FS / f0 - LOOP_COMP;
  const neck = new Delay(base + 8);
  const bridge = new Delay(base + 8);
  const noise = rng(seed);
  // the bridge's loss: a one-pole lowpass, so the upper partials die faster than the low ones
  const pole = 0.6 - (0.1 * 22050) / FS;
  let bridgeY = 0;
  const slope = 5.0 - 4.0 * pressure;
  const maxVel = 0.03 + 0.2 * n.vel;
  const out = new Float64Array(total);
  const vibRate = 5.3 + 0.4 * noise();
  const vibStart = Math.min(0.35, n.dur * 0.5);
  let bowV = 0;
  let lev = 0;
  for (let i = 0; i < total; i++) {
    const t = i / FS;
    // the bow's speed: a rise, a hold, a fall
    let env = 1;
    if (t < attack) env = t / attack;
    else if (t > n.dur) env = Math.max(0, 1 - (t - n.dur) / release);
    // a held note swells a little and breathes; the bow speed carries it
    const swell = 1 + 0.08 * Math.sin(2 * Math.PI * 0.6 * t);
    bowV = maxVel * env * (t > n.dur ? 1 : swell);
    // the vibrato comes in after the note has begun
    const vib = vibCents * Math.min(1, Math.max(0, (t - vibStart) / 0.3)) * Math.sin(2 * Math.PI * vibRate * t);
    const k = 2 ** (-vib / 1200);
    neck.delay = base * (1 - BOW_AT) * k;
    bridge.delay = base * BOW_AT * k;
    const bridgeIn = bridge.out();
    bridgeY = (1 - pole) * 0.95 * bridgeIn + pole * bridgeY;
    const bridgeRefl = -bridgeY;
    const nutRefl = -neck.out();
    const stringV = bridgeRefl + nutRefl;
    const dv = bowV - stringV;
    // the bow table: sticking while the hair grips, slipping when the string runs away from it
    let s = Math.abs((dv + 0.001) * slope) + 0.75;
    let mu = s ** -4;
    if (mu > 1) mu = 1;
    const newV = dv * mu;
    neck.push(bridgeRefl + newV);
    bridge.push(nutRefl + newV);
    // what the bridge hands the body: the string's force there, plus a breath of hiss
    lev += 0.002 * (Math.abs(bridgeIn) - lev);
    out[i] = bridgeIn + (process.env.RAW ? 0 : 0.06) * lev * noise() * mu;
  }
  if (process.env.RAW) return out;
  // loudness: every note the same, whatever its pitch
  let e = 0;
  const a = Math.floor(0.25 * FS);
  const b = Math.min(total, Math.floor((n.dur + 0.02) * FS));
  for (let i = a; i < b; i++) e += out[i] * out[i];
  const rms = Math.sqrt(e / Math.max(1, b - a)) || 1;
  const g = (0.12 * (0.35 + 0.65 * n.vel)) / rms;
  for (let i = 0; i < total; i++) out[i] *= g;
  return out;
}

/** a cello's body: its air and wood resonances, and the lid's roll-off */
function body(x: Float64Array): Float64Array {
  const stages = [
    Biquad.peak(98, 6, 5), // the air
    Biquad.peak(190, 8, 4),
    Biquad.peak(275, 8, 3),
    Biquad.peak(410, 6, 3),
    Biquad.peak(540, 7, 2),
    Biquad.peak(1100, 3, 2),
    Biquad.lowpass(4200, 0.7),
    Biquad.lowpass(5200, 0.6),
  ];
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let v = x[i];
    for (const s of stages) v = s.tick(v);
    y[i] = v;
  }
  return y;
}

function loadScore(path: string): { notes: Note[]; vib: number; bright: number; gain: number } {
  const j = JSON.parse(readFileSync(path, "utf8"));
  const beat = 60 / j.bpm;
  const t0 = j.t0 ?? 0.3;
  const notes: Note[] = [];
  if (j.events) {
    for (const [at, midi, beats, vel] of j.events as number[][]) if (midi > 0) notes.push({ t: t0 + at * beat, dur: beats * beat, midi, vel: vel ?? 0.7 });
  } else {
    let t = t0;
    for (const [midi, beats, vel] of j.notes as number[][]) {
      if (midi > 0) notes.push({ t, dur: beats * beat, midi, vel: vel ?? 0.7 });
      t += beats * beat;
    }
  }
  return { notes, vib: j.vibrato ?? 18, bright: j.bright ?? 0.5, gain: j.gain ?? 1 };
}

/** `--check midi`: bow one note and report its pitch against the one asked for, in cents */
function check(midi: number): void {
  const x = bowNote({ t: 0, dur: 1.2, midi, vel: 0.7 }, 0, 0.5, 1);
  const a = Math.floor(0.5 * FS);
  const n = Math.floor(0.5 * FS);
  const seg = x.subarray(a, a + n);
  const f0 = 440 * 2 ** ((midi - 69) / 12);
  let best = 0;
  let bestLag = 0;
  const lo = Math.floor(FS / (f0 * 1.5));
  const hi = Math.ceil(FS / (f0 * 0.7));
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  // parabolic refinement
  const r = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    return s;
  };
  const y0 = r(bestLag - 1);
  const y1 = r(bestLag);
  const y2 = r(bestLag + 1);
  const off = (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2);
  const f = FS / (bestLag + off);
  console.log(`midi ${midi}: asked ${f0.toFixed(2)} Hz, got ${f.toFixed(2)} Hz (${(1200 * Math.log2(f / f0)).toFixed(1)} cents)`);
}

if (import.meta.main) main();

function main(): void {
if (args[0] === "--check") {
  for (const m of args.slice(1).map(Number)) check(m);
  process.exit(0);
}
if (pos.length < 2) {
  console.error("usage: bun tools/cello.ts <score.json> <out.wav> [--rate 48000]");
  process.exit(1);
}
const { notes, vib, bright, gain } = loadScore(pos[0]);
const end = Math.max(...notes.map((n) => n.t + n.dur)) + 1.0;
const mix = new Float64Array(Math.ceil(end * FS));
notes.forEach((n, k) => {
  const x = bowNote(n, vib, bright, k + 1);
  const at = Math.round(n.t * FS);
  for (let i = 0; i < x.length && at + i < mix.length; i++) mix[at + i] += x[i];
});
const wood = body(mix);
let peak = 0;
for (const v of wood) peak = Math.max(peak, Math.abs(v));
const norm = (0.7 * gain) / (peak || 1);
const out = Float32Array.from(wood, (v) => v * norm);
writeWav(pos[1], [out], FS);
console.log(`${pos[1]}: ${(mix.length / FS).toFixed(1)} s, ${notes.length} notes, peak ${(peak * norm).toFixed(2)}`);

}
