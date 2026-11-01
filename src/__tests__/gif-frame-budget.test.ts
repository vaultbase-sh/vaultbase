/**
 * Review 15 F-1: the animated-GIF decode budget counted frames by their
 * graphic-control extensions, which are optional. A GIF without them counted
 * as one frame, so a few hundred bytes declaring a 4000×4000 canvas and 20
 * frames were fully decoded (~2.4 GB). Frames are now counted from the image
 * descriptors, and the budget is lower.
 */
import { describe, expect, it } from "bun:test";
import { generateThumbnail, gifFrameCount, gifLayout } from "../core/image.ts";

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

  // Since Bun 1.4.4, Bun.Image's metadata reports the first frame's size, so
  // the canvas has to come from the file itself.
  it("measures the canvas from the header, not the frames", () => {
    expect(gifLayout(gif(4000, 4000, 20, false))).toEqual({ frames: 20, width: 4000, height: 4000 });
  });

  it("widens the canvas to a frame that reaches past it", () => {
    const g = gif(10, 10, 1, false);
    g.set([0x10, 0x27, 0x20, 0x4e], 20); // descriptor left = 10000, top = 20000
    expect(gifLayout(g)).toEqual({ frames: 1, width: 10001, height: 20001 });
  });

  it("later frames larger than the canvas count toward the budget", async () => {
    // 10×10 canvas; frame 1 is 1×1, the other 19 are 4000×1000 descriptors.
    const g = gif(10, 10, 20, false);
    for (let f = 1; f < 20; f++) g.set([0xa0, 0x0f, 0xe8, 0x03], 19 + f * 15 + 5); // width 4000, height 1000
    expect(gifLayout(g)).toMatchObject({ frames: 20, width: 4000, height: 1000 });
    const rss0 = process.memoryUsage().rss;
    let out: Uint8Array | null = null;
    try { out = await generateThumbnail(g, { width: 50, height: 50, fit: "contain" } as never, "gif"); } catch { /* still path refused it */ }
    if (out) expect(new TextDecoder().decode(out.slice(0, 3))).not.toBe("GIF");
    expect(process.memoryUsage().rss - rss0).toBeLessThan(500_000_000);
  });

  it("a file that doesn't parse keeps its header canvas", () => {
    const g = gif(300, 200, 2, false);
    g[g.length - 1] = 0x99; // unknown block where the trailer was
    expect(gifLayout(g)).toEqual({ frames: Number.MAX_SAFE_INTEGER, width: 300, height: 200 });
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
