// The page: the three buttons, then one section per address with one row per keyserver from
// the press that produced this page. Plain HTML with inline styles, so the Worker serves it
// with a CSP that allows nothing else. Colors are tokens defined for light and dark, and a
// server's state is a chip so it reads before the words.

import type { Report } from "./sync"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const when = (iso: string) => esc(iso.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC"))

const MODE_NAMES = { status: "Fetch status", dry: "Dry run", sync: "Sync now" } as const

const CHIP = { current: "ok", stale: "warn", missing: "warn", failed: "bad" } as const

/** Layout: a single column; buttons first, then a section per address with a results table. */
export const CSS = `
  :root {
    --bg: #fbfaf7; --fg: #1f2320; --muted: #6b716c; --line: #d9d7cf; --surface: #f1efe8;
    --accent: #1f5f8b; --ok-bg: #e2efe3; --ok-fg: #1e5a2a; --warn-bg: #f5ead2; --warn-fg: #6e4a07;
    --bad-bg: #f6e0dc; --bad-fg: #8a2a1f;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #161816; --fg: #e8e6df; --muted: #9a9f9a; --line: #30342f; --surface: #1f221f;
      --accent: #8fc1e3; --ok-bg: #1d3322; --ok-fg: #a9dcb2; --warn-bg: #3a2f14; --warn-fg: #e8c875;
      --bad-bg: #3d1f1b; --bad-fg: #f0b2a8;
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #161816; --fg: #e8e6df; --muted: #9a9f9a; --line: #30342f; --surface: #1f221f;
    --accent: #8fc1e3; --ok-bg: #1d3322; --ok-fg: #a9dcb2; --warn-bg: #3a2f14; --warn-fg: #e8c875;
    --bad-bg: #3d1f1b; --bad-fg: #f0b2a8;
    color-scheme: dark;
  }
  body { background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); margin: 0; }
  main { max-width: 58rem; margin: 0 auto; padding-block: 2rem 3rem; padding-inline: 16px; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: 1.05rem; margin: 2.25rem 0 .35rem; text-wrap: balance; }
  p { margin: .25rem 0; }
  .muted { color: var(--muted); }
  code { font-family: var(--mono); font-size: .88em; word-break: break-all; }
  .fpr { font-family: var(--mono); font-size: .92rem; letter-spacing: .02em; font-variant-numeric: tabular-nums; }
  form { display: flex; flex-wrap: wrap; gap: .6rem; margin-block: 1.25rem .5rem; }
  button { font: inherit; font-weight: 600; padding: .55rem 1.1rem; border-radius: .4rem; cursor: pointer;
    border: 1px solid var(--accent); background: var(--surface); color: var(--fg); }
  button.primary { background: var(--accent); color: var(--bg); }
  button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  .help { color: var(--muted); font-size: .92rem; }
  .bad-text { color: var(--bad-fg); }
  .table { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 28rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
  .chip { display: inline-block; border-radius: 1rem; padding: .05rem .6rem; font-size: .85rem; font-weight: 600; margin-right: .5rem; }
  .ok { background: var(--ok-bg); color: var(--ok-fg); }
  .warn { background: var(--warn-bg); color: var(--warn-fg); }
  .bad { background: var(--bad-bg); color: var(--bad-fg); }
`

const section = (email: string, report: Report | null): string => {
  const k = report?.keys.find((r) => r.email === email)
  const head = `\n<h2>${esc(email)}</h2>`
  if (!k) return `${head}\n<p class="muted">Press a button.</p>`
  const rows = Object.entries(k.servers)
    .map(
      ([server, r]) =>
        `<tr><td>${esc(server.replace(/^https?:\/\//, ""))}</td><td><span class="chip ${
          CHIP[r.state]
        }">${r.state}</span>${esc(r.detail)}</td></tr>`,
    )
    .join("")
  return `${head}
${k.fingerprint ? `<p class="fpr">${esc(k.fingerprint)}</p>` : ""}
${k.error ? `<p class="bad-text">${esc(k.error)}</p>` : ""}
${rows ? `<div class="table"><table><tr><th>Keyserver</th><th>Holds the current key</th></tr>${rows}</table></div>` : ""}`
}

/** The page's content: everything between the body tags. Shared with the published preview. */
export const body = (report: Report | null, addresses: string[], user: string): string => {
  const press = report
    ? `${MODE_NAMES[report.mode]} by ${esc(report.user)}, ${when(report.at)}.`
    : "Nothing yet."
  return `<main>
<h1>proton-keysync</h1>
<p class="muted">Signed in as ${esc(user)}. The addresses are the Worker's <code>ADDRESSES</code> secret; the key for each is whatever the source serves. This press: ${press}</p>
<form method="post" action="/run">
<button type="submit" name="action" value="status">Fetch status</button>
<button type="submit" name="action" value="dry">Dry run</button>
<button type="submit" name="action" value="sync" class="primary">Sync now</button>
</form>
<p class="help">Fetch status compares what each keyserver holds with the key the source serves, and changes nothing. Dry run adds what Sync now would do. Sync now pushes every key to every keyserver, then checks again, and asks keys.openpgp.org to mail you a verification link if the address is not verified there yet, every time.</p>
${
  addresses.length
    ? addresses.map((email) => section(email, report)).join("")
    : '\n<p class="bad-text">No addresses yet. Set the ADDRESSES secret on the Worker, comma-separated, and reload.</p>'
}
</main>`
}

export const page = (report: Report | null, addresses: string[], user: string): string =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>proton-keysync</title><style>${CSS}</style></head>
<body>${body(report, addresses, user)}</body></html>`
