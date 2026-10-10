// get.vaultbase.dev — serves deploy/install.sh from the latest release tag.
//
// Pinned to the tag, never `main`: users pipe this into `sudo sh`, so only
// released installer code should ever reach them. A new release is picked up
// automatically once the edge cache (5 min) expires.

const REPO = "vaultbase-sh/vaultbase";
const CACHE = { cacheTtl: 300, cacheEverything: true };

// Failure body is itself valid shell, so `curl ... | sh` exits non-zero with
// a readable message instead of executing an HTML error page.
const unavailable = () =>
  new Response("echo 'vaultbase: installer temporarily unavailable, try again shortly' >&2; exit 1\n", {
    status: 502,
    headers: { "content-type": "text/x-sh; charset=utf-8", "cache-control": "no-store" },
  });

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname !== "/" && pathname !== "/install.sh") {
      return new Response("Not found\n", { status: 404 });
    }

    // /releases/latest 302s to /releases/tag/<vX.Y.Z>; read the tag without following.
    const latest = await fetch(`https://github.com/${REPO}/releases/latest`, {
      redirect: "manual",
      cf: CACHE,
    });
    const tag = (latest.headers.get("location") || "").split("/tag/")[1];
    if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) return unavailable();

    const script = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/deploy/install.sh`, {
      cf: CACHE,
    });
    if (!script.ok) return unavailable();

    return new Response(script.body, {
      headers: {
        "content-type": "text/x-sh; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-vaultbase-installer-tag": tag,
      },
    });
  },
};
