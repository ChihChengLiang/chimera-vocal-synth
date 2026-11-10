/** Subtitles on the duet page: which line shows when, bad files are refused, and the capture clock steps without a seek. */
import { describe, expect, test } from "bun:test";
import { parseSubtitles, subtitleAt } from "../src/show/subtitles.ts";
import { ManualClock } from "../src/show/clock.ts";

const subs = parseSubtitles([
  { t0: 0.1, t1: 4.5, han: "踏水", tailo: "ta̍h tsuí" },
  { t0: 4.5, t1: 8.9, han: "好天", tailo: "hó-thinn" },
  { t0: 10, t1: 12, han: "田水", tailo: "" },
]);

describe("subtitles", () => {
  test("the line at a time is the one whose span holds it; spans are half open", () => {
    expect(subtitleAt(subs, 0)).toBeNull();
    expect(subtitleAt(subs, 0.1)?.han).toBe("踏水");
    expect(subtitleAt(subs, 4.499)?.han).toBe("踏水");
    expect(subtitleAt(subs, 4.5)?.han).toBe("好天");
    expect(subtitleAt(subs, 9.5)).toBeNull();
    expect(subtitleAt(subs, 11)?.tailo).toBe("");
    expect(subtitleAt(subs, 99)).toBeNull();
  });
  test("Tâi-lô keeps its tone marks exactly as written", () => {
    expect(subs[0].tailo).toBe("ta̍h tsuí");
    expect(subs[0].tailo.normalize("NFD")).toContain("̍"); // the vertical line above of a checked tone
  });
  test("a file with a backwards, overlapping or non-numeric line is refused", () => {
    expect(() => parseSubtitles({})).toThrow();
    expect(() => parseSubtitles([{ t0: 3, t1: 2, han: "x", tailo: "y" }])).toThrow(/t0 < t1/);
    expect(() => parseSubtitles([{ t0: 0, t1: 5, han: "", tailo: "" }, { t0: 4, t1: 6, han: "", tailo: "" }])).toThrow(/starts before/);
    expect(() => parseSubtitles([{ t0: "a", t1: 2 }])).toThrow();
  });
});

describe("ManualClock", () => {
  test("stepping forward by a frame is not a seek; going back or far ahead is", () => {
    const c = new ManualClock();
    c.setDuration(97.7);
    c.set(0.033);
    c.set(0.066);
    expect(c.epoch).toBe(0);
    c.set(50);
    expect(c.epoch).toBe(1);
    c.set(10);
    expect(c.epoch).toBe(2);
    expect(c.state).toEqual({ playing: true, time: 10, duration: 97.7, epoch: 2 });
    let n = 0;
    const off = c.subscribe(() => n++);
    c.set(10.03);
    off();
    c.set(10.06);
    expect(n).toBe(1);
  });
});
