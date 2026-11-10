/**
 * A creature's recorded telemetry (`chimera render creature-notes … --tele x.ctele`), replayed on a
 * creature head in the duet page.
 *
 * File layout (little-endian; crates/chimera-cli/src/render.rs `CreatureTeleRecorder`): "CCTL", u32
 * version, sampleRate, hop, frames, frameLen, jsonLen; then jsonLen bytes of JSON
 * `{"id", "params": [keys], "source": [keys], "tubes": [[name, nodes], …]}` (padded to 4 bytes);
 * then `frames` × `frameLen` f32. A frame: gate, outRms, clock, the params, the source values, then
 * each tube's `nodes` areas and its `nodes` pressure RMS levels. Frame i is the state at sample
 * i·hop.
 */
export const CTELE_VERSION = 1;
const FIXED_BYTES = 28;

export interface CreatureFrame {
  gate: number;
  outRms: number;
  clock: number;
  params: Record<string, number>;
  source: Record<string, number>;
  tubes: Record<string, { areas: Float32Array; rms: Float32Array }>;
}

interface Header {
  id: string;
  params: string[];
  source: string[];
  tubes: [string, number][];
}

export class CreatureTrack {
  readonly id: string;
  readonly sampleRate: number;
  readonly hop: number;
  readonly frames: number;
  private readonly head: Header;
  private readonly len: number;
  private readonly data: Float32Array;

  constructor(buf: ArrayBuffer) {
    if (buf.byteLength < FIXED_BYTES) throw new Error("creature telemetry file is too short for its header");
    if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== "CCTL") throw new Error("not a CHIMERA creature telemetry file");
    const u = new DataView(buf);
    const at = (i: number) => u.getUint32(4 + 4 * i, true);
    if (at(0) !== CTELE_VERSION) throw new Error(`creature telemetry file version ${at(0)}; this app reads ${CTELE_VERSION}`);
    this.sampleRate = at(1);
    this.hop = at(2);
    this.frames = at(3);
    this.len = at(4);
    const jsonLen = at(5);
    if (FIXED_BYTES + jsonLen > buf.byteLength || jsonLen % 4 !== 0) throw new Error("creature telemetry file header is inconsistent");
    this.head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, FIXED_BYTES, jsonLen))) as Header;
    this.id = this.head.id;
    const want = 3 + this.head.params.length + this.head.source.length + this.head.tubes.reduce((s, [, n]) => s + 2 * n, 0);
    if (this.len !== want || this.frames < 1 || this.hop < 1 || this.sampleRate < 1) throw new Error("creature telemetry file header is inconsistent");
    const body = FIXED_BYTES + jsonLen;
    if (buf.byteLength !== body + 4 * this.frames * this.len) throw new Error(`creature telemetry file is ${buf.byteLength} bytes; its header says ${body + 4 * this.frames * this.len}`);
    this.data = new Float32Array(buf, body, this.frames * this.len);
  }

  get duration(): number {
    return ((this.frames - 1) * this.hop) / this.sampleRate;
  }

  /** the frame at time t (s), clamped to the recording */
  indexAt(t: number): number {
    const i = Math.floor((t * this.sampleRate) / this.hop + 1e-6);
    return Math.min(this.frames - 1, Math.max(0, Number.isFinite(i) ? i : 0));
  }

  frame(i: number): CreatureFrame {
    const o0 = i * this.len;
    const d = this.data;
    let o = o0 + 3;
    const params: Record<string, number> = {};
    for (const k of this.head.params) params[k] = d[o++];
    const source: Record<string, number> = {};
    for (const k of this.head.source) source[k] = d[o++];
    const tubes: CreatureFrame["tubes"] = {};
    for (const [name, n] of this.head.tubes) {
      tubes[name] = { areas: d.subarray(o, o + n), rms: d.subarray(o + n, o + 2 * n) };
      o += 2 * n;
    }
    return { gate: d[o0], outRms: d[o0 + 1], clock: d[o0 + 2], params, source, tubes };
  }
}
