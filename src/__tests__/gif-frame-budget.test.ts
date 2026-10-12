/**
 * Review 15 F-1: the animated-GIF decode budget counted frames by their
 * graphic-control extensions, which are optional. A GIF without them counted
 * as one frame, so a few hundred bytes declaring a 4000×4000 canvas and 20
 * frames were fully decoded (~2.4 GB). Frames are now counted from the image
 * descriptors, and the budget is lower.
 */
import { describe, expect, it } from "bun:test";
import { generateThumbnail, gifFrameCount } from "../core/image.ts";

/** A GIF of `frames` 1×1 frames on a `w`×`h` canvas, optionally with GCEs. */
function gif(w: number, h: number, frames: number, withGce: boolean): Uint8Array {
  const out: number[] = [...new TextEncoder().encode("GIF89a")];
  out.push(w & 0xff, w >> 8, h & 0xff, h >> 8, 0x80, 0, 0); // global color table, 2 entries
  out.push(0, 0, 0, 255, 255, 255);
  for (let f = 0; f < frames; f++) {
    if (withGce) out.push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00);
    out.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0); // descriptor: 1×1 at 0,0
    out.push(0x02, 0x02, 0x44, 0x01, 0x00);    // LZW min size 2, one sub-block, terminator
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

describe("GIF frame counting", () => {
  it("counts frames without graphic-control extensions", () => {
    expect(gifFrameCount(gif(10, 10, 20, false))).toBe(20);
  });

  it("counts frames with them once each (legitimate path)", () => {
    expect(gifFrameCount(gif(10, 10, 7, true))).toBe(7);
    expect(gifFrameCount(gif(10, 10, 1, true))).toBe(1);
  });

  it("a file that doesn't parse counts as over budget", () => {
    expect(gifFrameCount(new Uint8Array([0x47, 0x49, 0x46]))).toBeGreaterThan(1e9);
  });

  it("an over-budget animation without GCEs is not decoded frame by frame", async () => {
    const bomb = gif(4000, 4000, 20, false);
    const rss0 = process.memoryUsage().rss;
    let out: Uint8Array | null = null;
    // The still (first-frame) path may produce a PNG or reject this synthetic
    // file; the animated path would return a GIF after ~2 GB of decoding.
    try { out = await generateThumbnail(bomb, { width: 50, height: 50, fit: "contain" } as never, "gif"); } catch { /* still path refused it */ }
    if (out) expect(new TextDecoder().decode(out.slice(0, 3))).not.toBe("GIF");
    expect(process.memoryUsage().rss - rss0).toBeLessThan(500_000_000);
  });
});
