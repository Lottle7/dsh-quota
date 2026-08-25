/**
 * Pricing resolver — pure functions only, no I/O, no DOM.
 *
 * Takes a model id and a timestamp, returns the price set that should be
 * applied to token deltas observed at that moment. Peak vs off-peak is
 * resolved against `PeakHours` (Beijing time by default — DeepSeek
 * publishes peak hours in Beijing time regardless of where the user sits).
 *
 * The two functions exported here are the only ones the rest of the plugin
 * needs. Everything else (window parsing, weekday lookup) is internal.
 */

import type {
  PriceSet,
  PricingTable,
  PeakHours,
  Weekday,
} from "../shared/usage.ts"
import {
  DEEPSEEK_V4_PEAK_PRICES,
  DEFAULT_UNKNOWN_PRICE,
} from "../shared/usage.ts"

/**
 * Resolve the price set for one model and one moment.
 *
 * Lookup order:
 *   1. table.overrides[lowercase(model)]   (user override wins)
 *   2. DEEPSEEK_V4_PEAK_PRICES[lowercase(model)]  (built-in)
 *   3. table.default                          (fallback the user can override)
 *   4. DEFAULT_UNKNOWN_PRICE                  (last-resort built-in)
 *
 * The peak/off-peak status of the moment is reported separately via
 * `resolvePriceAt`, which also returns a synthetic "off-peak" price set
 * with half the input/output rates if the moment is off-peak (DeepSeek
 * V4 pricing is literally half during off-peak).
 */
export function resolvePriceFor(model: string, table: PricingTable): PriceSet {
  const key = model.toLowerCase()
  const override = table.overrides[key]
  if (override !== undefined) return override
  const built = DEEPSEEK_V4_PEAK_PRICES[key]
  if (built !== undefined) return built
  return table.default
}

/** Returns the price set that should be applied at one moment. If the
 *  moment falls inside a peak window, returns the (peak) price set
 *  unchanged. If the moment is off-peak, returns a copy with all rates
 *  halved (DeepSeek's published convention — off-peak is exactly 50%). */
export function resolvePriceAt(
  model: string,
  table: PricingTable,
  ts: number,
  now: () => number = Date.now,
): { prices: PriceSet; isPeak: boolean } {
  const base = resolvePriceFor(model, table)
  // An empty schedule means "no time-of-day pricing", not "permanent
  // off-peak". The previous behaviour silently halved every configured
  // price in the default configuration and made estimates misleading.
  if (table.peakHours.windows.length === 0) return { prices: base, isPeak: false }
  const isPeak = isPeakMoment(ts, table.peakHours, now)
  if (isPeak) return { prices: base, isPeak: true }
  return {
    prices: {
      inputCacheHitPerMTokCNY: base.inputCacheHitPerMTokCNY / 2,
      inputCacheMissPerMTokCNY: base.inputCacheMissPerMTokCNY / 2,
      outputPerMTokCNY: base.outputPerMTokCNY / 2,
    },
    isPeak: false,
  }
}

/**
 * Test whether `ts` (epoch ms) falls inside a peak window defined by
 * `peakHours`. The decision is made entirely in the timezone named by
 * `peakHours.timezone` — we never silently use the user's local time
 * because DeepSeek publishes their peak hours in Beijing time regardless
 * of where the user is.
 *
 * If `peakHours.weekdays` is empty, every day is treated as a peak
 * weekday (the windows still gate peak/off-peak inside the day).
 *
 * If `peakHours.windows` is empty, every moment is treated as off-peak
 * (this is the safe degenerate case if the user disables all windows).
 */
export function isPeakMoment(
  ts: number,
  peakHours: PeakHours,
  _now: () => number = Date.now,
): boolean {
  const win = peakHours.windows
  if (win.length === 0) return false
  const weekday = weekdayInZone(ts, peakHours.timezone)
  const isPeakDay = peakHours.weekdays.length === 0
    ? true
    : peakHours.weekdays.includes(weekday)
  if (!isPeakDay) return false
  const minute = minuteOfDayInZone(ts, peakHours.timezone)
  for (const w of win) {
    const start = parseHHMM(w.start)
    const end = parseHHMM(w.end)
    if (start === null || end === null) continue
    if (minute >= start && minute < end) return true
  }
  return false
}

const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

/** Get the weekday name in the named timezone, returning "mon".."sun".
 *  Uses Intl.DateTimeFormat which is universally available in modern
 *  browsers and Node; it's also the only built-in way to get a weekday
 *  name in a non-local zone without pulling in a library. */
export function weekdayInZone(ts: number, timezone: string): Weekday {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).formatToParts(new Date(ts))
  const wd = parts.find((p) => p.type === "weekday")?.value ?? ""
  switch (wd) {
    case "Mon": return "mon"
    case "Tue": return "tue"
    case "Wed": return "wed"
    case "Thu": return "thu"
    case "Fri": return "fri"
    case "Sat": return "sat"
    case "Sun": return "sun"
    default:    return WEEKDAYS[0]
  }
}

/** Minutes since midnight in the named timezone, range [0, 1440). */
export function minuteOfDayInZone(ts: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ts))
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10)
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10)
  // Intl returns "24" for midnight in some locales; normalize.
  const hh = h === 24 ? 0 : h
  return hh * 60 + m
}

/** Parse "HH:MM" into [0, 1440). Returns null on malformed input. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (m === null) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return h * 60 + mm
}

/** Compute the CNY cost of one usage delta using the given price set.
 *  Prices are per-1M tokens; tokens are in raw units (1 = 1 token). */
export function computeDeltaCost(
  delta: {
    uncachedInputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
  },
  price: PriceSet,
): number {
  const m = 1_000_000
  return (
    (delta.cacheReadTokens / m) * price.inputCacheHitPerMTokCNY +
    (delta.uncachedInputTokens / m) * price.inputCacheMissPerMTokCNY +
    (delta.cacheWriteTokens / m) * price.inputCacheMissPerMTokCNY +
    (delta.outputTokens / m) * price.outputPerMTokCNY
  )
}

/** Compute the CNY cost of one model-day bucket at a single point in
 *  time. Used by the price reconciler when peak/off-peak status flips. */
export function computeBucketCost(
  bucket: {
    uncachedInputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
  },
  price: PriceSet,
): number {
  return computeDeltaCost(bucket, price)
}
