import { readFileSync } from "fs";

// Codec WASM, embedded into the single binary.
//
// `bun build --compile` only bundles what the import graph references. The
// codecs load their .wasm at runtime instead (imagescript reads a path next to
// its own files, @jsquash fetches `new URL(..., import.meta.url)`), so in a
// compiled binary those files are simply missing and every thumbnail falls
// back to the original. Importing them `with { type: "file" }` embeds them and
// yields a path that works both on disk (dev) and inside the binary.
import pngWasm from "imagescript/wasm/any/png.wasm" with { type: "file" };
import jpegWasm from "imagescript/wasm/any/jpeg.wasm" with { type: "file" };
import gifWasm from "imagescript/wasm/any/gif.wasm" with { type: "file" };
import webpDecWasm from "@jsquash/webp/codec/dec/webp_dec.wasm" with { type: "file" };
import webpEncWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm" with { type: "file" };
import avifDecWasm from "@jsquash/avif/codec/dec/avif_dec.wasm" with { type: "file" };
import avifEncWasm from "@jsquash/avif/codec/enc/avif_enc.wasm" with { type: "file" };
import jpegEncWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm" with { type: "file" };

// imagescript's loaders are patched (scripts/patch-imagescript.ts) to read
// their .wasm from here before falling back to the path beside the package.
(globalThis as { __vaultbaseImagescriptWasm?: Record<string, string> }).__vaultbaseImagescriptWasm = {
  png: pngWasm,
  jpeg: jpegWasm,
  gif: gifWasm,
};

function compile(path: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(readFileSync(path));
}

/** Load once on first use; a failed load is retried on the next call. */
function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= load().catch((e) => { p = undefined; throw e; }));
}

export const webpDecoder = lazy(async () => {
  const m = await import("@jsquash/webp/decode.js");
  await m.init(await compile(webpDecWasm));
  return m.default;
});

export const webpEncoder = lazy(async () => {
  // The SIMD build: Bun's engine always has WASM SIMD, which is what
  // @jsquash's own feature check picks the matching glue code by.
  const m = await import("@jsquash/webp/encode.js");
  await m.init(await compile(webpEncWasm));
  return m.default;
});

export const avifDecoder = lazy(async () => {
  const m = await import("@jsquash/avif/decode.js");
  await m.init(await compile(avifDecWasm));
  return m.default;
});

export const avifEncoder = lazy(async () => {
  // Single-threaded build: @jsquash only uses the threaded one outside Node.
  const m = await import("@jsquash/avif/encode.js");
  await m.init(await compile(avifEncWasm));
  return m.default;
});

export const jpegEncoder = lazy(async () => {
  const m = await import("@jsquash/jpeg/encode.js");
  await m.init(await compile(jpegEncWasm));
  return m.default;
});
