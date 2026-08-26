/**
 * Hardened adapter for user-defined billing providers.
 *
 * Custom endpoints are deliberately narrow: one public HTTPS GET request,
 * one credential reference, fixed authentication modes and numeric JSON-path
 * mappings. The transport resolves and pins a public address so DNS rebinding,
 * redirects and private-network access cannot turn this feature into SSRF.
 */

import { lookup } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import type { QuotaAdapter, QuotaAdapterContext } from "./base.ts"
import { pickCredential, statusFromHttp } from "./base.ts"
import type {
  MoneyBalance,
  ProviderCapabilities,
  ProviderUsageSummary,
  QuotaSnapshot,
  QuotaWindow,
} from "../../shared/types.ts"

export type CustomProviderKind = "local" | "http-json"
export type CustomProviderAuth = "bearer" | "x-api-key" | "none"

export interface CustomProviderConfig {
  id: string
  displayName: string
  kind?: CustomProviderKind
  description?: string
  region?: string
  website?: string
  brandColor?: string
  routeAliases?: string[]
  modelVendors?: string[]
  endpoint?: string
  credentialRef?: string
  auth?: CustomProviderAuth
  balancePath?: string
  usagePath?: string
  limitPath?: string
  remainingPath?: string
  currency?: string
  valueScale?: number
}

export interface NormalizedCustomProviderConfig {
  id: string
  displayName: string
  kind: CustomProviderKind
  description: string
  region?: string
  website?: string
  brandColor?: string
  routeAliases: string[]
  modelVendors: string[]
  endpoint?: string
  credentialRef?: string
  auth: CustomProviderAuth
  balancePath?: string
  usagePath?: string
  limitPath?: string
  remainingPath?: string
  currency: string
  valueScale: number
}

export interface CustomJsonRequest {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
}

export interface CustomJsonResponse {
  status: number
  ok: boolean
  text: string
  truncated: boolean
}

export type CustomJsonTransport = (request: CustomJsonRequest) => Promise<CustomJsonResponse>

const PROVIDER_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const CREDENTIAL_REF_RE = /^[A-Z][A-Z0-9_]{2,127}$/
const CURRENCY_RE = /^[A-Z]{3}$/
const COLOR_RE = /^#[0-9a-f]{6}$/i
const PATH_SEGMENT_RE = /^(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*)$/
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"])
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_BYTES = 256 * 1024

export function normalizeCustomProviderConfig(input: CustomProviderConfig): NormalizedCustomProviderConfig {
  const id = input.id.trim().toLowerCase()
  if (!PROVIDER_ID_RE.test(id)) {
    throw new Error("id must be 1-63 lowercase letters, digits or hyphens")
  }
  const displayName = input.displayName.trim()
  if (displayName.length === 0 || displayName.length > 80) {
    throw new Error("displayName must contain 1-80 characters")
  }
  const kind = input.kind ?? "local"
  if (kind !== "local" && kind !== "http-json") throw new Error("kind must be local or http-json")
  const description = normalizeOptionalText(input.description, 160)
    ?? (kind === "local" ? "Local Token and price accounting" : "Custom HTTPS JSON billing endpoint")
  const region = normalizeOptionalText(input.region, 40)
  const website = normalizeWebsite(input.website)
  const brandColor = normalizeColor(input.brandColor)
  const routeAliases = normalizeNames([id, ...(input.routeAliases ?? [])], "routeAliases")
  const modelVendors = normalizeNames(input.modelVendors ?? [], "modelVendors")
  const currency = (input.currency ?? "USD").trim().toUpperCase()
  if (!CURRENCY_RE.test(currency)) throw new Error("currency must be a three-letter ISO code")
  const valueScale = input.valueScale ?? 1
  if (!Number.isFinite(valueScale) || valueScale <= 0 || valueScale > 1_000_000_000) {
    throw new Error("valueScale must be greater than 0 and no more than 1000000000")
  }

  if (kind === "local") {
    return {
      id, displayName, kind, description, region, website, brandColor,
      routeAliases, modelVendors, auth: "none", currency, valueScale,
    }
  }

  const endpoint = validateCustomEndpointUrl(input.endpoint ?? "").toString()
  const auth = input.auth ?? "bearer"
  if (auth !== "bearer" && auth !== "x-api-key" && auth !== "none") {
    throw new Error("auth must be bearer, x-api-key or none")
  }
  const credentialRef = input.credentialRef?.trim()
  if (auth !== "none" && (credentialRef === undefined || !CREDENTIAL_REF_RE.test(credentialRef))) {
    throw new Error("credentialRef must be an uppercase DSH credential reference")
  }
  if (auth === "none" && credentialRef !== undefined && credentialRef.length > 0) {
    throw new Error("credentialRef is not allowed when auth is none")
  }
  const balancePath = normalizeJsonPath(input.balancePath)
  const usagePath = normalizeJsonPath(input.usagePath)
  const limitPath = normalizeJsonPath(input.limitPath)
  const remainingPath = normalizeJsonPath(input.remainingPath)
  if ([balancePath, usagePath, limitPath, remainingPath].every((value) => value === undefined)) {
    throw new Error("at least one numeric response path must be configured")
  }
  return {
    id, displayName, kind, description, region, website, brandColor,
    routeAliases, modelVendors, endpoint,
    credentialRef: auth === "none" ? undefined : credentialRef,
    auth, balancePath, usagePath, limitPath, remainingPath, currency, valueScale,
  }
}

/** Validate cross-entry identity and route-alias ownership before settings commit. */
export function normalizeCustomProviderSet(
  inputs: readonly CustomProviderConfig[],
  reservedIds: ReadonlySet<string> = new Set(),
  reservedAliases: ReadonlySet<string> = new Set(),
): NormalizedCustomProviderConfig[] {
  const ids = new Set(reservedIds)
  const aliases = new Set(reservedAliases)
  const normalized: NormalizedCustomProviderConfig[] = []
  for (const input of inputs) {
    const entry = normalizeCustomProviderConfig(input)
    if (ids.has(entry.id)) throw new Error(`custom provider id "${entry.id}" is already registered`)
    const aliasCollision = entry.routeAliases.find((alias) => aliases.has(alias))
    if (aliasCollision !== undefined) throw new Error(`custom provider route alias "${aliasCollision}" is already registered`)
    ids.add(entry.id)
    for (const alias of entry.routeAliases) aliases.add(alias)
    normalized.push(entry)
  }
  return normalized
}

export function createCustomJsonAdapter(
  config: NormalizedCustomProviderConfig,
  transport: CustomJsonTransport = secureJsonGet,
): QuotaAdapter {
  if (config.kind !== "http-json" || config.endpoint === undefined) {
    throw new Error("createCustomJsonAdapter requires an http-json configuration")
  }
  const endpoint = config.endpoint
  const credentialRefs = config.credentialRef === undefined ? [] : [config.credentialRef]
  const capabilities: ProviderCapabilities = {
    balance: config.balancePath !== undefined || config.remainingPath !== undefined,
    quota: config.limitPath !== undefined,
    usage: config.usagePath !== undefined,
  }
  return {
    id: config.id,
    displayName: config.displayName,
    credentialRefs,
    supported: true,
    async fetch(ctx: QuotaAdapterContext): Promise<QuotaSnapshot> {
      const fetchedAt = new Date().toISOString()
      let credential: string | undefined
      if (config.credentialRef !== undefined) {
        credential = (await pickCredential(credentialRefs, ctx))?.value
        if (credential === undefined) {
          return result(config, "not-configured", "The configured credential reference has no value", fetchedAt, capabilities)
        }
      }
      const headers: Record<string, string> = { accept: "application/json" }
      if (config.auth === "bearer") headers.authorization = `Bearer ${credential ?? ""}`
      if (config.auth === "x-api-key") headers["x-api-key"] = credential ?? ""

      let response: CustomJsonResponse
      try {
        response = await transport({ url: endpoint, headers, signal: ctx.signal })
      } catch (error) {
        return result(
          config,
          "network-error",
          /abort|timeout/i.test(error instanceof Error ? error.message : "")
            ? "Custom provider request timed out"
            : "Custom provider network request failed",
          fetchedAt,
          capabilities,
        )
      }
      if (!response.ok) {
        const status = response.status < 200 || (response.status >= 300 && response.status < 400)
          ? "error"
          : statusFromHttp(response.status)
        const message = status === "auth-error"
          ? "Authentication failed for the configured credential reference"
          : status === "rate-limited"
            ? "Custom provider rate-limited this request"
            : `HTTP ${response.status}`
        return result(config, status, message, fetchedAt, capabilities)
      }
      if (response.truncated) {
        return result(config, "error", "Custom provider response exceeded 256 KiB", fetchedAt, capabilities)
      }

      let body: unknown
      try { body = JSON.parse(response.text) } catch {
        return result(config, "error", "Malformed JSON response", fetchedAt, capabilities)
      }
      const balance = mappedNumber(body, config.balancePath, config.valueScale)
      const usageTotal = mappedNumber(body, config.usagePath, config.valueScale)
      const limit = mappedNumber(body, config.limitPath, config.valueScale)
      const explicitRemaining = mappedNumber(body, config.remainingPath, config.valueScale)
      const remaining = explicitRemaining
        ?? (limit !== undefined && usageTotal !== undefined ? Math.max(0, limit - usageTotal) : undefined)
      if ([balance, usageTotal, limit, remaining].every((value) => value === undefined)) {
        return result(config, "error", "Configured response paths did not contain numeric values", fetchedAt, capabilities)
      }

      const balances: MoneyBalance[] | undefined = balance !== undefined
        ? [{ currency: config.currency, total: balance }]
        : remaining !== undefined
          ? [{ currency: config.currency, total: remaining }]
          : undefined
      const usage: ProviderUsageSummary | undefined = usageTotal !== undefined || limit !== undefined || remaining !== undefined
        ? { currency: config.currency, total: usageTotal, limit, remaining }
        : undefined
      const quotas: QuotaWindow[] | undefined = limit !== undefined && limit > 0 && remaining !== undefined
        ? [{
            id: "custom-limit",
            label: "Account limit",
            remaining,
            total: limit,
            unit: config.currency,
            remainingRatio: Math.max(0, Math.min(1, remaining / limit)),
          }]
        : undefined
      return {
        providerId: config.id,
        providerDisplayName: config.displayName,
        status: "ok",
        balances,
        usage,
        quotas,
        fetchedAt,
        capabilities,
      }
    },
  }
}

function result(
  config: NormalizedCustomProviderConfig,
  status: QuotaSnapshot["status"],
  message: string,
  fetchedAt: string,
  capabilities: ProviderCapabilities,
): QuotaSnapshot {
  return { providerId: config.id, providerDisplayName: config.displayName, status, message, fetchedAt, capabilities }
}

function mappedNumber(root: unknown, path: string | undefined, scale: number): number | undefined {
  if (path === undefined) return undefined
  const value = readJsonPath(root, path)
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : NaN
  if (!Number.isFinite(numeric)) return undefined
  const scaled = numeric * scale
  return Number.isFinite(scaled) ? scaled : undefined
}

export function readJsonPath(root: unknown, path: string): unknown {
  let current = root
  for (const segment of path.split(".")) {
    if (UNSAFE_PATH_SEGMENTS.has(segment) || current === null || typeof current !== "object") return undefined
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined
      current = current[Number(segment)]
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function normalizeJsonPath(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (path === undefined || path.length === 0) return undefined
  const segments = path.split(".")
  if (segments.length > 16 || path.length > 256 || segments.some((segment) => !PATH_SEGMENT_RE.test(segment) || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error("response paths must be safe dot-separated JSON paths")
  }
  return segments.join(".")
}

function normalizeNames(values: readonly string[], field: string): string[] {
  const out = new Set<string>()
  for (const value of values) {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) continue
    if (normalized.length > 80 || !/^[a-z0-9][a-z0-9._:/-]*$/.test(normalized)) {
      throw new Error(`${field} contains an invalid value`)
    }
    out.add(normalized)
  }
  if (out.size > 64) throw new Error(`${field} cannot contain more than 64 values`)
  return [...out]
}

function normalizeOptionalText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim()
  if (normalized === undefined || normalized.length === 0) return undefined
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("custom provider text is invalid")
  return normalized
}

function normalizeWebsite(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (normalized === undefined || normalized.length === 0) return undefined
  if (normalized.length > 2048) throw new Error("website must be a valid HTTPS URL")
  let url: URL
  try { url = new URL(normalized) } catch { throw new Error("website must be a valid HTTPS URL") }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new Error("website must be a valid HTTPS URL")
  }
  return url.toString()
}

function normalizeColor(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (normalized === undefined || normalized.length === 0) return undefined
  if (!COLOR_RE.test(normalized)) throw new Error("brandColor must use #RRGGBB")
  return normalized.toLowerCase()
}

export function validateCustomEndpointUrl(value: string): URL {
  if (value.length === 0 || value.length > 2048) throw new Error("endpoint must be a valid public HTTPS URL")
  let url: URL
  try { url = new URL(value) } catch { throw new Error("endpoint must be a valid public HTTPS URL") }
  if (
    url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 ||
    url.hash.length > 0 || url.search.length > 0 || (url.port.length > 0 && url.port !== "443") ||
    url.hostname.length === 0 || url.hostname.toLowerCase() === "localhost"
  ) {
    throw new Error("endpoint must be a public HTTPS URL on port 443")
  }
  const literal = stripIpv6Brackets(url.hostname)
  if (isIP(literal) !== 0 && !isPublicAddress(literal)) {
    throw new Error("endpoint cannot target a private or reserved address")
  }
  return url
}

export function isPublicAddress(address: string): boolean {
  const value = stripIpv6Brackets(address).toLowerCase()
  const family = isIP(value)
  if (family === 4) {
    const octets = value.split(".").map(Number)
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    const [a, b, c] = octets as [number, number, number, number]
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (family !== 6) return false
  if (value.startsWith("::")) return false // unspecified, loopback and IPv4-compatible/mapped forms
  const first = Number.parseInt(value.split(":")[0] || "0", 16)
  if (first < 0x2000 || first > 0x3fff) return false // current global-unicast allocation (2000::/3)
  if (value.startsWith("2001:db8:") || value === "2001:db8::") return false
  return true
}

async function secureJsonGet(request: CustomJsonRequest): Promise<CustomJsonResponse> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const url = validateCustomEndpointUrl(request.url)
  const hostname = stripIpv6Brackets(url.hostname)
  const literalFamily = isIP(hostname)
  const addresses = literalFamily === 0
    ? await lookupWithDeadline(hostname, timeoutMs, request.signal)
    : [{ address: hostname, family: literalFamily }]
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Custom provider endpoint did not resolve to public addresses")
  }
  const pinned = addresses[0]
  if (pinned === undefined) throw new Error("Custom provider endpoint did not resolve")
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES
  const remainingMs = Math.max(1, deadline - Date.now())

  return await new Promise<CustomJsonResponse>((resolve, reject) => {
    let settled = false
    const finishReject = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const req = httpsRequest(url, {
      method: "GET",
      headers: request.headers,
      ...(literalFamily === 0 ? { servername: hostname } : {}),
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family as 4 | 6),
    }, (response) => {
      const status = response.statusCode ?? 0
      const chunks: Buffer[] = []
      let total = 0
      let truncated = false
      response.on("data", (chunk: Buffer | Uint8Array | string) => {
        if (truncated) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const remaining = maxBytes - total
        if (buffer.length > remaining) {
          if (remaining > 0) chunks.push(buffer.subarray(0, remaining))
          total = maxBytes
          truncated = true
          settled = true
          resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString("utf8"), truncated: true })
          response.destroy()
          return
        }
        chunks.push(buffer)
        total += buffer.length
      })
      response.on("end", () => {
        if (settled) return
        settled = true
        resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString("utf8"), truncated })
      })
      response.on("close", () => {
        if (!settled && truncated) {
          settled = true
          resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString("utf8"), truncated: true })
        }
      })
      response.on("error", finishReject)
    })
    const deadlineTimer = setTimeout(() => req.destroy(new Error("timeout")), remainingMs)
    req.on("error", finishReject)
    const abort = (): void => { req.destroy(new Error("aborted")) }
    if (request.signal?.aborted) abort()
    else request.signal?.addEventListener("abort", abort, { once: true })
    req.on("close", () => {
      clearTimeout(deadlineTimer)
      request.signal?.removeEventListener("abort", abort)
    })
    req.end()
  })
}

async function lookupWithDeadline(
  hostname: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Array<{ address: string; family: number }>> {
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: Array<{ address: string; family: number }>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (error !== undefined) reject(error)
      else resolve(value ?? [])
    }
    const abort = (): void => finish(new Error("aborted"))
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs)
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
    void lookup(hostname, { all: true, verbatim: true }).then(
      (addresses) => finish(undefined, addresses),
      () => finish(new Error("DNS lookup failed")),
    )
  })
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "")
}
