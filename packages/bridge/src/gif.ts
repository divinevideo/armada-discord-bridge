/**
 * mp4 -> gif transcode via the system ffmpeg, for GIF-picker providers that
 * publish no real .gif asset (Klipy's embeds carry only mp4 + webp). Small
 * clips only; 15 fps capped at 320px wide keeps output sizes tolerable.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ffmpegPath: string | null | undefined;

/**
 * Wall-clock ceiling on one transcode. The input is an mp4 named by a remote
 * page's OpenGraph tags, so its duration and complexity are attacker-chosen;
 * without this a single message pins a core indefinitely.
 */
const FFMPEG_TIMEOUT_MS = 20_000;

/**
 * Seconds of source honored. A GIF at 15fps and 320px wide runs to hundreds of
 * megabytes for a clip of any real length, and the size was only ever checked
 * after the file had been written to /tmp and read back into memory — so the
 * bound has to be on what ffmpeg is asked to produce, not on what it produced.
 */
const FFMPEG_MAX_SECONDS = 10;

/**
 * Hard ceiling handed to ffmpeg's `-fs`, so it stops writing rather than
 * filling /tmp. Mirrors router.ts's MAX_BLOB_BYTES (Discord's webhook upload
 * limit); duplicated rather than imported because router.ts imports this
 * module. The caller re-checks the returned length against its own limit.
 */
const MAX_GIF_BYTES = 10 * 1024 * 1024;

export function ffmpegAvailable(): boolean {
  if (ffmpegPath === undefined) ffmpegPath = Bun.which("ffmpeg");
  return ffmpegPath !== null;
}

export async function mp4ToGif(data: Uint8Array): Promise<Uint8Array> {
  if (!ffmpegAvailable()) throw new Error("ffmpeg not installed");
  const dir = await mkdtemp(join(tmpdir(), "bridge-gif-"));
  const src = join(dir, "in.mp4");
  const out = join(dir, "out.gif");
  try {
    await writeFile(src, data);
    const proc = Bun.spawn(
      [
        ffmpegPath as string,
        "-y",
        "-t",
        String(FFMPEG_MAX_SECONDS),
        "-i",
        src,
        "-vf",
        "fps=15,scale='min(320,iw)':-2:flags=lanczos",
        "-fs",
        String(MAX_GIF_BYTES),
        "-loop",
        "0",
        out,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), FFMPEG_TIMEOUT_MS);
    let code: number;
    try {
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    if (code !== 0) {
      throw new Error(`ffmpeg failed: ${await new Response(proc.stderr).text()}`);
    }
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
