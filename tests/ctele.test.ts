/**
 * The duet page's creature recordings (`chimera render creature-notes … --tele`): a file built by
 * hand in the CLI's layout decodes at the right times, and damaged files are refused.
 */
import { describe, expect, test } from "bun:test";
import { CreatureTrack } from "../src/show/ctele.ts";

const HEAD = JSON.stringify({ id: "buffalo", params: ["pitch", "mouth"], source: ["glottis"], tubes: [["oral", 3], ["nasal", 2]] });
const LEN = 3 + 2 + 1 + 2 * 3 + 2 * 2;

/** frame i: gate 1, outRms i/10, clock i·768/48000, pitch 80 + i, mouth i/10, glottis 0.5, oral areas i + [0,1,2] */
function file(frames: number, o: { version?: number; cut?: number } = {}): ArrayBuffer {
  const json = new TextEncoder().encode(HEAD.padEnd(Math.ceil(HEAD.length / 4) * 4, " "));
  const buf = new ArrayBuffer(28 + json.length + 4 * frames * LEN);
  new Uint8Array(buf).set(new TextEncoder().encode("CCTL"));
  const d = new DataView(buf);
  [o.version ?? 1, 48000, 768, frames, LEN, json.length].forEach((x, i) => d.setUint32(4 + 4 * i, x, true));
  new Uint8Array(buf, 28, json.length).set(json);
  const f = new Float32Array(buf, 28 + json.length);
  for (let i = 0; i < frames; i++) {
    const b = i * LEN;
    f.set([1, i / 10, (i * 768) / 48000, 80 + i, i / 10, 0.5], b);
    f.set([i, i + 1, i + 2, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], b + 6);
  }
  return o.cut ? buf.slice(0, buf.byteLength - o.cut) : buf;
}

describe("CreatureTrack", () => {
  test("reads the header and each frame's params, source and tubes", () => {
    const t = new CreatureTrack(file(10));
    expect([t.id, t.sampleRate, t.hop, t.frames]).toEqual(["buffalo", 48000, 768, 10]);
    const f = t.frame(4);
    expect(f.gate).toBe(1);
    expect(f.outRms).toBeCloseTo(0.4, 6);
    expect(f.clock).toBeCloseTo(0.064, 6);
    expect(f.params.pitch).toBe(84);
    expect(f.params.mouth).toBeCloseTo(0.4, 6);
    expect(f.source.glottis).toBe(0.5);
    expect(Array.from(f.tubes.oral.areas)).toEqual([4, 5, 6]);
    expect(f.tubes.oral.rms[0]).toBeCloseTo(0.1, 6);
    expect(Array.from(f.tubes.nasal.areas).map((x) => Math.round(x * 10))).toEqual([4, 5]);
  });

  test("the frame at a time is the last one recorded by then, clamped", () => {
    const t = new CreatureTrack(file(10));
    expect(t.indexAt(-1)).toBe(0);
    expect(t.indexAt(0.0161)).toBe(1);
    expect(t.indexAt(99)).toBe(9);
    expect(t.duration).toBeCloseTo(0.144, 6);
  });

  test("refuses a truncated file, another version or another format", () => {
    expect(() => new CreatureTrack(file(10, { cut: 4 }))).toThrow();
    expect(() => new CreatureTrack(file(10, { version: 2 }))).toThrow(/version 2/);
    expect(() => new CreatureTrack(new ArrayBuffer(10))).toThrow();
    const bad = file(3);
    new Uint8Array(bad)[0] = 88;
    expect(() => new CreatureTrack(bad)).toThrow(/not a CHIMERA/);
  });
});
