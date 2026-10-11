// get.vaultbase.dev — serves the installers from the latest release tag.
//
//   /, /install.sh   deploy/install.sh   (Linux, macOS: `curl ... | sh`)
//   /install.ps1     deploy/install.ps1  (Windows: `irm ... | iex`)
//
// `/` also returns install.ps1 when the request comes from PowerShell, so
// `irm https://get.vaultbase.dev | iex` works too.
//
// Pinned to the tag, never `main`: users pipe this into `sudo sh` / `iex`, so
// only released installer code should ever reach them. A new release is
// picked up automatically once the edge cache (5 min) expires.

const REPO = "vaultbase-sh/vaultbase";
const CACHE = { cacheTtl: 300, cacheEverything: true };

const SCRIPTS = {
  sh: {
    file: "deploy/install.sh",
    type: "text/x-sh; charset=utf-8",
    // Failure body is itself valid shell, so `curl ... | sh` exits non-zero
    // with a readable message instead of executing an HTML error page.
    unavailable: "echo 'vaultbase: installer temporarily unavailable, try again shortly' >&2; exit 1\n",
  },
  ps1: {
    file: "deploy/install.ps1",
    type: "text/plain; charset=utf-8",
    // Same idea for `irm ... | iex`. Write-Host, not `exit`, so the user's
    // shell stays open.
    unavailable: "Write-Host 'vaultbase: installer temporarily unavailable, try again shortly' -ForegroundColor Red\n",
  },
};

const unavailable = (script) =>
  new Response(script.unavailable, {
    status: 502,
    headers: { "content-type": script.type, "cache-control": "no-store" },
  });

// Windows PowerShell 5.1 sends "WindowsPowerShell/5.1…", PowerShell 7 sends
// "PowerShell/7.…".
const isPowerShell = (request) => /PowerShell\//.test(request.headers.get("user-agent") || "");

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    let script;
    if (pathname === "/install.sh") script = SCRIPTS.sh;
    else if (pathname === "/install.ps1") script = SCRIPTS.ps1;
    else if (pathname === "/") script = isPowerShell(request) ? SCRIPTS.ps1 : SCRIPTS.sh;
    else return new Response("Not found\n", { status: 404 });

    // /releases/latest 302s to /releases/tag/<vX.Y.Z>; read the tag without following.
    const latest = await fetch(`https://github.com/${REPO}/releases/latest`, {
      redirect: "manual",
      cf: CACHE,
    });
    const tag = (latest.headers.get("location") || "").split("/tag/")[1];
    if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) return unavailable(script);

    const body = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/${script.file}`, {
      cf: CACHE,
    });
    if (!body.ok) return unavailable(script);

    return new Response(body.body, {
      headers: {
        "content-type": script.type,
        "cache-control": "public, max-age=300",
        // `/` returns a different script per user agent.
        vary: "user-agent",
        "x-vaultbase-installer-tag": tag,
      },
    });
  },
};
