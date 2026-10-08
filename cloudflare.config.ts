// The Worker and its vars. `cf deploy` reads this and `cf workers types` derives the Env
// types from it. No storage, nothing on a schedule, and one secret: the addresses.

import { bindings, defineConfig } from "cf/config"

export default defineConfig({
  worker: {
    name: "proton-keysync",
    compatibilityDate: "2026-10-01",
    entrypoint: "src/index.ts",
    // The one URL the Worker answers on. Access protects it; there are no preview URLs to
    // protect as well.
    workersDev: true,
    previewUrls: false,
    observability: { enabled: true },
    env: {
      // An HKP server that serves the current key for each address. Proton's is the default,
      // and whatever it serves is the truth: the page shows the fingerprint before any push.
      SOURCE: bindings.text("https://api.protonmail.ch"),
      // The addresses to publish, comma-separated. A secret, set on the Worker in the
      // dashboard, so that it lives there and not in this repository.
      ADDRESSES: bindings.secret(),
      // Where the key goes. Hockeypuck and Hagrid take the same submission. keyserver.ubuntu.com
      // gossips with nobody outside Canonical; pgpkeys.eu seeds its own peers.
      KEYSERVERS: bindings.json([
        "https://keys.openpgp.org",
        "https://keyserver.ubuntu.com",
        "https://pgpkeys.eu",
      ]),
    },
  },
})
