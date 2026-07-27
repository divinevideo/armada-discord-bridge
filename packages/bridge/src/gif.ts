/**
 * mp4 -> gif transcode via the system ffmpeg, for GIF-picker providers that
 * publish no real .gif asset (Klipy's embeds carry only mp4 + webp). Small
 * clips only; 15 fps capped at 320px wide keeps output sizes tolerable.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ffmpegPath: string | null | undefined;

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
        "-i",
        src,
        "-vf",
        "fps=15,scale='min(320,iw)':-2:flags=lanczos",
        "-loop",
        "0",
        out,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error(`ffmpeg failed: ${await new Response(proc.stderr).text()}`);
    }
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
