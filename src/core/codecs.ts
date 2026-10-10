// imagescript's WASM, embedded into the single binary.
//
// `bun build --compile` only bundles what the import graph references, and
// imagescript reads its .wasm from a path beside its own files at runtime, so
// in a compiled binary the file is missing. Importing it `with { type: "file" }`
// embeds it and yields a path that works both on disk (dev) and inside the
// binary; imagescript's loaders are patched (scripts/patch-imagescript.ts) to
// read from here first.
//
// PNG backs the crop step of `cover` thumbnails, GIF the animated-GIF path.
import pngWasm from "imagescript/wasm/any/png.wasm" with { type: "file" };
import gifWasm from "imagescript/wasm/any/gif.wasm" with { type: "file" };

(globalThis as { __vaultbaseImagescriptWasm?: Record<string, string> }).__vaultbaseImagescriptWasm = {
  png: pngWasm,
  gif: gifWasm,
};
