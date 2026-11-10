/**
 * The duet page (`?show=<id>`): a pre-rendered song with two (or more) voices, each on its own 3D
 * head, side by side, moving exactly as the engine did when it sang. Nothing is synthesized here:
 * the page plays the mixed track and replays each voice's recorded telemetry at the playhead.
 *
 * A show is a folder `public/shows/<id>/` (gitignored: shows are made locally, often of songs that
 * mustn't be published) holding `show.json`, the mix and one `.tele` per voice from
 * `chimera render notes … --tele`. The voices' renders and the mix must share sample 0.
 *
 *   { "title": "…", "audio": "mix.mp3", "bpm": 103, "downbeat": 0,
 *     "voices": [{ "name": "Lower", "tele": "male.tele" }, { "name": "Upper", "tele": "female.tele" }] }
 *
 * Optional: `bpm` and `downbeat` (s, a bar's first beat) nod the heads on the beat; a voice's
 * `melody` (the melody file it was rendered from) writes its words at its mouth, and the show's
 * `spell` ({"owr": "our"}) writes a syllable spelled for the dictionary as it should read.
 */
import { useEffect, useRef, useState } from "react";
import { AnatomyView3D, type HeadFeed } from "./AnatomyView3D.tsx";
import { Screen } from "./Screen.tsx";
import { TeleTrack } from "../../show/tele.ts";
import { CreatureTrack } from "../../show/ctele.ts";
import { CreatureHead3D } from "./CreatureHead3D.tsx";
import { Transport } from "../../show/transport.ts";
import { ManualClock, type Clock } from "../../show/clock.ts";
import { parseSubtitles, subtitleAt, type Subtitle } from "../../show/subtitles.ts";
import { getModel } from "../useModel.ts";
import { VoiceModel } from "../analysis.ts";
import { bodyLabel } from "../body.ts";
import type { ViewFlags } from "../render/anatomy.ts";
import { mouthWords } from "../mouthWords.ts";
import { V } from "../colors.ts";
import { g2p } from "../speech.ts";
import { creatureById, lyricsToSyllables } from "../../wasm/engine.ts";
import { sungWords, wordAt, type Melody, type SungWords } from "../../show/words.ts";
import type { OverlayFn } from "./AnatomyView.tsx";

interface ShowFile {
  title: string;
  audio: string;
  bpm?: number;
  downbeat?: number;
  spell?: Record<string, string>;
  /** a file of timed lines (`src/show/subtitles.ts`), shown under the heads */
  subtitles?: string;
  /** a font file for the subtitles' Han line (the page's own fonts have no Han glyphs; a system font stands in without it) */
  subtitleFont?: string;
  voices: { name: string; tele: string; melody?: string }[];
}

/** a voice: a human head from a `.tele`, or a creature's from a `.ctele` (told apart by the file's first bytes) */
type LoadedVoice = { name: string; kind: "human"; track: TeleTrack; words: SungWords | null } | { name: string; kind: "creature"; track: CreatureTrack };

interface Loaded {
  show: ShowFile;
  voices: LoadedVoice[];
  subs: Subtitle[];
}

/** `?capture`: no audio and no controls, a clock the recorder sets (`window.__duet.set(t)`), for tools/record-duet.ts */
const CAPTURE = typeof location !== "undefined" && new URLSearchParams(location.search).has("capture");

const isCreatureFile = (b: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(b, 0, 4)) === "CCTL";

/** the heads as the face screen shows them by default, less the measurement labels */
const VIEW: ViewFlags = { pressure: true, particles: true, grid: false, calipers: false };

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r;
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export function DuetPage(props: { id: string }) {
  const base = `${import.meta.env.BASE_URL}shows/${props.id}/`;
  // one transport per mount (its context closes on unmount)
  const [transport, setTransport] = useState<Clock | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const t: Clock = CAPTURE ? new ManualClock() : new Transport();
    setTransport(t);
    return () => t.dispose();
  }, []);

  useEffect(() => {
    if (!transport) return;
    let live = true;
    setLoaded(null);
    (async () => {
      const show = (await (await fetchOk(base + "show.json")).json()) as ShowFile;
      if (!show.voices?.length || !show.audio) throw new Error("show.json needs audio and voices");
      const [audio, ...teles] = await Promise.all([fetchOk(base + show.audio).then((r) => r.arrayBuffer()), ...show.voices.map((v) => fetchOk(base + v.tele).then((r) => r.arrayBuffer()))]);
      // the words: syllables as the CLI splits them (the pronouncing dictionary first, as it does)
      const melodies = await Promise.all(show.voices.map((v) => (v.melody ? fetchOk(base + v.melody).then((r) => r.json() as Promise<Melody>) : null)));
      if (melodies.some(Boolean)) await g2p.load().catch(() => {});
      const words = melodies.map((m) => {
        if (!m) return null;
        try {
          return sungWords(m, lyricsToSyllables(m.lyrics), show.spell);
        } catch (e) {
          console.warn("duet: no words for a voice:", e);
          return null;
        }
      });
      const voices: LoadedVoice[] = show.voices.map((v, i) => (isCreatureFile(teles[i]) ? { name: v.name, kind: "creature", track: new CreatureTrack(teles[i]) } : { name: v.name, kind: "human", track: new TeleTrack(teles[i]), words: words[i] }));
      await transport.load(audio);
      if (show.subtitleFont) {
        const face = new FontFace("ShowHan", `url(${base + show.subtitleFont})`);
        document.fonts.add(await face.load());
      }
      const subs = show.subtitles ? parseSubtitles(await (await fetchOk(base + show.subtitles)).json()) : [];
      if (live) setLoaded({ show, voices, subs });
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [base, transport]);

  // the readouts follow the transport: at once on a change, and a few times a second while it plays
  useEffect(() => {
    if (!transport) return;
    const off = transport.subscribe(() => setTick((n) => n + 1));
    const id = setInterval(() => transport.isPlaying && setTick((n) => n + 1), 250);
    return () => {
      off();
      clearInterval(id);
    };
  }, [transport]);

  // the recorder's handle: set the playhead, and say when the heads and the lines are loaded
  useEffect(() => {
    if (!CAPTURE || !transport || !loaded) return;
    const clock = transport as ManualClock;
    (window as unknown as { __duet: unknown }).__duet = { ready: true, set: (t: number) => clock.set(t), setDuration: (d: number) => clock.setDuration(d) };
    return () => void delete (window as unknown as { __duet?: unknown }).__duet;
  }, [transport, loaded]);

  if (error)
    return (
      <div className="duet">
        <p className="duet-msg error">This show could not load: {error}</p>
      </div>
    );
  const st = transport?.state ?? { playing: false, time: 0, duration: 0, epoch: 0 };
  const title = loaded?.show.title ?? "Loading…";
  return (
    <div className={CAPTURE ? "duet capture" : "duet"}>
      <header className="duet-top">
        <span className="wordmark">Chimera</span>
        <span className="duet-title">{title}</span>
      </header>
      <main className="duet-heads" style={{ "--voices": loaded?.voices.length ?? 2 } as React.CSSProperties}>
        {loaded && transport ? (
          loaded.voices.map((v, i) => {
            const facing = i > 0 && i === loaded.voices.length - 1 ? -1 : 1;
            return v.kind === "creature" ? <CreatureHead key={i} name={v.name} track={v.track} transport={transport} facing={facing} /> : <Head key={i} name={v.name} track={v.track} words={v.words} show={loaded.show} transport={transport} facing={facing} />;
          })
        ) : (
          <p className="duet-msg">Loading the song…</p>
        )}
      </main>
      {loaded && loaded.subs.length > 0 && transport && <Subtitles subs={loaded.subs} clock={transport} />}
      <footer className="duet-bar">
        <button className="primary large" disabled={!loaded} onClick={() => (st.playing ? transport?.pause() : transport?.play())}>
          {st.playing ? "Pause" : st.duration > 0 && st.time >= st.duration - 0.05 ? "Again" : "Play"}
        </button>
        <span className="duet-time">
          {clock(st.time)} / {clock(st.duration)}
        </span>
        <input
          type="range"
          aria-label="Position in the song"
          min={0}
          max={st.duration || 1}
          step={0.1}
          value={st.time}
          disabled={!loaded}
          onChange={(e) => transport?.seek(Number(e.target.value))}
          style={{ "--pos": `${st.duration ? (100 * st.time) / st.duration : 0}%` } as React.CSSProperties}
        />
      </footer>
    </div>
  );
}

/** one voice's head; the last of several turns to face the others */
function Head(props: { name: string; track: TeleTrack; words: SungWords | null; show: ShowFile; transport: Clock; facing: 1 | -1 }) {
  const { track, show, transport, words } = props;
  const feedRef = useRef<HeadFeed | null>(null);
  // the syllable at the mouth, written on the side the face looks to
  const overlayRef = useRef<OverlayFn | undefined>(undefined);
  if (words && !overlayRef.current) overlayRef.current = mouthWords(() => wordAt(words, transport.time()), V.green, props.facing);
  if (!feedRef.current) {
    const model = getModel(track.body, track.sampleRate);
    const beatStep = (t: number) => {
      if (!show.bpm) return -1;
      const s = Math.floor(((t - (show.downbeat ?? 0)) * show.bpm * 4) / 60);
      return s < 0 ? -1 : s % 16;
    };
    feedRef.current = {
      model,
      view: VIEW,
      maxDpr: 1.5,
      facing: props.facing,
      frame: () => {
        const t = transport.time();
        const i = track.indexAt(t);
        const msg = track.message(i, beatStep(t));
        // paused: the head keeps its shape, the voice and the face come to rest
        if (!transport.isPlaying) return { tele: null, artic: VoiceModel.articFromArray(msg.t.artic), epoch: transport.epoch };
        return { tele: msg, artic: VoiceModel.articFromArray(msg.t.artic), epoch: transport.epoch };
      },
    };
  }
  return (
    <Screen className="duet-head" focus title={props.name} sub={bodyLabel(track.body)} label={`${props.name} voice, ${bodyLabel(track.body)}, in 3D`}>
      <AnatomyView3D feed={feedRef.current} readouts={false} overlay={overlayRef.current} />
    </Screen>
  );
}

/** a creature's head: the same screen, with the animal's name for its sub-title */
function CreatureHead(props: { name: string; track: CreatureTrack; transport: Clock; facing: 1 | -1 }) {
  const what = creatureById(props.track.id)?.name ?? props.track.id;
  return (
    <Screen className="duet-head" focus title={props.name} sub={what} label={`${props.name}, a ${what}, in 3D`}>
      <CreatureHead3D track={props.track} transport={props.transport} facing={props.facing} />
    </Screen>
  );
}

/** the line sung now, in Han characters and in Tâi-lô; it follows the playhead every frame, not the page's slower readout tick */
function Subtitles(props: { subs: Subtitle[]; clock: Clock }) {
  const [line, setLine] = useState<Subtitle | null>(null);
  const last = useRef<Subtitle | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = subtitleAt(props.subs, props.clock.time());
      if (now !== last.current) {
        last.current = now;
        setLine(now);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [props.subs, props.clock]);
  return (
    <div className="duet-subs" lang="nan-Hant-TW" role="status" aria-live="off">
      <div className="duet-sub-han">{line?.han ?? "\u00a0"}</div>
      <div className="duet-sub-tailo" lang="nan-Latn-TW">{line?.tailo ?? "\u00a0"}</div>
    </div>
  );
}
