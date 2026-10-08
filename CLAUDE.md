# proton-keysync

A Cloudflare Worker that pushes the OpenPGP keys Proton serves to public keyservers when a
person presses a button. Free plan, built and deployed with `cf`; Workers Builds deploys
every push to `main`. `README.md` is for users. This file is the design.

## Constraints

- Runs on Cloudflare only: a Worker behind Access. No storage, no schedule, no other runtime,
  no local dev identity. Testing a change means deploying it and pressing Fetch status.
- One source of truth, Proton's HKP endpoint, and whatever it serves is the key. Nothing is
  pinned and nothing is remembered: a press reads, compares, maybe pushes, and answers.
- The source's key is read with OpenPGP.js before anything else happens with it, and every
  signature the key made on itself must verify. Revoked and expired keys pass; a signature
  that fails ends the press for that address with no push. What goes to a keyserver is
  that key as the library writes it.
- A keyserver is current when its copy, read the same way, holds every packet that is the
  key's own: material, user IDs, subkeys, and the signatures the key made on itself.
  Certifications by other keys are not counted.
- Three modes, one code path: `status` and `dry` write nothing; `sync` pushes everywhere,
  then compares.
- Every request needs an identity from Cloudflare Access (`ctx.access`), which the platform
  verifies. Without Access on the Worker, the Worker serves 403. A press also needs the
  browser's Origin, when present, to be the page's own.
- A fetched key is cut at 1 MiB and then reported as failed, never parsed. A server that
  cannot be reached is reported as failed; it never fails the press.

## The files

- `src/sync.ts` -- a press: read, verify, compare, push, confirm, report. All network and
  all key handling in one file.
- `src/page.ts` -- the HTML, rendered from a press's report. `body` and `CSS` are exported
  so a preview can be rendered outside the Worker.
- `src/index.ts` -- the `fetch` handler: the page, the three buttons, the Access and
  Origin checks, the response headers.
- `test/sync.test.ts` -- the sync and the handler against stubbed fetch, with keys
  OpenPGP.js generates.
- `cloudflare.config.ts` -- the Worker and the vars, evaluated by `cf`. The addresses are
  not here: they are the `ADDRESSES` secret on the Worker, so no address is in the repo.
- `vite.config.ts` -- hands the build to Cloudflare's plugin; `vitest.config.ts` keeps the
  tests under plain Node.

## Checks

`task check`: `cf workers types`, `tsc`, Biome formatting, Vitest, `cf deploy --dry-run`.
