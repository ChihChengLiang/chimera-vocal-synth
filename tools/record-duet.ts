/**
 * Records a duet show (`public/shows/<id>/`) as a video: the page's capture clock (`?capture`: no
 * audio, no controls) is set to each frame's time in turn, the page is screenshotted, and ffmpeg
 * joins the frames with the show's mix. Heads, subtitles and all, the same frames every run.
 *
 *   bun tools/record-duet.ts --show nongcun [--url http://127.0.0.1:5317] [--out out/record]
 *       [--size 1280x720] [--fps 30] [--from 0] [--to <seconds>] [--no-encode]
 *
 * Needs the dev server up (`bun run dev`; the wasm built) and ffmpeg on the path. The video is
 * `<out>/<id>.mp4`; frames stay in `<out>/<id>-frames/` (delete them when done). `--from`/`--to`
 * record a stretch (to check a look before the whole run); the length defaults to the mix's.
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const show = arg("show");
if (!show) {
  console.error("usage: bun tools/record-duet.ts --show <id> [--url …] [--out out/record] [--size 1280x720] [--fps 30] [--from s] [--to s] [--no-encode]");
  process.exit(1);
}
const url = arg("url") ?? "http://127.0.0.1:5317";
const out = arg("out") ?? "out/record";
const [W, H] = (arg("size") ?? "1280x720").split("x").map(Number);
const fps = Number(arg("fps") ?? 30);
const dir = `${out}/${show}-frames`;

/** the mix's length (s), from its WAV header (16-bit PCM written by the show's build) */
function wavSeconds(path: string): number {
  const b = readFileSync(path);
  const rate = b.readUInt32LE(24), bytes = b.readUInt32LE(40), ch = b.readUInt16LE(22), bits = b.readUInt16LE(34);
  return bytes / (rate * ch * (bits / 8));
}
const mix = `public/shows/${show}/mix.wav`;
if (!existsSync(mix)) throw new Error(`${mix} is missing: build the show first`);
const total = Number(arg("to") ?? wavSeconds(mix));
const from = Number(arg("from") ?? 0);

mkdirSync(out, { recursive: true });
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const gl = process.platform === "darwin" ? ["--use-angle=metal", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
// Playwright's own Chromium if it is installed, else the machine's Chrome
const browser = await chromium.launch({ headless: true, args: gl }).catch(() => chromium.launch({ channel: "chrome", headless: true, args: gl }));
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${url}/?show=${encodeURIComponent(show)}&capture`);
await page.waitForFunction(() => (window as unknown as { __duet?: { ready: boolean } }).__duet?.ready === true, undefined, { timeout: 60000 });
await page.evaluate((d) => (window as unknown as { __duet: { setDuration(d: number): void } }).__duet.setDuration(d), total);
// two frames of drawing per step, so the heads and the lines have caught up with the clock
const settle = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const n = Math.round((total - from) * fps);
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const t = from + i / fps;
  await page.evaluate((t) => (window as unknown as { __duet: { set(t: number): void } }).__duet.set(t), t);
  await settle();
  await page.screenshot({ path: `${dir}/${String(i).padStart(5, "0")}.jpg`, type: "jpeg", quality: 92 });
  if (i % 150 === 0) console.log(`frame ${i}/${n}  t=${t.toFixed(1)}s  ${(((Date.now() - t0) / 1000 / Math.max(1, i)) * (n - i) / 60).toFixed(1)} min left`);
}
await browser.close();
if (errors.length) console.warn(`${errors.length} page error(s):\n${errors.slice(0, 5).join("\n")}`);

if (!process.argv.includes("--no-encode")) {
  const mp4 = `${out}/${show}.mp4`;
  const args = ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", `${dir}/%05d.jpg`, "-ss", String(from), "-t", String(total - from), "-i", mix, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", mp4];
  const r = Bun.spawnSync(["ffmpeg", ...args]);
  if (r.exitCode !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
  console.log(`${mp4}: ${n} frames at ${fps} fps, ${(total - from).toFixed(1)} s`);
}
