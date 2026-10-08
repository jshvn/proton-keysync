// The three buttons against a fake source and fake keyservers: what each reads, what each
// pushes, what each reports. Every outbound request goes through `calls`, so a test asserts
// on the wire. The keys are made by OpenPGP.js: the source's copy verifies, and the keyserver
// copies are the same key with more or less on it.

import * as openpgp from "openpgp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import worker from "../src/index"
import { addresses, type Env, MAX_KEY_BYTES, sync } from "../src/sync"

const EMAIL = "josh@example.org"
const USER = "me@example.org"
const SOURCE = "https://source.test"
const HAGRID = "https://keys.openpgp.org"
const HOCKEYPUCK = "https://hockeypuck.test"
const SITE = "https://w.test"

const born = await openpgp.generateKey({
  type: "curve25519",
  userIDs: [{ email: EMAIL }],
  format: "object",
})
const grown = await born.privateKey.addSubkey({})
/** The key: primary, user ID, self-certification, two subkeys and their bindings. */
const KEY = grown.toPublic()
const FPR = KEY.getFingerprint().toUpperCase()
/** How many packets are the key's own: all of them, since nobody else has signed it. */
const N = KEY.toPacketList().length
/** A current copy: the key as it is. */
const CURRENT_KEY = KEY.armor()
/** A stale copy: the key before its second subkey. */
const STALE_KEY = born.publicKey.armor()
const someone = await openpgp.generateKey({
  type: "curve25519",
  userIDs: [{ email: "someone@example.org" }],
  format: "object",
})
/** What the source serves: the key with a certification by someone else on it. */
const SOURCE_KEY = (await KEY.signAllUsers([someone.privateKey])).armor()
/** The key with one bit flipped in its last signature. */
const DAMAGED_KEY = await (async () => {
  const b = Uint8Array.from(KEY.write())
  const last = b.length - 1
  b[last] = (b[last] ?? 0) ^ 1
  return (await openpgp.readKey({ binaryKey: b })).armor()
})()

const env = (over: Partial<Env> = {}): Env => ({
  SOURCE,
  ADDRESSES: EMAIL,
  KEYSERVERS: [HAGRID, HOCKEYPUCK],
  ...over,
})

let calls: { url: string; method: string }[]
/** Per-test overrides keyed by URL prefix; the default answers like healthy, current servers. */
let answers: Record<string, () => Response>

const route = (url: string): Response => {
  for (const [prefix, answer] of Object.entries(answers))
    if (url.startsWith(prefix)) return answer()
  if (url.startsWith(SOURCE) && url.includes("op=get")) return new Response(SOURCE_KEY)
  if (url.includes("op=get")) return new Response(CURRENT_KEY)
  if (url.endsWith("/pks/add")) return new Response("ok")
  if (url.includes("/vks/v1/by-email/")) return new Response("verified")
  return new Response("unexpected", { status: 500 })
}

beforeEach(() => {
  calls = []
  answers = {}
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method ?? "GET" })
    return route(url)
  })
})
afterEach(() => vi.unstubAllGlobals())

const posts = () => calls.filter((c) => c.method === "POST").map((c) => c.url)

describe("addresses", () => {
  it("reads the ADDRESSES secret as a trimmed list, and an unset one as none", () => {
    expect(addresses({ ADDRESSES: ` ${EMAIL}, ${USER} ,,` } as Env)).toEqual([EMAIL, USER])
    expect(addresses({} as Env)).toEqual([])
  })
})

describe("fetch status", () => {
  it("says which servers hold the current key, and posts nothing", async () => {
    answers[`${HOCKEYPUCK}/pks/lookup?op=get`] = () => new Response(STALE_KEY)
    answers["https://gone.test/pks/lookup?op=get"] = () => new Response("", { status: 404 })
    const report = await sync(
      env({ KEYSERVERS: [HAGRID, HOCKEYPUCK, "https://gone.test"] }),
      "status",
      USER,
    )
    expect(posts()).toEqual([])
    const key = report.keys[0]
    expect(key?.fingerprint).toBe(FPR)
    expect(key?.pushed).toBe(false)
    expect(key?.servers[HAGRID]).toEqual({
      state: "current",
      detail: `holds all ${N} packets, address verified`,
    })
    expect(key?.servers[HOCKEYPUCK]).toEqual({
      state: "stale",
      detail: `missing 2 of ${N} packets`,
    })
    expect(key?.servers["https://gone.test"]).toEqual({
      state: "missing",
      detail: "not on this server",
    })
  })

  it("reports an address the source has no key for", async () => {
    answers[`${SOURCE}/pks/lookup?op=get`] = () => new Response("", { status: 404 })
    const report = await sync(env(), "status", USER)
    expect(calls.map((c) => c.url).every((u) => u.startsWith(SOURCE))).toBe(true)
    expect(report.keys[0]?.fingerprint).toBeUndefined()
    expect(report.keys[0]?.error).toMatch(/no key for/)
  })

  it("reports a server it cannot reach, and one whose copy is too big, without failing the press", async () => {
    answers[`${HOCKEYPUCK}/pks/lookup?op=get`] = () => {
      throw new Error("connect timeout")
    }
    answers["https://flooded.test/pks/lookup?op=get"] = () =>
      new Response(`${CURRENT_KEY}${"x".repeat(MAX_KEY_BYTES)}`)
    const report = await sync(
      env({ KEYSERVERS: [HOCKEYPUCK, "https://flooded.test"] }),
      "status",
      USER,
    )
    expect(report.keys[0]?.servers[HOCKEYPUCK]).toEqual({
      state: "failed",
      detail: "unreachable: connect timeout",
    })
    expect(report.keys[0]?.servers["https://flooded.test"]?.detail).toMatch(/over 1 MiB/)
  })

  it("reports a source it cannot reach", async () => {
    answers[SOURCE] = () => {
      throw new Error("dns")
    }
    const report = await sync(env(), "status", USER)
    expect(report.keys[0]?.error).toBe("source unreachable: dns")
  })
})

describe("dry run", () => {
  it("adds what a sync would do, and still posts nothing", async () => {
    answers[`${HAGRID}/vks/v1/by-email/`] = () => new Response("", { status: 404 })
    const report = await sync(env(), "dry", USER)
    expect(posts()).toEqual([])
    expect(report.keys[0]?.servers[HAGRID]?.detail).toBe(
      `holds all ${N} packets, would push, would send the verification mail`,
    )
    expect(report.keys[0]?.servers[HOCKEYPUCK]?.detail).toBe(`holds all ${N} packets, would push`)
  })
})

describe("sync now", () => {
  it("pushes everywhere, then checks again", async () => {
    const report = await sync(env(), "sync", USER)
    expect(posts()).toEqual([`${HAGRID}/pks/add`, `${HOCKEYPUCK}/pks/add`])
    expect(report.keys[0]?.pushed).toBe(true)
    expect(report.keys[0]?.servers[HOCKEYPUCK]).toEqual({
      state: "current",
      detail: `add 200, holds all ${N} packets`,
    })
  })

  it("asks keys.openpgp.org for the verification mail while the address is unverified", async () => {
    answers[`${HAGRID}/vks/v1/by-email/`] = () => new Response("", { status: 404 })
    answers[`${HAGRID}/vks/v1/upload`] = () => Response.json({ key_fpr: FPR, token: "tok" })
    answers[`${HAGRID}/vks/v1/request-verify`] = () => Response.json({})
    const report = await sync(env(), "sync", USER)
    expect(report.keys[0]?.servers[HAGRID]?.detail).toMatch(/verification mail sent/)
    expect(posts()).toContain(`${HAGRID}/vks/v1/request-verify`)
  })

  it("reports a server that refused the push", async () => {
    answers[`${HOCKEYPUCK}/pks/add`] = () => new Response("no", { status: 500 })
    const report = await sync(env(), "sync", USER)
    expect(report.keys[0]?.servers[HOCKEYPUCK]).toEqual({ state: "failed", detail: "add 500" })
    expect(report.keys[0]?.servers[HAGRID]?.state).toBe("current")
  })
})

describe("the source's key", () => {
  it("is refused, and nothing pushed, when a signature fails or the body is not a key", async () => {
    answers[`${SOURCE}/pks/lookup?op=get`] = () => new Response(DAMAGED_KEY)
    let report = await sync(env(), "sync", USER)
    expect(report.keys[0]?.error).toBe(
      "the source's key does not verify: Signature verification failed",
    )
    expect(report.keys[0]?.servers).toEqual({})
    answers[`${SOURCE}/pks/lookup?op=get`] = () => new Response("<html>not a key</html>")
    report = await sync(env(), "sync", USER)
    expect(report.keys[0]?.error).toMatch(/does not verify/)
    expect(report.keys[0]?.fingerprint).toBeUndefined()
    expect(posts()).toEqual([])
  })

  it("is passed on when revoked", async () => {
    const { publicKey } = await openpgp.revokeKey({
      key: KEY,
      revocationCertificate: born.revocationCertificate,
      format: "armored",
    })
    answers[`${SOURCE}/pks/lookup?op=get`] = () => new Response(publicKey)
    const report = await sync(env(), "sync", USER)
    expect(report.keys[0]?.error).toBeUndefined()
    expect(posts()).toEqual([`${HAGRID}/pks/add`, `${HOCKEYPUCK}/pks/add`])
  })
})

describe("fetch handler", () => {
  const ctx = (email?: string) =>
    ({
      access: email ? { aud: "x", getIdentity: async () => ({ email }) } : undefined,
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    }) as unknown as ExecutionContext

  const press = (action: string, headers: Record<string, string> = {}) =>
    new Request(`${SITE}/run`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ action }),
    })

  it("serves nothing without an Access identity", async () => {
    const res = await worker.fetch(new Request(`${SITE}/`), env(), ctx())
    expect(res.status).toBe(403)
  })

  it("asks for the ADDRESSES secret when there is none", async () => {
    const res = await worker.fetch(
      new Request(`${SITE}/`),
      env({ ADDRESSES: undefined }),
      ctx(USER),
    )
    expect(await res.text()).toContain("Set the ADDRESSES secret")
  })

  it("lists the addresses before a press and answers a press with its report", async () => {
    const e = env()
    const home = await worker.fetch(new Request(`${SITE}/`), e, ctx(USER))
    expect(home.status).toBe(200)
    expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    // "no-referrer" would make the browser send `Origin: null` on the page's own presses.
    expect(home.headers.get("referrer-policy")).toBe("same-origin")
    const before = await home.text()
    expect(before).toContain(EMAIL)
    expect(before).toContain("Press a button")
    const status = await worker.fetch(press("status", { origin: SITE }), e, ctx(USER))
    expect(status.status).toBe(200)
    const after = await status.text()
    expect(after).toContain(`Fetch status by ${USER}`)
    expect(after).toContain(FPR)
    expect(after).toContain("current")
    expect(posts()).toEqual([])
    expect((await worker.fetch(press("sync"), e, ctx(USER))).status).toBe(200)
    expect(posts()).toHaveLength(2)
  })

  it("refuses a press from another site, an unknown action, and a body it cannot read", async () => {
    const e = env()
    const foreign = await worker.fetch(press("sync", { origin: "https://evil.test" }), e, ctx(USER))
    expect(foreign.status).toBe(403)
    expect((await worker.fetch(press("nope"), e, ctx(USER))).status).toBe(400)
    const junk = new Request(`${SITE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect((await worker.fetch(junk, e, ctx(USER))).status).toBe(400)
    expect(posts()).toEqual([])
  })
})
