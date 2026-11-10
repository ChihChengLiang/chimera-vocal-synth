/**
 * What the duet page's heads read from: the playhead. The page's `Transport` plays the mix and is
 * this; a `ManualClock` is the same with no audio, set by hand, so a recorder can step a show one
 * frame at a time and get the same frames every run (`?show=<id>&capture`, tools/record-duet.ts).
 */
import type { TransportState } from "./transport.ts";

export interface Clock {
  readonly state: TransportState;
  readonly isPlaying: boolean;
  readonly epoch: number;
  subscribe(f: () => void): () => void;
  time(): number;
  play(): void;
  pause(): void;
  seek(t: number): void;
  load(data: ArrayBuffer): Promise<void>;
  dispose(): void;
}

export class ManualClock implements Clock {
  epoch = 0;
  private t = 0;
  private len = 0;
  private readonly fs = new Set<() => void>();

  /** the show's length (s), for the readouts; the recorder knows it from the mix */
  setDuration(d: number): void {
    this.len = d;
  }
  /** move the playhead; a jump back (or a long way on) is a seek, which drops the heads' history */
  set(t: number): void {
    if (t < this.t || t - this.t > 1) this.epoch++;
    this.t = t;
    this.fs.forEach((f) => f());
  }
  get state(): TransportState {
    return { playing: true, time: this.t, duration: this.len, epoch: this.epoch };
  }
  get isPlaying(): boolean {
    return true;
  }
  subscribe(f: () => void): () => void {
    this.fs.add(f);
    return () => void this.fs.delete(f);
  }
  time(): number {
    return this.t;
  }
  play(): void {}
  pause(): void {}
  seek(t: number): void {
    this.set(t);
  }
  async load(): Promise<void> {}
  dispose(): void {
    this.fs.clear();
  }
}
