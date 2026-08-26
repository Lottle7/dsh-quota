/**
 * Token-usage & cost-estimation data shapes shared by client and host.
 *
 * The Host persists nothing about local-session token use — that data lives
 * entirely in DSH's session-projection `tokenUsage`, which the Client reads
 * through `ctx.sessions.currentProvideInfo`. The Client folds those projections
 * into per-day, per-model buckets and derives a CNY cost estimate using the
 * pricing table configured on the Host.
 *
 * Why shared with the Host: the Host owns the schemastery Config and must
 * know the wire shape of the pricing table to validate it before the Client
 * ever sees it. The Client keeps its own copy because it never imports the
 * Host module — both halves import from here.
 */

/**
 * The four disjoint token buckets DSH's `tokenUsage` projection publishes.
 *
 *   - uncachedInputTokens — fresh prompt tokens that hit the provider.
 *   - cacheReadTokens    — prompt tokens served from cache.
 *   - cacheWriteTokens   — prompt tokens written into cache (counted by the
 *                          provider at the same rate as uncached input on
 *                          same rate as uncached input by the current
 *                          estimator).
 *   - outputTokens       — completion tokens (includes reasoning).
 */
export interface TokenUsageTotals {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** Zero helper for diffing. */
export const ZERO_USAGE: TokenUsageTotals = {
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
}

/** Subtract `b` from `a` element-wise. Negative results clamp to 0
 *  (we should never observe a regression in `totals`, but if we ever do
 *  we silently drop the negative delta instead of corrupting the bucket). */
export function diffUsage(a: TokenUsageTotals, b: TokenUsageTotals): TokenUsageTotals {
  return {
    uncachedInputTokens: Math.max(0, a.uncachedInputTokens - b.uncachedInputTokens),
    cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
    cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  }
}

/** Sum element-wise. */
export function addUsage(a: TokenUsageTotals, b: TokenUsageTotals): TokenUsageTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/** Token totals for one model in one day bucket. Cost is recomputed on the
 *  fly whenever the price table changes (settings update OR peak/off-peak
 *  boundary crosses); the tokens themselves are append-only. */
export interface UsageDayModelBucket {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** CNY cost as last evaluated under the current pricing table. */
  costCNY: number
}

/** Per-day snapshot keyed by `YYYY-MM-DD` (local-time date string). */
export interface UsageDay {
  date: string
  /** Per-model-id bucket; absent models are zeroed by the reader. */
  byModel: Record<string, UsageDayModelBucket>
}

/** What the Host writes into settings (and what the Client reads back
 *  via the snapshot-render path). Costs are derived client-side using
 *  `pricing.ts`; the Host never computes cost. */
export interface PricingTable {
  /** Fallback prices used when no per-model override matches. */
  default: PriceSet
  /** Per-model-id overrides keyed by lowercase model id. */
  overrides: Record<string, PriceSet>
  /** Definition of the peak window. */
  peakHours: PeakHours
}

/** One provider's per-million-token price, in CNY. */
export interface PriceSet {
  /** CNY per 1,000,000 input tokens that hit the cache. */
  inputCacheHitPerMTokCNY: number
  /** CNY per 1,000,000 input tokens that missed the cache. We also bill
   *  cache writes at this rate by default — DeepSeek V4 pricing groups
   *  the two as "uncached input". */
  inputCacheMissPerMTokCNY: number
  /** CNY per 1,000,000 output tokens. */
  outputPerMTokCNY: number
}

/** Definition of the peak window. The peak/off-peak boundary is what drives
 *  the live cost recompute (see `pricing.ts`). */
export interface PeakHours {
  /** ISO-style three-letter weekdays. Empty array = every day is treated
   *  as a peak weekday (the windows still apply, weekend/off-hours logic
   *  is irrelevant). */
  weekdays: Weekday[]
  /** One or more HH:MM windows inside a weekday. */
  windows: { start: string; end: string }[]
  /** IANA timezone the windows apply in. Defaults to "Asia/Shanghai"
   *  because DeepSeek's published peak hours are defined in Beijing time. */
  timezone: string
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"

/** Convenient zero set. */
export const ZERO_PRICE: PriceSet = {
  inputCacheHitPerMTokCNY: 0,
  inputCacheMissPerMTokCNY: 0,
  outputPerMTokCNY: 0,
}

/** Hardcoded default prices for DeepSeek V4 models (peak-tier values).
 *  The user can override each line through settings; if they don't, we
 *  ship peak-hour defaults because most working hours land in peak.
 *  See README "Pricing" section. */
export const DEEPSEEK_V4_PEAK_PRICES: Record<string, PriceSet> = {
  "deepseek-v4-flash": {
    inputCacheHitPerMTokCNY: 0.10,
    inputCacheMissPerMTokCNY: 3.0,
    outputPerMTokCNY: 9.0,
  },
  "deepseek-v4-pro": {
    inputCacheHitPerMTokCNY: 0.30,
    inputCacheMissPerMTokCNY: 9.0,
    outputPerMTokCNY: 27.0,
  },
  "deepseek-v4-flash-vision-exp": {
    inputCacheHitPerMTokCNY: 0.10,
    inputCacheMissPerMTokCNY: 3.0,
    outputPerMTokCNY: 9.0,
  },
}

/** Pricing default for unknown / other models. Conservative peak-tier. */
export const DEFAULT_UNKNOWN_PRICE: PriceSet = {
  inputCacheHitPerMTokCNY: 0.10,
  inputCacheMissPerMTokCNY: 3.0,
  outputPerMTokCNY: 9.0,
}

/** Default peak-hours block (Beijing time, Mon–Fri 09:00–12:00 / 14:00–18:00).
 *  Mirrors the DeepSeek pricing page exactly. */
export const DEFAULT_PEAK_HOURS: PeakHours = {
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
  windows: [
    { start: "09:00", end: "12:00" },
    { start: "14:00", end: "18:00" },
  ],
  timezone: "Asia/Shanghai",
}

/** Versioned localStorage key. Bump when the schema changes in a way that
 *  would otherwise yield wrong numbers from old data. */
export const USAGE_STORAGE_KEY = "dsh-quota.usage.v2"

/** Browser-local UI preferences, deliberately separate from Host settings. */
export const PREFERENCES_STORAGE_KEY = "dsh-quota.preferences.v1"

/** Browser-local position and visibility of the always-on mini dashboard. */
export const FLOATING_PREFERENCES_STORAGE_KEY = "dsh-quota.floating-preferences.v1"

/** Browser-local cost budget thresholds and warning ratio. */
export const BUDGET_PREFERENCES_STORAGE_KEY = "dsh-quota.budget-preferences.v1"

/** Browser-local price overrides edited from the quota center. Prices are
 * not credentials, so keeping them in the browser preserves the Host-only
 * secret boundary while making third-party routes useful without YAML edits. */
export const LOCAL_PRICING_STORAGE_KEY = "dsh-quota.pricing-overrides.v1"

/** Maximum number of day buckets to keep in localStorage. Older days are
 *  trimmed on flush. 30 days is plenty for a personal quota UI. */
export const USAGE_HISTORY_DAYS = 30
