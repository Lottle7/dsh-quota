/** Same-origin HTTP surface from the browser bundle to the Host. */

import type { IncomingMessage, ServerResponse } from "node:http"
import { resolveBillingRoute, type ModelSelectionLike } from "./route-resolver.ts"
import { unsupportedSnapshot } from "./route-resolver.ts"
import type { ProviderRegistry } from "./provider-registry.ts"
import type { QuotaService } from "./quota-service.ts"
import { RPC_PATHS } from "../shared/types.ts"
import type { CurrentQuotaResponse, QuotaSnapshot, SessionSelectionHint } from "../shared/types.ts"
import type { PricingTable } from "../shared/usage.ts"
import { sanitize } from "./adapters/base.ts"
import { REDACTED_MARKER } from "../shared/constants.ts"

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const

export interface QuotaRoutesDeps {
  registry: ProviderRegistry
  service: QuotaService
  /** Exact plugin routes do not inherit the standard /api prefix trust fence. */
  isTrustedRequest?: (req: IncomingMessage) => boolean
  isEnabled?: () => boolean
  getSettings?: () => QuotaSettingsSnapshot
}

export interface QuotaSettingsSnapshot {
  refreshIntervalMs: number
  warningBalanceBelow: number
  warningQuotaRemainingBelow: number
  routeMappings: Record<string, string>
  providerEnabled: Record<string, boolean>
  pricing?: PricingTable
}

const DEFAULT_SETTINGS: QuotaSettingsSnapshot = {
  refreshIntervalMs: 60_000,
  warningBalanceBelow: 10,
  warningQuotaRemainingBelow: 0.2,
  routeMappings: {},
  providerEnabled: {},
}

export function makeQuotaRoutes(deps: QuotaRoutesDeps): {
  routes: Array<{ kind: "exact"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }>
} {
  const trusted = deps.isTrustedRequest ?? (() => true)
  const route = (
    path: string,
    method: "GET" | "POST",
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ) => ({
    kind: "exact" as const,
    path,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(trusted, req, res) || !methodGuard(req, res, method)) return
      if (deps.isEnabled?.() === false) {
        writeJson(res, 503, { error: "dsh-quota is disabled" })
        return
      }
      if (method === "POST" && !jsonPostGuard(req, res)) return
      try { await handler(req, res) } catch (error) {
        writeJson(res, 500, { error: redactErrorMessage(error) })
      }
    },
  })

  return {
    routes: [
      route(RPC_PATHS.listProviders, "GET", async (_req, res) => {
        const items = await deps.registry.list(
          { configured: (ref) => deps.service.probeConfigured([ref]) },
          { status: (id) => deps.service.cached(id)?.status },
        )
        writeJson(res, 200, { providers: sanitize(items) })
      }),
      route(RPC_PATHS.getCurrent, "GET", async (req, res) => {
        writeJson(res, 200, sanitize(await readCurrent(deps, selectionFromRequest(req), false)))
      }),
      route(RPC_PATHS.getProvider, "GET", async (req, res) => {
        const id = requestUrl(req).searchParams.get("id") ?? ""
        if (!knownProvider(deps, id, res)) return
        const { snapshot, fallback } = await deps.service.getWithFallback(id)
        writeJson(res, 200, sanitize({ snapshot, fallback }))
      }),
      route(RPC_PATHS.refresh, "POST", async (req, res) => {
        const id = requestUrl(req).searchParams.get("id")
        if (id !== null) {
          if (!knownProvider(deps, id, res)) return
          const { snapshot, fallback } = await deps.service.getWithFallback(id, undefined, true)
          writeJson(res, 200, sanitize({ snapshot, fallback }))
          return
        }
        writeJson(res, 200, sanitize(await readCurrent(deps, selectionFromRequest(req), true)))
      }),
      route(RPC_PATHS.getSettings, "GET", async (_req, res) => {
        const settings = deps.getSettings?.() ?? DEFAULT_SETTINGS
        writeJson(res, 200, {
          pricing: settings.pricing ?? zeroPricing(),
          refreshIntervalMs: settings.refreshIntervalMs,
          warningBalanceBelow: settings.warningBalanceBelow,
          warningQuotaRemainingBelow: settings.warningQuotaRemainingBelow,
          providerEnabled: settings.providerEnabled,
        })
      }),
    ],
  }
}

async function readCurrent(
  deps: QuotaRoutesDeps,
  selection: SessionSelectionHint | undefined,
  force: boolean,
): Promise<CurrentQuotaResponse> {
  if (selection === undefined) return { snapshot: emptySnapshot() }
  const settings = deps.getSettings?.() ?? DEFAULT_SETTINGS
  const resolved = resolveBillingRoute(selection, {
    registry: deps.registry.asResolverView(),
    explicitMappings: settings.routeMappings,
  })
  if (resolved.billingProviderId === "unknown") {
    return { selection, resolved, snapshot: unsupportedSnapshot(resolved, new Date().toISOString()) }
  }
  const record = deps.registry.get(resolved.billingProviderId)
  if (record === undefined || !record.enabled) {
    return { selection, resolved, snapshot: unsupportedSnapshot(resolved, new Date().toISOString()) }
  }
  const { snapshot, fallback } = await deps.service.getWithFallback(resolved.billingProviderId, undefined, force)
  return {
    selection,
    resolved,
    snapshot: withProviderMeta(snapshot, record.displayName, resolved, selection),
    fallback,
  }
}

function selectionFromRequest(req: IncomingMessage): SessionSelectionHint | undefined {
  const search = requestUrl(req).searchParams
  const provider = cleanParam(search.get("provider"), 160)
  const model = cleanParam(search.get("model"), 320)
  if (provider === undefined || model === undefined) return undefined
  const sessionId = cleanParam(search.get("sessionId"), 160)
  const reasoningEffort = cleanParam(search.get("reasoningEffort"), 80)
  return { provider, model, ...(sessionId === undefined ? {} : { sessionId }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

function cleanParam(value: string | null, maxLength: number): string | undefined {
  if (value === null) return undefined
  const clean = value.trim()
  if (clean.length === 0 || clean.length > maxLength || /[\u0000-\u001f]/.test(clean)) return undefined
  return clean
}

function withProviderMeta(
  snapshot: QuotaSnapshot,
  displayName: string,
  resolved: { modelVendor?: string; routeProvider?: string; model: string },
  selection: ModelSelectionLike,
): QuotaSnapshot {
  return {
    ...snapshot,
    providerDisplayName: displayName,
    modelVendor: resolved.modelVendor ?? snapshot.modelVendor,
    routeProvider: resolved.routeProvider ?? selection.provider,
    model: resolved.model ?? selection.model,
  }
}

function emptySnapshot(): QuotaSnapshot {
  return {
    providerId: "unknown",
    providerDisplayName: "No active session",
    status: "unsupported",
    message: "Open a session to follow its billing provider, or choose one manually.",
    fetchedAt: new Date().toISOString(),
    capabilities: { balance: false, quota: false },
  }
}

function zeroPricing(): PricingTable {
  return {
    default: { inputCacheHitPerMTokCNY: 0, inputCacheMissPerMTokCNY: 0, outputPerMTokCNY: 0 },
    overrides: {},
    peakHours: { weekdays: [], windows: [], timezone: "Asia/Shanghai" },
  }
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost")
}

function knownProvider(deps: QuotaRoutesDeps, id: string, res: ServerResponse): boolean {
  const record = deps.registry.get(id)
  if (record === undefined) {
    writeJson(res, 404, { error: "unknown provider" })
    return false
  }
  if (!record.enabled) {
    writeJson(res, 409, { error: "provider disabled" })
    return false
  }
  return true
}

function guard(trusted: (req: IncomingMessage) => boolean, req: IncomingMessage, res: ServerResponse): boolean {
  if (trusted(req)) return true
  writeJson(res, 403, { error: "untrusted request" })
  return false
}

function methodGuard(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if ((req.method ?? "GET").toUpperCase() === method) return true
  res.setHeader("allow", method)
  writeJson(res, 405, { error: `method ${req.method ?? "GET"} not allowed` })
  return false
}

function jsonPostGuard(req: IncomingMessage, res: ServerResponse): boolean {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType === "application/json") return true
  writeJson(res, 415, { error: "content type must be application/json" })
  return false
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function redactErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/[A-Za-z0-9_\-]{32,}/g, REDACTED_MARKER)
}
