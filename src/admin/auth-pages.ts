import Elysia from "elysia";

/**
 * Built-in HTML pages for the email-link auth flows: password reset, email
 * verification and OTP / magic-link login. The link emails point at
 * `{app.url}/auth/{kind}?token=...&collection=...`. Without a frontend at
 * `app.url`, these tokens would have nowhere to land — so vaultbase ships
 * minimal self-contained pages that POST to the existing JSON API.
 *
 * Each page is a single inlined HTML document (no external assets, no JS
 * framework) so it works whether vaultbase is the host or behind a custom
 * domain.
 */

const COMMON_HEAD = /* html */ `
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<style>
  :root {
    --bg: #0b0d12;
    --card: #14171f;
    --fg: #e7eaf0;
    --muted: #8b93a7;
    --border: #232735;
    --accent: #a3e635;
    --danger: #f87171;
    --success: #34d399;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 400px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.03), 0 12px 40px rgba(0,0,0,0.4);
  }
  .brand {
    display: flex; align-items: center; gap: 8px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px; color: var(--muted);
    margin-bottom: 18px;
  }
  .brand .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent);
  }
  h1 {
    font-size: 18px; font-weight: 600; margin: 0 0 6px;
  }
  p.sub {
    margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.5;
  }
  label {
    display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .field { margin-bottom: 14px; position: relative; }
  input[type="password"], input[type="text"] {
    width: 100%; padding: 9px 36px 9px 11px;
    background: rgba(255,255,255,0.03);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px; font-size: 13px;
    font-family: inherit;
    outline: none;
    transition: border-color 120ms;
  }
  input:focus { border-color: var(--accent); }
  .reveal {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: transparent; border: 0; color: var(--muted); cursor: pointer;
    padding: 6px; display: flex; align-items: center;
  }
  .reveal:hover { color: var(--fg); }
  button.primary {
    width: 100%; padding: 10px 14px;
    background: var(--accent); color: #000;
    border: 0; border-radius: 6px; font-weight: 600; font-size: 13px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary:hover:not(:disabled) { filter: brightness(1.05); }
  .msg { font-size: 12px; padding: 9px 11px; border-radius: 6px; margin-bottom: 14px; line-height: 1.4; }
  .msg.error   { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: var(--danger); }
  .msg.success { background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.3); color: var(--success); }
  .center { text-align: center; }
  .spinner {
    width: 14px; height: 14px;
    border: 2px solid rgba(0,0,0,0.2); border-top-color: #000;
    border-radius: 50%; animation: spin 600ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .footer { font-size: 11px; color: var(--muted); margin-top: 18px; text-align: center; }
</style>
`;

const REVEAL_SVG_EYE =
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const REVEAL_SVG_EYE_OFF =
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-10-7-10-7a19.77 19.77 0 0 1 4.22-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 7 10 7a19.86 19.86 0 0 1-3.17 4.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
${COMMON_HEAD}
<title>${escapeHtml(title)}</title>
</head>
<body>
<div class="card">
  <div class="brand"><span class="dot"></span><span>vaultbase</span></div>
  ${body}
  <div class="footer">vaultbase &middot; self-hosted backend</div>
</div>
</body>
</html>`;
}

function resetPage(token: string, collection: string): string {
  const body = /* html */ `
<h1>Reset your password</h1>
<p class="sub">Choose a new password for your account. Both fields must match.</p>
<div id="msg"></div>
<form id="form" autocomplete="off">
  <div class="field">
    <label for="pw">New password</label>
    <input id="pw" type="password" autocomplete="new-password" required minlength="8" />
    <button type="button" class="reveal" data-target="pw" aria-label="Show password">${REVEAL_SVG_EYE}</button>
  </div>
  <div class="field">
    <label for="pw2">Confirm password</label>
    <input id="pw2" type="password" autocomplete="new-password" required minlength="8" />
    <button type="button" class="reveal" data-target="pw2" aria-label="Show password">${REVEAL_SVG_EYE}</button>
  </div>
  <button type="submit" id="submit" class="primary">Reset password</button>
</form>
<script>
(function () {
  var token = ${JSON.stringify(token)};
  var collection = ${JSON.stringify(collection)};
  var form = document.getElementById('form');
  var msg = document.getElementById('msg');
  var btn = document.getElementById('submit');

  document.querySelectorAll('.reveal').forEach(function (b) {
    b.addEventListener('click', function () {
      var input = document.getElementById(b.dataset.target);
      if (!input) return;
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      b.innerHTML = showing ? ${JSON.stringify(REVEAL_SVG_EYE)} : ${JSON.stringify(REVEAL_SVG_EYE_OFF)};
    });
  });

  function show(kind, text) {
    msg.className = 'msg ' + kind;
    msg.textContent = text;
  }

  if (!token || !collection) {
    show('error', 'Missing token or collection. Use the link from the email.');
    btn.disabled = true;
    return;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var pw  = document.getElementById('pw').value;
    var pw2 = document.getElementById('pw2').value;
    if (pw !== pw2) { show('error', 'Passwords do not match.'); return; }
    if (pw.length < 8) { show('error', 'Password must be at least 8 characters.'); return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Resetting...';
    try {
      var res = await fetch('/api/v1/auth/' + encodeURIComponent(collection) + '/confirm-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token, password: pw }),
      });
      var json = await res.json().catch(function () { return {}; });
      if (res.ok && json && json.data && json.data.reset) {
        show('success', 'Password reset. You can now sign in with your new password.');
        form.style.display = 'none';
      } else {
        show('error', (json && json.error) || ('Request failed (' + res.status + ').'));
        btn.disabled = false;
        btn.textContent = 'Reset password';
      }
    } catch (err) {
      show('error', 'Network error. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Reset password';
    }
  });
})();
</script>
`;
  return pageShell("Reset your password", body);
}

function verifyPage(token: string, collection: string): string {
  const body = /* html */ `
<h1>Verify your email</h1>
<p class="sub">Confirming your email address...</p>
<div id="msg" class="msg" style="display:none"></div>
<div id="loading" class="center" style="margin: 18px 0;">
  <div class="spinner" style="border-color: rgba(255,255,255,0.1); border-top-color: var(--accent); margin: 0 auto;"></div>
</div>
<script>
(function () {
  var token = ${JSON.stringify(token)};
  var collection = ${JSON.stringify(collection)};
  var msg = document.getElementById('msg');
  var loading = document.getElementById('loading');

  function show(kind, text) {
    loading.style.display = 'none';
    msg.style.display = 'block';
    msg.className = 'msg ' + kind;
    msg.textContent = text;
  }

  if (!token || !collection) { show('error', 'Missing token or collection. Use the link from the email.'); return; }

  fetch('/api/v1/auth/' + encodeURIComponent(collection) + '/verify-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token }),
  }).then(async function (res) {
    var json = await res.json().catch(function () { return {}; });
    if (res.ok && json && json.data && json.data.verified) {
      show('success', 'Email verified. You can close this tab and continue in the app.');
    } else {
      show('error', (json && json.error) || 'Invalid or expired link.');
    }
  }).catch(function () {
    show('error', 'Network error. Please try again.');
  });
})();
</script>
`;
  return pageShell("Verify your email", body);
}

function otpPage(token: string, collection: string): string {
  const body = /* html */ `
<h1>Sign in</h1>
<p class="sub">Authenticating with your magic link...</p>
<div id="msg" class="msg" style="display:none"></div>
<div id="loading" class="center" style="margin: 18px 0;">
  <div class="spinner" style="border-color: rgba(255,255,255,0.1); border-top-color: var(--accent); margin: 0 auto;"></div>
</div>
<div id="result" style="display:none">
  <p class="sub">You're signed in. The token below is valid for the next hour.</p>
  <div class="field">
    <label>JWT</label>
    <textarea id="jwt" readonly style="width:100%;min-height:96px;padding:9px 11px;background:rgba(255,255,255,0.03);color:var(--fg);border:1px solid var(--border);border-radius:6px;font-size:11px;font-family:ui-monospace,monospace;resize:vertical"></textarea>
  </div>
  <button type="button" id="copy" class="primary">Copy token</button>
</div>
<script>
(function () {
  var token = ${JSON.stringify(token)};
  var collection = ${JSON.stringify(collection)};
  var msg = document.getElementById('msg');
  var loading = document.getElementById('loading');
  var result = document.getElementById('result');

  function show(kind, text) {
    loading.style.display = 'none';
    msg.style.display = 'block';
    msg.className = 'msg ' + kind;
    msg.textContent = text;
  }

  if (!token || !collection) { show('error', 'Missing token or collection. Use the link from the email.'); return; }

  fetch('/api/v1/auth/' + encodeURIComponent(collection) + '/otp/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token }),
  }).then(async function (res) {
    var json = await res.json().catch(function () { return {}; });
    if (res.ok && json && json.data && json.data.token) {
      loading.style.display = 'none';
      result.style.display = 'block';
      var ta = document.getElementById('jwt');
      ta.value = json.data.token;
      try { localStorage.setItem('vaultbase_user_token', json.data.token); } catch (_) {}
      document.getElementById('copy').addEventListener('click', function () {
        ta.select();
        navigator.clipboard.writeText(ta.value);
        var b = document.getElementById('copy');
        var prev = b.textContent;
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = prev; }, 1200);
      });
    } else {
      show('error', (json && json.error) || 'Invalid or expired link.');
    }
  }).catch(function () {
    show('error', 'Network error. Please try again.');
  });
})();
</script>
`;
  return pageShell("Sign in", body);
}

export function makeAuthPagesPlugin() {
  return new Elysia({ name: "auth-pages" })
    .get("/auth/reset", ({ query, set }) => {
      const token = String(query.token ?? "");
      const collection = String(query.collection ?? "users");
      set.headers["content-type"] = "text/html; charset=utf-8";
      set.headers["cache-control"] = "no-store";
      return resetPage(token, collection);
    })
    .get("/auth/verify", ({ query, set }) => {
      const token = String(query.token ?? "");
      const collection = String(query.collection ?? "users");
      set.headers["content-type"] = "text/html; charset=utf-8";
      set.headers["cache-control"] = "no-store";
      return verifyPage(token, collection);
    })
    .get("/auth/otp", ({ query, set }) => {
      const token = String(query.token ?? "");
      const collection = String(query.collection ?? "users");
      set.headers["content-type"] = "text/html; charset=utf-8";
      set.headers["cache-control"] = "no-store";
      return otpPage(token, collection);
    });
}
