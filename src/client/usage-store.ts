/**
 * Browser aggregate mirror used by the React surfaces.
 *
 * Since v0.6 the durable Host ledger is the source of truth. This store folds
 * its per-call rows into daily/provider/model buckets and keeps a debounced
 * localStorage mirror for fast startup and pre-v0.6 migration. The legacy
 * projection-delta path remains only so an older browser snapshot can be
 * exported safely during an upgrade.
 *
 * Aggregate cost is recalculated against the current price table. The call
 * detail surface can price exact ledger timestamps independently.
 */

import type {
  PricingTable,
  TokenUsageTotals,
  UsageDay,
  UsageDayModelBucket,
} from "../shared/usage.ts"
import type { LegacyUsageImportRow, UsageLedgerEntry, UsageSummaryBucket } from "../shared/ledger.ts"
import {
  USAGE_STORAGE_KEY,
  USAGE_HISTORY_DAYS,
  ZERO_USAGE,
  addUsage,
  diffUsage,
} from "../shared/usage.ts"
import {
  computeBucketCost,
  computeDeltaCost,
  resolvePriceAt,
} from "./pricing.ts"

/** One persisted snapshot. */
export interface UsageState {
  /** YYYY-MM-DD local date strings, sorted descending by date. */
  days: UsageDay[]
  /** Durable per-session projection baselines prevent replay double-counting. */
  baselines: Record<string, { model: string; provider: string; totals: TokenUsageTotals }>
}

/** Aggregate used by the panel. Computed from `state` on every read. */
export interface UsageAggregate {
  inCacheHit: number
  inCacheMiss: number
  cacheWrite: number
  out: number
  /** Total CNY cost across every model in this aggregation scope. */
  costCNY: number
  /** True when the current price table has a non-zero entry for the
   *  contributing model. false = we have tokens but no pricing yet, so
   *  cost is undefined. */
  hasPricing: boolean
}

/** One chronological point used by the in-panel usage chart. */
export interface UsageSeriesPoint {
  date: string
  aggregate: UsageAggregate
}

/** One provider/model row used by the 30-day breakdown. */
export interface UsageBreakdownItem {
  key: string
  provider: string
  model: string
  aggregate: UsageAggregate
}

/** Empty aggregate. */
export const ZERO_AGGREGATE: UsageAggregate = {
  inCacheHit: 0,
  inCacheMiss: 0,
  cacheWrite: 0,
  out: 0,
  costCNY: 0,
  hasPricing: false,
}

/** Storage abstraction so we can swap localStorage for an in-memory mock
 *  in tests. The runtime side just uses `globalThis.localStorage`. */
export interface UsageStorage {
  read(): string | null
  write(value: string): void
}

/** Default storage backed by `window.localStorage`. Safe to call in
 *  Node — guards against the missing global. */
export function defaultUsageStorage(): UsageStorage {
  return {
    read() {
      try {
        return typeof localStorage !== "undefined"
          ? localStorage.getItem(USAGE_STORAGE_KEY)
          : null
      } catch {
        return null
      }
    },
    write(value) {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(USAGE_STORAGE_KEY, value)
        }
      } catch {
        // localStorage may throw in private mode / when full; we
        // intentionally swallow so the UI keeps working.
      }
    },
  }
}

/** Compute the local `YYYY-MM-DD` for `ts` using the runtime timezone. */
export function localDateString(ts: number): string {
  // en-CA gives us ISO-style YYYY-MM-DD in the local timezone.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts))
}

function emptyBucket(): UsageDayModelBucket {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costCNY: 0,
  }
}

function readState(raw: string | null): UsageState {
  if (raw === null) return { days: [], baselines: {} }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return { days: [], baselines: {} }
    const obj = parsed as { days?: unknown; baselines?: unknown }
    if (!Array.isArray(obj.days)) return { days: [], baselines: {} }
    const days: UsageDay[] = []
    for (const d of obj.days) {
      if (typeof d !== "object" || d === null) continue
      const dd = d as { date?: unknown; byModel?: unknown }
      if (typeof dd.date !== "string") continue
      const byModel: Record<string, UsageDayModelBucket> = {}
      if (typeof dd.byModel === "object" && dd.byModel !== null) {
        for (const [k, v] of Object.entries(dd.byModel as Record<string, unknown>)) {
          if (typeof v !== "object" || v === null) continue
          const b = v as Partial<UsageDayModelBucket>
          byModel[k] = {
            uncachedInputTokens: numOr(b.uncachedInputTokens, 0),
            cacheReadTokens: numOr(b.cacheReadTokens, 0),
            cacheWriteTokens: numOr(b.cacheWriteTokens, 0),
            outputTokens: numOr(b.outputTokens, 0),
            costCNY: numOr(b.costCNY, 0),
          }
        }
      }
      days.push({ date: dd.date, byModel })
    }
    days.sort((a, b) => b.date.localeCompare(a.date))
    const baselines: UsageState["baselines"] = {}
    if (typeof obj.baselines === "object" && obj.baselines !== null) {
      for (const [scope, rawBaseline] of Object.entries(obj.baselines as Record<string, unknown>)) {
        if (typeof rawBaseline !== "object" || rawBaseline === null) continue
        const baseline = rawBaseline as { model?: unknown; provider?: unknown; totals?: unknown }
        if (typeof baseline.model !== "string" || typeof baseline.provider !== "string") continue
        const totals = readStoredTotals(baseline.totals)
        if (totals !== undefined) baselines[scope] = { model: baseline.model, provider: baseline.provider, totals }
      }
    }
    return { days, baselines }
  } catch {
    return { days: [], baselines: {} }
  }
}

function readStoredTotals(value: unknown): TokenUsageTotals | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const input = value as Partial<Record<keyof TokenUsageTotals, unknown>>
  return {
    uncachedInputTokens: numOr(input.uncachedInputTokens, 0),
    cacheReadTokens: numOr(input.cacheReadTokens, 0),
    cacheWriteTokens: numOr(input.cacheWriteTokens, 0),
    outputTokens: numOr(input.outputTokens, 0),
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function serializeState(state: UsageState): string {
  return JSON.stringify({ days: state.days, baselines: state.baselines })
}

function trimHistory(days: UsageDay[]): UsageDay[] {
  if (days.length <= USAGE_HISTORY_DAYS) return days
  return days.slice(0, USAGE_HISTORY_DAYS)
}

/** Compute an aggregate for the union of all day buckets (lifetime). */
export function aggregateLifetime(state: UsageState, table: PricingTable, now: () => number): UsageAggregate {
  return aggregateAll(state, table, now)
}

/** Compute today's aggregate. If `today` is undefined the current local
 *  date is used. */
export function aggregateToday(
  state: UsageState,
  table: PricingTable,
  now: () => number,
  today?: string,
): UsageAggregate {
  const key = today ?? localDateString(now())
  const day = state.days.find((d) => d.date === key)
  if (day === undefined) return { ...ZERO_AGGREGATE }
  return aggregateBucket(day.byModel, table, now)
}

/** Return a gap-free chronological series ending today. Missing days are
 * represented as zeroes so the chart does not visually compress quiet time. */
export function aggregateDaily(
  state: UsageState,
  table: PricingTable,
  now: () => number,
  count = 7,
): UsageSeriesPoint[] {
  const safeCount = Math.max(1, Math.min(USAGE_HISTORY_DAYS, Math.floor(count)))
  const byDate = new Map(state.days.map((day) => [day.date, day]))
  const anchor = new Date(now())
  anchor.setHours(12, 0, 0, 0)
  const points: UsageSeriesPoint[] = []
  for (let offset = safeCount - 1; offset >= 0; offset -= 1) {
    const cursor = new Date(anchor)
    cursor.setDate(anchor.getDate() - offset)
    const date = localDateString(cursor.getTime())
    const day = byDate.get(date)
    points.push({
      date,
      aggregate: day === undefined ? { ...ZERO_AGGREGATE } : aggregateBucket(day.byModel, table, now),
    })
  }
  return points
}

/** Aggregate the retained history by the exact billing-provider/model key. */
export function aggregateBreakdown(
  state: UsageState,
  table: PricingTable,
  now: () => number,
): UsageBreakdownItem[] {
  const merged: Record<string, UsageDayModelBucket> = {}
  for (const day of state.days) {
    for (const [key, bucket] of Object.entries(day.byModel)) {
      merged[key] = addBucket(merged[key], bucket)
    }
  }
  return Object.entries(merged)
    .map(([key, bucket]) => {
      const parsed = parseBucketKey(key)
      return {
        key,
        provider: parsed.provider,
        model: parsed.model,
        aggregate: aggregateBucket({ [key]: bucket }, table, now),
      }
    })
    .sort((a, b) => aggregateTokenCount(b.aggregate) - aggregateTokenCount(a.aggregate))
}

function aggregateAll(state: UsageState, table: PricingTable, now: () => number): UsageAggregate {
  const merged: Record<string, UsageDayModelBucket> = {}
  for (const day of state.days) {
    for (const [model, bucket] of Object.entries(day.byModel)) {
      merged[model] = addBucket(merged[model], bucket)
    }
  }
  return aggregateBucket(merged, table, now)
}

function addBucket(a: UsageDayModelBucket | undefined, b: UsageDayModelBucket): UsageDayModelBucket {
  if (a === undefined) return { ...b }
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costCNY: a.costCNY + b.costCNY,
  }
}

function aggregateBucket(
  byModel: Record<string, UsageDayModelBucket>,
  table: PricingTable,
  now: () => number,
): UsageAggregate {
  const agg: UsageAggregate = { ...ZERO_AGGREGATE }
  let hasPricing = false
  const nowTs = now()
  for (const [model, bucket] of Object.entries(byModel)) {
    agg.inCacheHit += bucket.cacheReadTokens
    agg.inCacheMiss += bucket.uncachedInputTokens
    agg.cacheWrite += bucket.cacheWriteTokens
    agg.out += bucket.outputTokens
    // Recompute cost live so peak/off-peak flips show immediately.
    const { prices } = resolvePriceAt(modelFromBucketKey(model), table, nowTs)
    const live = computeBucketCost(bucket, prices)
    agg.costCNY += live
    // Treat the bucket as priced if the price set has at least one non-zero entry.
    if (!hasPricing && (prices.inputCacheHitPerMTokCNY > 0 || prices.inputCacheMissPerMTokCNY > 0 || prices.outputPerMTokCNY > 0)) {
      hasPricing = true
    }
  }
  agg.hasPricing = hasPricing
  return agg
}

/** Listener invoked on any state change. */
export type UsageListener = (snapshot: { state: UsageState }) => void

/** Options for `UsageStore`. All optional; defaults match the runtime. */
export interface UsageStoreOptions {
  storage?: UsageStorage
  /** Override current time — defaults to `Date.now`. */
  now?: () => number
  /** Flush delay (ms). Defaults to 5000. */
  flushDelayMs?: number
  /** Reconcile check interval (ms). Defaults to 60000. */
  reconcileIntervalMs?: number
  /** Initial pricing table; can be replaced via `setPricing`. */
  pricing?: PricingTable
}

/**
 * The store class. Single instance per app; the client store wires one
 * up at plugin start.
 *
 * Lifecycle:
 *   const store = new UsageStore({ storage })
 *   store.setPricing(table)
 *   store.observeTokenUsage(currentTotals, currentModel)
 *   // ...
 *   store.dispose()
 */
export class UsageStore {
  private state: UsageState
  private storage: UsageStorage
  private now: () => number
  private listeners = new Set<UsageListener>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private flushDelayMs: number
  private reconcileIntervalMs: number

  /** Last `isPeak` we observed per model, so we can decide whether to
   *  recompute historical costs on each reconcile tick. */
  private pricing: PricingTable

  constructor(opts: UsageStoreOptions = {}) {
    this.storage = opts.storage ?? defaultUsageStorage()
    this.now = opts.now ?? Date.now
    this.flushDelayMs = opts.flushDelayMs ?? 5000
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? 60_000
    this.pricing = opts.pricing ?? {
      default: {
        inputCacheHitPerMTokCNY: 0,
        inputCacheMissPerMTokCNY: 0,
        outputPerMTokCNY: 0,
      },
      overrides: {},
      peakHours: {
        weekdays: [],
        windows: [],
        timezone: "Asia/Shanghai",
      },
    }
    this.state = readState(this.storage.read())
    if (opts.reconcileIntervalMs !== 0) {
      this.reconcileTimer = setInterval(() => this.reconcile(), this.reconcileIntervalMs)
      // Don't keep the process alive just for this.
      ;(this.reconcileTimer as { unref?: () => void }).unref?.()
    }
  }

  /** Replace the pricing table. Triggers a full cost reconcile. */
  setPricing(table: PricingTable): void {
    this.pricing = table
    this.reconcile()
    this.notify()
  }

  /** Read-only access to the raw state (test helper). */
  getState(): UsageState {
    return this.state
  }

  /** Read-only access to the current pricing table. */
  getPricing(): PricingTable {
    return this.pricing
  }

  /** Export the pre-v0.6 browser aggregates for a one-time Host migration. */
  exportLegacyRows(): LegacyUsageImportRow[] {
    const rows: LegacyUsageImportRow[] = []
    for (const day of this.state.days) {
      for (const [key, bucket] of Object.entries(day.byModel)) {
        const { provider, model } = parseBucketKey(key)
        rows.push({
          date: day.date,
          provider,
          model,
          tokens: {
            uncachedInputTokens: bucket.uncachedInputTokens,
            cacheReadTokens: bucket.cacheReadTokens,
            cacheWriteTokens: bucket.cacheWriteTokens,
            outputTokens: bucket.outputTokens,
          },
        })
      }
    }
    return rows
  }

  /** Replace the browser mirror with the Host's durable per-step ledger. */
  replaceFromLedger(entries: readonly UsageLedgerEntry[]): void {
    this.replaceFromSummary(entries.map((entry) => ({
      date: localDateString(entry.occurredAt),
      billingProvider: entry.billingProvider,
      model: entry.model,
      calls: 1,
      tokens: entry.tokens,
    })))
  }

  /** Replace the mirror from complete Host aggregates, independent of page size. */
  replaceFromSummary(buckets: readonly UsageSummaryBucket[]): void {
    const byDate = new Map<string, UsageDay>()
    for (const summary of buckets) {
      let day = byDate.get(summary.date)
      if (day === undefined) {
        day = { date: summary.date, byModel: {} }
        byDate.set(summary.date, day)
      }
      const key = bucketKey(summary.billingProvider, summary.model)
      const bucket = day.byModel[key] ?? emptyBucket()
      const merged = addUsage(bucket, summary.tokens)
      bucket.uncachedInputTokens = merged.uncachedInputTokens
      bucket.cacheReadTokens = merged.cacheReadTokens
      bucket.cacheWriteTokens = merged.cacheWriteTokens
      bucket.outputTokens = merged.outputTokens
      day.byModel[key] = bucket
    }
    this.state = {
      days: trimHistory([...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))),
      baselines: {},
    }
    this.reconcile()
    this.notify()
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: UsageListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Observe the latest `tokenUsage.totals` and the current model id.
   * Idempotent: passing the same totals twice is a no-op. If the totals
   * drop (rare; session restart with replay) we silently ignore negative
   * diffs thanks to `diffUsage`.
   *
   * Pass `null` model to indicate "no active session" — useful for
   * clearing the in-memory totals so we don't double-attribute on the
   * next session open.
   */
  observeTokenUsage(
    totals: TokenUsageTotals | undefined,
    model: string | null,
    scopeId = "legacy",
    provider = "unknown",
  ): void {
    if (totals === undefined || model === null) return
    const ts = this.now()
    const previous = this.state.baselines[scopeId]?.totals ?? ZERO_USAGE
    const delta = diffUsage(totals, previous)
    this.state.baselines[scopeId] = { model, provider, totals: { ...totals } }
    this.scheduleFlush()
    const allZero =
      delta.uncachedInputTokens === 0 &&
      delta.cacheReadTokens === 0 &&
      delta.cacheWriteTokens === 0 &&
      delta.outputTokens === 0
    if (allZero) return
    this.appendDelta(bucketKey(provider, model), delta, ts)
  }

  /** Force a reconcile right now (for tests). */
  reconcile(): void {
    const ts = this.now()
    for (const day of this.state.days) {
      for (const [model, bucket] of Object.entries(day.byModel)) {
        const { prices } = resolvePriceAt(modelFromBucketKey(model), this.pricing, ts, this.now)
        bucket.costCNY = computeBucketCost(bucket, prices)
      }
    }
    this.scheduleFlush()
  }

  /** Tear down timers + flush. */
  dispose(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    this.flushNow()
  }

  private appendDelta(model: string, delta: TokenUsageTotals, ts: number): void {
    const date = localDateString(ts)
    let day = this.state.days.find((d) => d.date === date)
    if (day === undefined) {
      day = { date, byModel: {} }
      this.state.days.unshift(day)
      this.state.days = trimHistory(this.state.days)
    }
    let bucket = day.byModel[model]
    if (bucket === undefined) {
      bucket = emptyBucket()
      day.byModel[model] = bucket
    }
    const merged = addUsage(
      {
        uncachedInputTokens: bucket.uncachedInputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        outputTokens: bucket.outputTokens,
      },
      delta,
    )
    bucket.uncachedInputTokens = merged.uncachedInputTokens
    bucket.cacheReadTokens = merged.cacheReadTokens
    bucket.cacheWriteTokens = merged.cacheWriteTokens
    bucket.outputTokens = merged.outputTokens
    const { prices } = resolvePriceAt(modelFromBucketKey(model), this.pricing, ts, this.now)
    bucket.costCNY += computeDeltaCost(delta, prices)
    this.scheduleFlush()
    this.notify()
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, this.flushDelayMs)
    ;(this.flushTimer as { unref?: () => void }).unref?.()
  }

  private flushNow(): void {
    this.state.days = trimHistory(this.state.days)
    this.storage.write(serializeState(this.state))
  }

  private notify(): void {
    const snap = { state: this.state }
    for (const fn of [...this.listeners]) fn(snap)
  }
}

function bucketKey(provider: string, model: string): string {
  if (provider === "unknown") return model
  return `${provider.replaceAll("::", ":")}::${model}`
}

function modelFromBucketKey(key: string): string {
  const separator = key.indexOf("::")
  return separator < 0 ? key : key.slice(separator + 2)
}

function parseBucketKey(key: string): { provider: string; model: string } {
  const separator = key.indexOf("::")
  return separator < 0
    ? { provider: "unknown", model: key }
    : { provider: key.slice(0, separator), model: key.slice(separator + 2) }
}

function aggregateTokenCount(value: UsageAggregate): number {
  return value.inCacheHit + value.inCacheMiss + value.cacheWrite + value.out
}
