# proton-keysync

Pushes the OpenPGP keys Proton Mail serves for your addresses to public keyservers, from a
button. A Cloudflare Worker and nothing else: no storage, no schedule, and Cloudflare Access
in front of the one page that holds the buttons.

Proton is the source of truth. Whatever key Proton serves for an address is the key, and
Proton offers no push or change feed, so nothing here runs on its own. The page has three
buttons:

- **Fetch status** reads each address's current key from Proton's own key server and
  compares it with what every keyserver holds. It changes nothing anywhere.
- **Dry run** adds to that what Sync now would do. It also changes nothing.
- **Sync now** pushes every key to every keyserver, checks again, and, if keys.openpgp.org
  does not list the address yet, asks it to mail you a verification link.

Each press answers with its own report: the fingerprint the source serves and, per
keyserver, whether it holds the current key. "Current" means it has every packet that
matters from Proton's copy: the key material, the user IDs, and the signatures the key made
on itself. Keyservers strip or add certifications by other keys on their own, so those are
not counted.

## Where the addresses come from

The Worker's `ADDRESSES` secret, comma-separated, set once in the dashboard. A secret rather
than a config var so that the addresses live on the Worker and never in this repository,
and so that a deploy from the repository leaves them alone. The page shows them. The email
the page shows you signed in as is a different thing: that one comes from Cloudflare Access.

## Setup, once

1. Fork or clone. If you want other keyservers, change `KEYSERVERS` in
   `cloudflare.config.ts`.
2. In the Cloudflare dashboard, create the Worker from the repository: Workers & Pages,
   Create, connect the repository, and set the deploy command to `npx cf deploy`. Every push
   to `main` deploys from then on. By hand instead: `npm ci`, then `task deploy`, which reads a
   Cloudflare token and account id from the 1Password item `proton-keysync` (fields
   `cloudflare/token` and `cloudflare/account_id`) through the references in `op.env`.
3. On the Worker's Settings page, under Variables and Secrets, add a secret named
   `ADDRESSES` holding your addresses, comma-separated.
4. On the Worker's Access tab, protect all hostnames with a policy that allows your email.
   Until Access is on, every request gets a 403 and the buttons do not exist.
5. Open the Worker's URL. Fetch status, then Dry run, then Sync now. keys.openpgp.org mails
   you a verification link; click it, and the next Fetch status says so.

## Configuration

| Var | Meaning |
|---|---|
| `SOURCE` | An HKP server that serves your current keys. Proton's by default. |
| `ADDRESSES` | The addresses to publish, comma-separated. A secret on the Worker, not in the repo. |
| `KEYSERVERS` | Where to push. Hockeypuck and Hagrid take the same request; so does SKS. |

## Limits

- Nothing is remembered between presses, so a Sync now before you click the
  keys.openpgp.org link sends you another link. The report says "address not verified"
  first.
- The free plan allows 50 outbound requests per press; each address costs about three per
  keyserver, so a handful of addresses on a handful of servers fits.
- keys.openpgp.org answers lookups by email once a minute. A second press within a minute
  reports that instead of the verification state.
- A keyserver copy over 1 MiB is reported as failed rather than compared. Anyone can flood
  a key on a keyserver with junk certifications, and parsing megabytes of them is how a
  press would run out of the Worker's CPU time.

## Security

- Every request needs a Cloudflare Access identity, verified by the platform. There is no
  other way in, and no local-dev exception.
- A press is refused when the browser names another site as its origin, so a page
  elsewhere cannot press the buttons with your Access session.
- The page carries a Content Security Policy that allows only its own inline styles, no
  framing and no scripts. Everything rendered is escaped.
- The key the source serves is read and checked with OpenPGP.js before it is pushed or
  compared: it is one public key, and every signature it made on itself verifies. A key
  that fails is reported and goes nowhere. Whatever genuine key the source serves, revoked
  or expired included, is passed on as is.
- The Worker's one secret is the address list, and it stores nothing. The keys it pushes
  are whatever the source serves, so the source account is the thing to protect.

## Development

`task` prints the menu. `task check` is what CI runs: types, formatting, tests, and a
dry-run deploy. The Worker's logs are in the dashboard under its Logs tab.
