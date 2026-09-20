/**
 * A zero-dependency page served at `/`.
 *
 * Doubles as live documentation and a playground: paste a share link, hit
 * Resolve, and it calls this same worker. Having something human-readable at
 * the root is also how you confirm a fresh deploy works without reaching for
 * curl. Everything is inlined — no CDN, no fonts, no build step.
 */
export function landingPage(origin: string, authRequired: boolean): string {
  const authField = authRequired
    ? `<label class="field"><span>API key (this deployment requires one)</span>
       <input id="key" type="password" placeholder="Bearer key" autocomplete="off" /></label>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>TeraBox API</title>
<meta name="description" content="Resolve public TeraBox share links to direct downloads and HLS streams." />
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --surface: #fff; --border: #e4e3df; --text: #1b1b19;
    --muted: #6b6a66; --accent: #b35427; --accent-soft: #f6ece5; --code: #f4f3f0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17171a; --surface: #1f1f23; --border: #32323a; --text: #ececee;
      --muted: #9d9da6; --accent: #e08a5b; --accent-soft: #2a211c; --code: #26262c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem; background: var(--bg); color: var(--text);
    font: 16px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin: 0 0 .35rem; }
  h2 { font-size: 1.1rem; letter-spacing: -0.01em; margin: 2.4rem 0 .7rem; }
  .lede { color: var(--muted); margin: 0 0 1.75rem; max-width: 40rem; }
  .badge {
    display: inline-block; font-size: .7rem; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: var(--accent); background: var(--accent-soft);
    border-radius: 999px; padding: .2rem .6rem; margin-bottom: .9rem;
  }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; }
  .field { display: block; margin-bottom: .75rem; }
  .field span { display: block; font-size: .8rem; color: var(--muted); margin-bottom: .3rem; }
  input {
    width: 100%; padding: .65rem .75rem; font: inherit; font-size: .95rem; color: var(--text);
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: flex; gap: .6rem; flex-wrap: wrap; }
  button {
    font: inherit; font-weight: 550; padding: .6rem 1.1rem; border-radius: 8px;
    border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer;
  }
  button.secondary { background: transparent; color: var(--accent); }
  button:disabled { opacity: .55; cursor: progress; }
  pre {
    background: var(--code); border: 1px solid var(--border); border-radius: 8px;
    padding: .9rem; overflow-x: auto; font-size: .82rem; line-height: 1.5;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; }
  p code, td code { background: var(--code); padding: .1rem .3rem; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; display: block; overflow-x: auto; }
  th, td { text-align: left; padding: .55rem .6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
  a { color: var(--accent); }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <span class="badge">v2.0.2</span>
  <h1>TeraBox API</h1>
  <p class="lede">
    Turns a public TeraBox share link into file metadata, a direct download,
    and a playable stream. Folder shares, password-protected shares and
    multi-file listings all work.
  </p>

  <div class="card">
    ${authField}
    <label class="field">
      <span>TeraBox share link</span>
      <input id="link" type="url" placeholder="https://terabox.com/s/1..." autocomplete="off" />
    </label>
    <label class="field">
      <span>Password (only for protected shares)</span>
      <input id="pwd" type="text" placeholder="optional" autocomplete="off" />
    </label>
    <div class="row">
      <button id="go">Resolve</button>
      <button id="clear" class="secondary" type="button">Clear</button>
    </div>
    <pre id="out" class="hidden"></pre>
  </div>

  <h2>Endpoints</h2>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
    <tbody>
      <tr><td>GET / POST</td><td><code>/api/resolve</code></td><td>Resolve one link to its files.</td></tr>
      <tr><td>POST</td><td><code>/api/batch</code></td><td>Resolve up to 8 links at once.</td></tr>
      <tr><td>GET / HEAD</td><td><code>/stream</code></td><td>Proxy the bytes, with <code>Range</code> support.</td></tr>
      <tr><td>GET</td><td><code>/hls</code></td><td>HLS manifest for video — plays MKV and AVI in a browser.</td></tr>
      <tr><td>GET</td><td><code>/health</code></td><td>Liveness and config summary.</td></tr>
      <tr><td>GET</td><td><code>/openapi.json</code></td><td>Machine-readable spec.</td></tr>
    </tbody>
  </table>

  <h2>Resolve a link</h2>
  <pre>curl "${origin}/api/resolve?link=https://terabox.com/s/1EXAMPLE"</pre>

  <h2>Play in a browser</h2>
  <pre>&lt;!-- MP4: direct --&gt;
&lt;video controls src="${origin}/stream?link=ENCODED_LINK"&gt;&lt;/video&gt;

&lt;!-- MKV / AVI: use the HLS manifest with hls.js --&gt;
hls.loadSource("${origin}/hls?link=ENCODED_LINK&amp;quality=720");</pre>

  <footer>
    <p>
      Self-hosted on Cloudflare Workers ·
      <a href="/openapi.json">OpenAPI</a> · <a href="/health">Health</a>
    </p>
    <p>
      Unofficial integration with no API contract. Works only with links that are
      already shared publicly. You are responsible for complying with TeraBox's
      terms and the laws that apply where you are.
    </p>
  </footer>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const out = $("out");

  function show(text) {
    out.textContent = text;
    out.classList.remove("hidden");
  }

  async function resolve() {
    const link = $("link").value.trim();
    if (!link) return show("Paste a TeraBox share link first.");

    const params = new URLSearchParams({ link });
    const pwd = $("pwd").value.trim();
    if (pwd) params.set("password", pwd);

    const headers = {};
    const keyInput = $("key");
    if (keyInput && keyInput.value.trim()) headers.Authorization = "Bearer " + keyInput.value.trim();

    $("go").disabled = true;
    show("Resolving…");
    try {
      const response = await fetch("/api/resolve?" + params, { headers });
      show(JSON.stringify(await response.json(), null, 2));
    } catch (err) {
      show("Request failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      $("go").disabled = false;
    }
  }

  $("go").addEventListener("click", resolve);
  $("link").addEventListener("keydown", (e) => { if (e.key === "Enter") resolve(); });
  $("clear").addEventListener("click", () => {
    $("link").value = "";
    $("pwd").value = "";
    out.classList.add("hidden");
  });
</script>
</body>
</html>`;
}
