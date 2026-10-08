// The page and its three buttons, served only to someone Cloudflare Access has signed in: the
// platform verifies the Access token and hands the identity to `ctx.access`, so there is
// nothing to validate here. With Access not enabled on the Worker, `ctx.access` is absent and
// every request gets a 403 rather than an open button. Nothing runs on its own and nothing
// is stored: a press answers with its own report.

import { page } from "./page"
import { addresses, type Env, type Mode, sync } from "./sync"

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
}

const MODES: Mode[] = ["status", "dry", "sync"]

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const user = (await ctx.access?.getIdentity())?.email
    if (!user) {
      return new Response("Cloudflare Access is not in front of this Worker; enable it first", {
        status: 403,
      })
    }
    const url = new URL(request.url)
    const list = addresses(env)
    if (request.method === "POST" && url.pathname === "/run") {
      // A browser names the page that submitted the form. Another site's page, carrying this
      // user's Access cookie, is refused: only this page presses these buttons.
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) {
        return new Response(
          `cross-site press: the browser says ${origin}, the page is ${url.origin}`,
          {
            status: 403,
          },
        )
      }
      const action = await request
        .formData()
        .then((form) => form.get("action"))
        .catch(() => null)
      const mode = MODES.find((m) => m === action)
      if (!mode) return new Response("unknown action", { status: 400 })
      const report = await sync(env, mode, user)
      return new Response(page(report, list, user), { headers: HEADERS })
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(page(null, list, user), { headers: HEADERS })
    }
    return new Response("not found", { status: 404 })
  },
}
