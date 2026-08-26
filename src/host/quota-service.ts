/**
 * Quota Service — owns the cache, the in-flight de-duplication, and the
 * retry/backoff policy for every QuotaAdapter call.
 *
 * The service is the ONLY consumer of ctx.credentials.resolve() in the host
 * path. Adapters receive a narrow context that wraps the credential probe so
 * secrets never leak through other seams (logs, RPC errors, snapshots).
 *
 * Concurrency contract:
 *   - Concurrent calls to refresh(providerId) share the same Promise so
 *     the upstream API is hit at most once per provider while a refresh is
 *     in flight.
 *   - Cache entries are keyed by (providerId, credentialSourceHash) so a
 *     credential change invalidates the cache automatically — we never
 *     cache the resolved secret.
 */

import type { ProviderId, QuotaSnapshot } from "../shared/types.ts"
import { DEFAULT_REFRESH_INTERVAL_MS, ERROR_BACKOFF_MS } from "../shared/constants.ts"
import { sanitize } from "./adapters/base.ts"
import type { ProviderRegistry } from "./provider-registry.ts"
import type { QuotaAdapterContext } from "./adapters/base.ts"

export interface CredentialsServiceLike {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean } | undefined>
}

export interface QuotaServiceOptions {
  /** Cache TTL in milliseconds, or a live settings getter (defaults to 60s). */
  cacheTtlMs?: number | (() => number)
  /** Override now() for tests. */
  now?: () => number
  /** Override credential source hashing (for stable test keys). */
  hashSource?: (sources: readonly string[]) => string
  /** Live warning thresholds supplied by the settings owner. */
  thresholds?: () => { warningBalanceBelow: number; warningQuotaRemainingBelow: number }
}

interface CacheEntry {
  snapshot: QuotaSnapshot
  expiresAt: number
  /** Identity used to invalidate the cache when credentials rotate. */
  sourceHash: string
  /** Backoff applied to the next refresh after consecutive errors. */
  consecutiveErrors: number
  /** Timestamp after which a refresh is allowed again. */
  cooldownUntil: number
}

export class QuotaService {
  private readonly registry: ProviderRegistry
  private readonly credentials: CredentialsServiceLike
  private readonly cache = new Map<ProviderId, CacheEntry>()
  private readonly inFlight = new Map<ProviderId, Promise<QuotaSnapshot>>()
  private globalGeneration = 0
  private readonly providerGenerations = new Map<ProviderId, number>()
  private readonly ttl: () => number
  private readonly nowFn: () => number
  private readonly hashFn: (sources: readonly string[]) => string
  private readonly thresholds: () => { warningBalanceBelow: number; warningQuotaRemainingBelow: number }

  constructor(
    registry: ProviderRegistry,
    credentials: CredentialsServiceLike,
    options: QuotaServiceOptions = {},
  ) {
    this.registry = registry
    this.credentials = credentials
    const ttl = options.cacheTtlMs ?? DEFAULT_REFRESH_INTERVAL_MS
    this.ttl = typeof ttl === "function" ? ttl : () => ttl
    this.nowFn = options.now ?? Date.now
    this.hashFn = options.hashSource ?? defaultHash
    this.thresholds = options.thresholds ?? (() => ({ warningBalanceBelow: 10, warningQuotaRemainingBelow: 0.2 }))
  }

  /** Snapshot from cache without forcing a refresh; undefined when missing or stale. */
  cached(providerId: ProviderId): QuotaSnapshot | undefined {
    const entry = this.cache.get(providerId)
    if (entry === undefined) return undefined
    return withFreshness(entry.snapshot, entry.expiresAt, this.nowFn())
  }

  /**
   * Get a fresh snapshot. Concurrent calls share the in-flight Promise.
   * The cache is updated even on errors so a re-call sees the failure
   * instantly instead of triggering another remote request.
   */
  refresh(providerId: ProviderId, signal?: AbortSignal): Promise<QuotaSnapshot> {
    const existing = this.inFlight.get(providerId)
    if (existing !== undefined) return existing
    const generation = this.generation(providerId)
    const promise = this.doRefresh(providerId, generation, signal).finally(() => {
      if (this.inFlight.get(providerId) === promise) this.inFlight.delete(providerId)
    })
    this.inFlight.set(providerId, promise)
    return promise
  }

  /** Return a non-expired snapshot, otherwise perform one de-duplicated refresh. */
  getOrRefresh(providerId: ProviderId, signal?: AbortSignal): Promise<QuotaSnapshot> {
    const entry = this.cache.get(providerId)
    if (entry !== undefined && this.nowFn() < entry.expiresAt) {
      return Promise.resolve(entry.snapshot)
    }
    return this.refresh(providerId, signal)
  }

  /** Invalidate the cache (e.g. after a credentials/updated event). */
  invalidate(providerId?: ProviderId): void {
    if (providerId === undefined) {
      this.globalGeneration++
      this.cache.clear()
      this.inFlight.clear()
    } else {
      this.providerGenerations.set(providerId, (this.providerGenerations.get(providerId) ?? 0) + 1)
      this.cache.delete(providerId)
      this.inFlight.delete(providerId)
    }
  }

  /** Best-effort current snapshot, falling back to the last good value when the refresh failed. */
  async getWithFallback(providerId: ProviderId, signal?: AbortSignal, force = false): Promise<{
    snapshot: QuotaSnapshot
    fallback?: QuotaSnapshot
  }> {
    const previous = this.cache.get(providerId)?.snapshot
    try {
      const snap = force
        ? await this.refresh(providerId, signal)
        : await this.getOrRefresh(providerId, signal)
      if (previous !== undefined && isSuccessStatus(previous.status) && !isSuccessStatus(snap.status)) {
        return { snapshot: { ...snap, stale: true }, fallback: previous }
      }
      return { snapshot: snap }
    } catch (err) {
      if (previous !== undefined) {
        return {
          snapshot: { ...previous, stale: true },
          fallback: previous,
        }
      }
      throw err
    }
  }

  private async doRefresh(providerId: ProviderId, generation: string, signal?: AbortSignal): Promise<QuotaSnapshot> {
    const record = this.registry.get(providerId)
    if (record === undefined) {
      throw new Error(`Unknown provider "${providerId}"`)
    }
    if (!record.enabled) {
      return {
        providerId,
        providerDisplayName: record.displayName,
        status: "unsupported",
        message: `${record.displayName} is disabled in dsh-quota settings`,
        fetchedAt: new Date(this.nowFn()).toISOString(),
        capabilities: record.capabilities ?? { balance: false, quota: false },
      }
    }
    const entry = this.cache.get(providerId)
    if (entry !== undefined && this.nowFn() < entry.cooldownUntil) {
      return entry.snapshot
    }

    const sourceHash = await this._sourceHashForProvider(record.credentialRefs)
    if (entry !== undefined && entry.sourceHash !== sourceHash) {
      // Credentials rotated — drop the stale snapshot.
      this.cache.delete(providerId)
    }

    const ctx: QuotaAdapterContext = {
      providerId,
      probeCredential: async (ref) => (await this.credentials.describe(ref))?.configured ?? false,
      resolveSecret: async (ref) => {
        const hit = await this.credentials.resolve(ref)
        return hit?.value
      },
      signal,
    }
    const fetchedAt = new Date(this.nowFn()).toISOString()
    let rawSnapshot: QuotaSnapshot
    try {
      rawSnapshot = await record.adapter.fetch(ctx)
    } catch (err) {
      rawSnapshot = {
        providerId,
        providerDisplayName: record.displayName,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        fetchedAt,
        capabilities: { balance: false, quota: false },
      }
    }
    const snapshot = applyThresholds(sanitize(rawSnapshot) as QuotaSnapshot, this.thresholds())
    // A settings/credential reload may replace this provider while its old
    // request is still in flight. Never let that response repopulate the new
    // generation's cache.
    if (this.generation(providerId) === generation) this._store(providerId, snapshot, sourceHash)
    return snapshot
  }

  private generation(providerId: ProviderId): string {
    return `${this.globalGeneration}:${this.providerGenerations.get(providerId) ?? 0}`
  }

  private async _sourceHashForProvider(refs: readonly string[]): Promise<string> {
    const sources: string[] = []
    for (const ref of refs) {
      const info = await this.credentials.describe(ref)
      if (info?.configured) sources.push(`${ref}=${info.source ?? "?"}`)
    }
    return this.hashFn(sources)
  }

  private _store(providerId: ProviderId, snapshot: QuotaSnapshot, sourceHash: string): void {
    const previous = this.cache.get(providerId)
    const previousErrors = previous?.consecutiveErrors ?? 0
    const isError = snapshot.status === "error" ||
      snapshot.status === "network-error" ||
      snapshot.status === "rate-limited" ||
      snapshot.status === "auth-error"
    const consecutiveErrors = isError ? previousErrors + 1 : 0
    const cooldownIndex = Math.min(previousErrors, ERROR_BACKOFF_MS.length - 1)
    const cooldownMs = isError ? ERROR_BACKOFF_MS[cooldownIndex] ?? 0 : 0
    this.cache.set(providerId, {
      snapshot,
      sourceHash,
      consecutiveErrors,
      cooldownUntil: this.nowFn() + cooldownMs,
      expiresAt: this.nowFn() + Math.max(0, this.ttl()),
    })
  }

  /**
   * Probe configured state — exposed for the browser list endpoint so the UI
   * can render per-provider availability without exposing the credential value.
   */
  async probeConfigured(refs: readonly string[]): Promise<boolean> {
    for (const ref of refs) {
      const info = await this.credentials.describe(ref)
      if (info?.configured) return true
    }
    return false
  }
}

function withFreshness(snapshot: QuotaSnapshot, expiresAt: number, now: number): QuotaSnapshot {
  if (now >= expiresAt) {
    return { ...snapshot, stale: true }
  }
  return snapshot
}


function isSuccessStatus(s: string): boolean {
  return s === "ok" || s === "warning"
}

function applyThresholds(
  snapshot: QuotaSnapshot,
  thresholds: { warningBalanceBelow: number; warningQuotaRemainingBelow: number },
): QuotaSnapshot {
  if (snapshot.status !== "ok" && snapshot.status !== "warning" && snapshot.status !== "exhausted") return snapshot
  const ratios = (snapshot.quotas ?? [])
    .map((quota) => quota.remainingRatio)
    .filter((value): value is number => typeof value === "number")
  if (ratios.some((value) => value <= 0)) return { ...snapshot, status: "exhausted" }
  const balanceWarning = (snapshot.balances ?? []).some((balance) => balance.total < thresholds.warningBalanceBelow)
  const quotaWarning = ratios.some((value) => value <= thresholds.warningQuotaRemainingBelow)
  return { ...snapshot, status: balanceWarning || quotaWarning ? "warning" : "ok" }
}
function defaultHash(parts: readonly string[]): string {
  // Tiny stable string hash; collisions don't matter because we only use it
  // as a change-detection key.
  let h = 5381
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h = ((h << 5) + h + p.charCodeAt(i)) | 0
    }
  }
  return String(h)
}
