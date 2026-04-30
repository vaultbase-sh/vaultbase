/**
 * Patch `node_modules/imagescript/codecs/node/index.js` for single-binary builds.
 *
 * imagescript ships a native `.node` codec for JPEG/WebP/GIF *encoding*. The
 * module is required at the top of `ImageScript.js` — so importing it
 * crashes immediately when the .node file isn't on disk. `bun build --compile`
 * cannot bundle dlopen-able binaries, so the .node never makes it into the
 * single-file artifact.
 *
 * Workaround: replace the native bridge with a JS stub that exposes the same
 * shape but throws lazily only if an encoder is actually called. Top-level
 * `import` then succeeds and the rest of imagescript (PNG / decoders /
 * resize / crop / Frame.from / WASM codecs) keeps working.
 *
 * Idempotent: re-running on an already-patched tree is a no-op.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = resolve(import.meta.dir, "..", "node_modules/imagescript/codecs/node/index.js");
const SENTINEL = "// vaultbase-imagescript-patch-v1";

const STUB = `${SENTINEL}
// Original: required ./bin/<arch>-<platform>.node which is not bundleable
// by \`bun build --compile\`. This stub keeps top-level imports working;
// any code path that actually invokes the native encoders falls back to
// the runtime error below.
function unsupported(name) {
  return function () {
    throw new Error(
      'imagescript native codec "' + name + '" is unavailable in single-binary builds. ' +
      'Use the WASM codecs (PNG via imagescript.encode, WebP via @jsquash/webp, AVIF via @jsquash/avif) instead.'
    );
  };
}
module.exports = {
  jpeg: { encode: unsupported('jpeg.encode'), encode_async: unsupported('jpeg.encode_async') },
  webp: { encode: unsupported('webp.encode'), encode_async: unsupported('webp.encode_async') },
  gif:  { encoder: unsupported('gif.encoder') },
};
`;

if (!existsSync(TARGET)) {
  // Never installed (e.g. in a fresh CI shallow clone before \`bun install\`)
  // — exit cleanly so the script can be wired in front of any build target
  // without forcing an install order.
  console.log(`[patch-imagescript] ${TARGET} not found — skipping (run \`bun install\` first)`);
  process.exit(0);
}

const current = readFileSync(TARGET, "utf8");
if (current.startsWith(SENTINEL)) {
  console.log("[patch-imagescript] already patched — skipping");
  process.exit(0);
}

writeFileSync(TARGET, STUB, "utf8");
console.log(`[patch-imagescript] patched ${TARGET}`);
