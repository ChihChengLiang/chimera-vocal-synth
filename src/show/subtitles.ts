/**
 * Subtitles for a show: lines of text over time, in `show.json`'s `"subtitles": "subtitles.json"`,
 * an array of `{"t0", "t1", "han", "tailo"}` in seconds on the mix's clock. `han` is the line in
 * Han characters, `tailo` the same line in Tâi-lô; either may be empty.
 */
export interface Subtitle {
  t0: number;
  t1: number;
  han: string;
  tailo: string;
}

/** the line showing at time t (the first whose [t0, t1) holds it), or null */
export function subtitleAt(subs: readonly Subtitle[], t: number): Subtitle | null {
  for (const s of subs) if (t >= s.t0 && t < s.t1) return s;
  return null;
}

/** a subtitles file, checked: every line has finite times with t0 < t1, and lines are in order and don't overlap */
export function parseSubtitles(json: unknown): Subtitle[] {
  if (!Array.isArray(json)) throw new Error("subtitles must be an array of lines");
  const out: Subtitle[] = json.map((x, i) => {
    const s = x as Partial<Subtitle>;
    if (!Number.isFinite(s.t0) || !Number.isFinite(s.t1) || (s.t0 as number) >= (s.t1 as number)) throw new Error(`subtitle ${i} needs t0 < t1`);
    return { t0: s.t0 as number, t1: s.t1 as number, han: String(s.han ?? ""), tailo: String(s.tailo ?? "") };
  });
  for (let i = 1; i < out.length; i++) if (out[i].t0 < out[i - 1].t1) throw new Error(`subtitle ${i} starts before subtitle ${i - 1} ends`);
  return out;
}
