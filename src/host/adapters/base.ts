/**
 * Base QuotaAdapter contract.
 *
 * Each billing provider owns one adapter. Adapters receive a narrow
 * QuotaAdapterContext (no real credentials ever leave the host) and produce
 * one normalized QuotaSnapshot.
 *
 * Adapters must NEVER throw for expected conditions; map them to status:
 *   - 401 / 403 → "auth-error"
 *   - 404 / not implemented → "unsupported"
 *   - 429 → "rate-limited"
 *   - timeout / DNS / TCP → "network-error"
 *   - malformed body → "error"
 *   - empty credential → "not-configured"
 *
 * Adapters MUST NOT log raw credentials, Authorization headers, or full
 * error stacks that may carry the request config. sanitize() in this file
 * strips them before the snapshot or error reaches any log or RPC payload.
 */

import type { QuotaSnapshot } from "../../shared/types.ts"
import { REDACTED_MARKER } from "../../shared/constants.ts"

export interface QuotaAdapterContext {
  /** The billing provider id (for logging that must remain redaction-safe). */
  readonly providerId: string
  /**
    * Probe whether a credential reference has a value, without returning the
    * value itself. Adapters that need the real key must declare so via
    * needCredential() and receive it through resolveSecret().
    */
  readonly probeCredential: (ref: string) => Promise<boolean>
  /**
    * Resolve one credential reference to its value. This is the ONLY way
    * adapters ever see a secret, and the value must never be returned in
    * the snapshot or any error message.
    */
  readonly resolveSecret: (ref: string) => Promise<string | undefined>
  readonly signal?: AbortSignal
}

export interface QuotaAdapter {
  /** Stable billing provider id. */
  readonly id: string
  /** Display name surfaced to the user. */
  readonly displayName: string
  /** Default credential refs this adapter knows how to consume, in priority order. */
  readonly credentialRefs: readonly string[]
  /** Whether this adapter can produce live snapshots in this build. */
  readonly supported: boolean
  /**
    * Produce one fresh snapshot. Adapters should not throw — they return a
    * snapshot whose status encodes the failure mode (see module docstring).
    */
  fetch(ctx: QuotaAdapterContext): Promise<QuotaSnapshot>
}

/**
 * Deep-clone and string-sanitize any value the adapter wants to surface.
 * Replaces every credential-shaped string with [redacted] so a stray
 * Authorization header cannot escape via a future field we forgot to
 * blacklist.
 */
export function sanitize(value: unknown): unknown {
  return walk(value)
}

function walk(value: unknown): unknown {
  if (typeof value === "string") {
    // Any non-empty string that looks like a bearer token gets replaced.
    // We are conservative — better to over-redact than leak.
    if (looksLikeSecret(value)) return REDACTED_MARKER
    return value
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|token|api[-_]?key|authorization|password|passphrase)/i.test(k)) {
        out[k] = REDACTED_MARKER
        continue
      }
      out[k] = walk(v)
    }
    return out
  }
  return undefined
}

/** 0..100 (or higher with weekly boost) → 0..1. */
export function pctToRatio(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined
  const r = v / 100
  if (r < 0) return 0
  if (r > 1) return 1
  return r
}

/** Convert epoch ms to ISO timestamp. */
export function epochMsToIso(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined
  try { return new Date(ms).toISOString() } catch { return undefined }
}

/** Format epoch ms as remaining time (e.g. "3h 49m"). */
export function formatRemainMs(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  const parts: string[] = []
  if (d > 0) parts.push(d + "d")
  if (h > 0) parts.push(h + "h")
  if (m > 0 || parts.length === 0) parts.push(m + "m")
  return parts.join(" ")
}

function looksLikeSecret(value: string): boolean {
  // Match common credential prefixes (sk-…, ghp_…, etc.) anywhere in the string.
  if (/\b(sk-|ghp_|sk_live_|sk_test_|xoxb-|xoxp-|AIza)[A-Za-z0-9_-]{8,}/.test(value)) return true
  // Match long opaque tokens (32+ chars, no whitespace) anywhere in the string.
  if (/[A-Za-z0-9_-]{32,}/.test(value)) return true
  return false
}

/** Build the common fetch envelope with timeout + max body size + sanitize. */
export interface SafeFetchOptions {
  url: string
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}

export interface SafeFetchResult {
  status: number
  ok: boolean
  headers: Headers
  text: string
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_BYTES = 256 * 1024

export async function safeFetch(opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs)
  const outer = opts.signal
  const forwardAbort = (): void => controller.abort(outer?.reason)
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason)
    else outer.addEventListener("abort", forwardAbort, { once: true })
  }
  try {
    const res = await fetch(opts.url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      redirect: "manual", // never carry Authorization across a redirect
      signal: controller.signal,
    })
    const reader = res.body?.getReader()
    if (reader === undefined) {
      const text = await res.text()
      return { status: res.status, ok: res.ok, headers: res.headers, text, truncated: false }
    }
    let total = 0
    let truncated = false
    const chunks: Uint8Array[] = []
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        truncated = true
        chunks.push(next.value.subarray(0, Math.max(0, maxBytes - (total - next.value.byteLength))))
        try { await reader.cancel() } catch { /* ignore */ }
        break
      }
      chunks.push(next.value)
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8")
    return { status: res.status, ok: res.ok, headers: res.headers, text, truncated }
  } finally {
    clearTimeout(timeout)
    outer?.removeEventListener("abort", forwardAbort)
  }
}

/** Convenience: classify an HTTP status into a QuotaStatus hint. */
export function statusFromHttp(httpStatus: number, networkError?: boolean): import("../../shared/types.ts").QuotaStatus {
  if (networkError) return "network-error"
  if (httpStatus === 401 || httpStatus === 403) return "auth-error"
  if (httpStatus === 404) return "unsupported"
  if (httpStatus === 429) return "rate-limited"
  if (httpStatus >= 500) return "error"
  if (httpStatus >= 400) return "error"
  return "ok"
}

/**
 * First credential ref that actually resolves to a value, or undefined.
 * Adapters call this at the very start of fetch().
 */
export async function pickCredential(
  refs: readonly string[],
  ctx: QuotaAdapterContext,
): Promise<{ ref: string; value: string } | undefined> {
  for (const ref of refs) {
    const value = await ctx.resolveSecret(ref)
    if (value !== undefined && value.length > 0) return { ref, value }
  }
  return undefined
}
