/**
 * Wire-level data shapes shared by host and client.
 *
 * The Host produces QuotaSnapshots through Quota Adapters and serves them over
 * the /api/dsh-quota/* HTTP routes. The Client renders them through slot
 * components mounted in sidebar.footer.action and shell.overlay. Anything
 * upstream of these shapes is implementation detail.
 */

/** Stable id of a registered billing provider (e.g. "minimax-cn"). */
export type ProviderId = string

/** Aggregate status of one quota snapshot. */
export type QuotaStatus =
  | "ok"
  | "warning"
  | "exhausted"
  | "unsupported"
  | "not-configured"
  | "auth-error"
  | "rate-limited"
  | "network-error"
  | "error"

/** One money balance carried by the snapshot. */
export interface MoneyBalance {
  /** ISO 4217 currency code, e.g. "CNY", "USD". */
  currency: string
  /** Total balance for this currency (granted + toppedUp). */
  total: number
  /** Granted (free / promotional) part, when reported separately. */
  granted?: number
  /** Topped-up part, when reported separately. */
  toppedUp?: number
}

/** One quota window (e.g. "5-hour", "weekly"). */
export interface QuotaWindow {
  /** Stable id within a provider's response (e.g. "5h", "weekly"). */
  id: string
  /** Display label, e.g. "5-hour rolling window". */
  label: string
  /** 0..1 (1 == fully unused). */
  remainingRatio?: number
  /** 0..1 (1 == fully exhausted); one of remaining/used may be present. */
  usedRatio?: number
  /** Concrete remaining value (when the provider exposes raw counts). */
  remaining?: number
  /** Concrete total value (when the provider exposes raw counts). */
  total?: number
  /** Unit label for remaining/total (tokens, requests, dollars). */
  unit?: string
  /** ISO 8601 timestamp when the window resets. */
  resetAt?: string
  /** Seconds until the next reset, when available without a clock. */
  resetInSeconds?: number
}

/** What a provider exposes through its public API. */
export interface ProviderCapabilities {
  balance: boolean
  quota: boolean
  usage?: boolean
  /** DSH token/cost attribution is supported even though the provider has no
   * stable account endpoint that this plugin can query. */
  localAccounting?: boolean
}

/** Provider-reported spend summary, independent from DSH's local token meter. */
export interface ProviderUsageSummary {
  /** ISO currency used by the provider for the monetary fields. */
  currency: string
  /** Total spend attributed to the current credential. */
  total?: number
  daily?: number
  weekly?: number
  monthly?: number
  /** Optional credential-level spending limit and remaining amount. */
  limit?: number
  remaining?: number
  /** Human-readable reset cadence when the provider exposes one. */
  reset?: string
}

/** Quota snapshot as it travels over the wire to the browser. */
export interface QuotaSnapshot {
  providerId: ProviderId
  providerDisplayName: string
  /** The model vendor (e.g. "MiniMax"); separate from the billing provider. */
  modelVendor?: string
  /** The current DSH route provider (e.g. "openrouter"), when known. */
  routeProvider?: string
  /** The current model id, when known. */
  model?: string
  status: QuotaStatus
  /** Optional human-readable hint shown next to the status. */
  message?: string
  /** Currency balances (DeepSeek-style). */
  balances?: MoneyBalance[]
  /** Token Plan / quota windows (MiniMax-style). */
  quotas?: QuotaWindow[]
  /** Provider-side spend information (OpenRouter-style). */
  usage?: ProviderUsageSummary
  /** ISO 8601 timestamp of the most recent successful fetch. */
  fetchedAt: string
  /** True when the snapshot is older than the TTL or a refresh failed. */
  stale?: boolean
  capabilities: ProviderCapabilities
}

/** One provider entry returned by listQuotaProviders. */
export interface ProviderListItem {
  id: ProviderId
  displayName: string
  description?: string
  region?: string
  website?: string
  brandColor?: string
  capabilities?: ProviderCapabilities
  /** Whether the user has a credential for at least one of the adapter's refs. */
  configured: boolean
  /** Whether the adapter is enabled in plugin settings. */
  supported: boolean
  /** The latest snapshot's status, when the host has one. */
  status?: QuotaStatus
  /** When the user can fetch this provider (e.g. for OpenRouter today: always true). */
  canRefresh?: boolean
}

/** A resolved billing route: which provider actually charges for a session. */
export interface ResolvedBillingRoute {
  routeProvider: string
  billingProviderId: ProviderId
  modelVendor?: string
  model: string
  confidence: "exact" | "mapped" | "heuristic" | "unknown"
}

/** Snapshot of one current selection + resolved route. */
export interface CurrentQuotaResponse {
  selection?: {
    sessionId?: string
    provider: string
    model: string
    reasoningEffort?: string
  }
  resolved?: ResolvedBillingRoute
  /** Snapshot of the resolved billing provider (or a synthetic unsupported). */
  snapshot?: QuotaSnapshot
  /** Optional: previous successful snapshot kept visible when the latest refresh failed. */
  fallback?: QuotaSnapshot
}

/** RPC method names exposed under /api/dsh-quota. */
export const RPC_PATHS = {
  listProviders: "/api/dsh-quota/providers",
  getCurrent: "/api/dsh-quota/current",
  getProvider: "/api/dsh-quota/provider",
  refresh: "/api/dsh-quota/refresh",
  getSettings: "/api/dsh-quota/settings",
  getUsage: "/api/dsh-quota/usage",
  importUsage: "/api/dsh-quota/usage/import",
  backfillUsage: "/api/dsh-quota/usage/backfill",
  exportUsage: "/api/dsh-quota/usage/export",
} as const

/** Response of `/api/dsh-quota/settings`. Carries the pricing table the
 *  client uses to estimate CNY cost from token usage. */
export interface SettingsSnapshotResponse {
  /** Full pricing table for the current settings. The client may cache it
   *  in memory; the route re-validates against the live settings on each call. */
  pricing: import("./usage.ts").PricingTable
  refreshIntervalMs: number
  warningBalanceBelow: number
  warningQuotaRemainingBelow: number
  providerEnabled: Record<string, boolean>
}

/** Current browser session selection sent to the Host for route resolution. */
export interface SessionSelectionHint {
  sessionId?: string
  provider: string
  model: string
  reasoningEffort?: string
}
