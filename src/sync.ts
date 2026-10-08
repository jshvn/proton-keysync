// A press of one of the page's buttons: read each address's current key from the source,
// compare it with what every keyserver holds, and on "sync" push it and confirm. The report
// of the press is rendered straight back; nothing is stored anywhere.
//
// The source is any HKP server. Proton's is the default: it serves the current key for every
// address it hosts, so it is the one place a key change shows up first, and whatever it
// serves is the truth once OpenPGP.js has read it and found every signature the key made on
// itself valid. What goes to the keyservers is that key as the library writes it, and a
// keyserver is current when its copy, read the same way, holds every packet that is the
// key's own.

import { type Key, readKey, readKeys, type SignaturePacket } from "openpgp"

export type Env = {
  SOURCE: string
  /**
   * The addresses to publish, comma-separated. A secret rather than a var, so it lives on
   * the Worker and never in the repository.
   */
  ADDRESSES?: string
  KEYSERVERS: string[]
}

/** The configured addresses, trimmed, in order, without blanks. */
export const addresses = (env: Env): string[] =>
  (env.ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

/** What a button does. `status` and `dry` write nothing anywhere. */
export type Mode = "status" | "dry" | "sync"

export type ServerState = "current" | "stale" | "missing" | "failed"
export type ServerResult = { state: ServerState; detail: string }

export type KeyReport = {
  email: string
  /** The fingerprint of the key the source serves, once it has been read. */
  fingerprint?: string
  pushed: boolean
  error?: string
  servers: Record<string, ServerResult>
}

export type Report = { at: string; mode: Mode; user: string; keys: KeyReport[] }

/**
 * The most a key may weigh to be read. A keyserver copy can be flooded with junk
 * certifications by anyone, and parsing megabytes of them is how a press would run out of
 * the Worker's CPU time; a flooded copy reports as failed instead.
 */
export const MAX_KEY_BYTES = 1 << 20

/** A null date makes the library skip its time checks; its types only name Date. */
const ANY_TIME = null as unknown as Date

type Signed = [SignaturePacket, object]

/**
 * What is the key's own: its material, its user IDs and subkeys, and every signature it made
 * on itself, each with the data that signature covers. Certifications by other keys are left
 * out: they are theirs to get right, and keyservers strip or add them on their own.
 */
const ownOf = (key: Key) => {
  const primary = key.keyPacket
  const id = primary.getKeyID()
  const own = (sigs: SignaturePacket[], over: object): Signed[] =>
    sigs.filter((s) => s.issuerKeyID.equals(id)).map((s) => [s, over])
  // The library keeps direct key signatures on the key but leaves them out of its types.
  const direct = (key as Key & { directSignatures?: SignaturePacket[] }).directSignatures ?? []
  const signed = [
    ...own([...key.revocationSignatures, ...direct], { key: primary }),
    ...key.users.flatMap((u) =>
      own([...u.selfCertifications, ...u.revocationSignatures], {
        userID: u.userID,
        userAttribute: u.userAttribute,
        key: primary,
      }),
    ),
    ...key.subkeys.flatMap((s) =>
      own([...s.bindingSignatures, ...s.revocationSignatures], { key: primary, bind: s.keyPacket }),
    ),
  ]
  const packets = [
    primary,
    ...key.users.flatMap((u) => u.userID ?? u.userAttribute ?? []),
    ...key.subkeys.map((s) => s.keyPacket),
    ...signed.map(([s]) => s),
  ]
  return { packets, signed }
}

/** A packet's identity for comparison: its bytes, as the library writes them. */
const identity = (p: { write(): Uint8Array }): string =>
  Array.from(p.write(), (b) => b.toString(16).padStart(2, "0")).join("")

/**
 * The source's key as a press carries it: read and verified, written out by the library,
 * and the identities of the packets that are its own.
 */
type Source = { key: Key; armored: string; own: Set<string> }

/**
 * The source's key, read and checked before it goes anywhere: a public key whose every
 * signature on itself verifies. A signature that fails is damage or forgery and stops the
 * press for the address. Revoked and expired are states a key can be in and are passed on:
 * no date and no revocation is judged.
 */
const verifyKey = async (armored: string): Promise<Key> => {
  const key = await readKey({ armoredKey: armored })
  if (key.isPrivate()) throw new Error("a private key")
  const { signed } = ownOf(key)
  if (signed.length === 0) throw new Error("no self-signatures")
  for (const [sig, over] of signed) {
    if (sig.signatureType === null) throw new Error("a signature without a type")
    await sig.verify(key.keyPacket, sig.signatureType, over, ANY_TIME)
  }
  return key
}

const lookup = (base: string, search: string) =>
  `${base}/pks/lookup?op=get&options=mr&search=${encodeURIComponent(search)}`

/** A response's status and body. The body is cut at the cap; a cut key is never read. */
const text = async (url: string): Promise<{ status: number; body: string; cut: boolean }> => {
  const res = await fetch(url)
  const body = await res.text()
  return {
    status: res.status,
    body: body.slice(0, MAX_KEY_BYTES),
    cut: body.length > MAX_KEY_BYTES,
  }
}

/** HKP submission, the same on Hockeypuck, SKS and Hagrid. */
const push = async (server: string, armored: string): Promise<number> => {
  const res = await fetch(`${server}/pks/add`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ keytext: armored }),
  })
  return res.status
}

/** What a server holds for the key, against the packets that are the key's own. */
const compare = async (server: string, source: Source): Promise<ServerResult> => {
  const { key, own } = source
  const fingerprint = key.getFingerprint()
  const got = await text(lookup(server, `0x${fingerprint}`))
  if (got.status === 404) return { state: "missing", detail: "not on this server" }
  if (got.cut) return { state: "failed", detail: "its copy is over 1 MiB, not compared" }
  if (got.status !== 200) return { state: "failed", detail: `lookup ${got.status}` }
  let held: Key | undefined
  try {
    const keys = await readKeys({ armoredKeys: got.body })
    held = keys.find((k) => k.getFingerprint() === fingerprint)
  } catch (err) {
    return { state: "failed", detail: `unreadable key: ${(err as Error).message}` }
  }
  if (!held) return { state: "missing", detail: "not on this server" }
  const have = new Set(held.toPacketList().map(identity))
  const missing = [...own].filter((h) => !have.has(h)).length
  return missing === 0
    ? { state: "current", detail: `holds all ${own.size} packets` }
    : { state: "stale", detail: `missing ${missing} of ${own.size} packets` }
}

/**
 * keys.openpgp.org publishes an address only after its owner clicks a verification mail,
 * and only its JSON endpoint can ask for that mail. Nothing remembers that it was asked, so
 * every Sync now before the click sends another mail. The report says so first.
 *
 * ponytail: recognised by hostname. Another Hagrid instance would need its own entry here.
 */
const verification = async (
  server: string,
  email: string,
  armored: string,
  mode: Mode,
): Promise<string> => {
  const byEmail = await fetch(`${server}/vks/v1/by-email/${encodeURIComponent(email)}`)
  if (byEmail.status === 200) return "address verified"
  if (byEmail.status !== 404) return `by-email ${byEmail.status}`
  if (mode === "status") return "address not verified"
  if (mode === "dry") return "would send the verification mail"
  const upload = await fetch(`${server}/vks/v1/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keytext: armored }),
  })
  const { token } = (await upload.json().catch(() => ({}))) as { token?: string }
  if (!token) return `upload ${upload.status}, no token`
  const verify = await fetch(`${server}/vks/v1/request-verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, addresses: [email] }),
  })
  return verify.ok ? "verification mail sent" : `request-verify ${verify.status}`
}

const isHagrid = (server: string) => new URL(server).hostname === "keys.openpgp.org"

/** One server, in one mode. Throws only on a network failure, which the caller reports. */
const serve = async (
  server: string,
  email: string,
  source: Source,
  mode: Mode,
): Promise<ServerResult> => {
  const { armored } = source
  let result: ServerResult
  if (mode === "sync") {
    const status = await push(server, armored)
    result =
      status >= 200 && status < 300
        ? await compare(server, source)
        : { state: "failed", detail: "" }
    result.detail = [`add ${status}`, result.detail].filter(Boolean).join(", ")
  } else {
    result = await compare(server, source)
    if (mode === "dry" && result.state !== "failed") result.detail += ", would push"
  }
  if (isHagrid(server) && result.state !== "failed") {
    result.detail += `, ${await verification(server, email, armored, mode)}`
  }
  return result
}

const syncKey = async (env: Env, email: string, mode: Mode): Promise<KeyReport> => {
  const report: KeyReport = { email, pushed: false, servers: {} }

  let got: Awaited<ReturnType<typeof text>>
  try {
    got = await text(lookup(env.SOURCE, email))
  } catch (err) {
    report.error = `source unreachable: ${(err as Error).message}`
    return report
  }
  if (got.status === 404) {
    report.error = `source get 404: no key for ${email}`
    return report
  }
  if (got.cut) {
    report.error = "the source's key is over 1 MiB, not read"
    return report
  }
  if (got.status !== 200) {
    report.error = `source get ${got.status}`
    return report
  }

  let key: Key
  try {
    key = await verifyKey(got.body)
  } catch (err) {
    report.error = `the source's key does not verify: ${(err as Error).message}`
    return report
  }
  report.fingerprint = key.getFingerprint().toUpperCase()
  const source: Source = {
    key,
    armored: key.armor(),
    own: new Set(ownOf(key).packets.map(identity)),
  }

  for (const server of env.KEYSERVERS) {
    if (mode === "sync") report.pushed = true
    report.servers[server] = await serve(server, email, source, mode).catch(
      (err: Error): ServerResult => ({ state: "failed", detail: `unreachable: ${err.message}` }),
    )
  }
  return report
}

/**
 * Every address against every keyserver. "sync" pushes everywhere, current or not: a push
 * of a key a server already holds is a no-op there, and the label promises a push.
 *
 * ponytail: subrequests are sequential and about 3 per server per address, inside the free
 * plan's 50 per invocation up to roughly 3 addresses on 4 servers. More would want batching
 * across presses.
 */
export const sync = async (env: Env, mode: Mode, user: string): Promise<Report> => {
  const keys: KeyReport[] = []
  for (const email of addresses(env)) keys.push(await syncKey(env, email, mode))
  return { at: new Date().toISOString(), mode, user, keys }
}
