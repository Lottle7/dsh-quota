/**
 * Shared number formatters used by both the indicator (24px mini ring) and
 * the panel (Hero, This-Conversation row, Today row). Pure functions; no
 * I/O; no locale-aware currency (CNY is hardcoded — the pricing table is
 * denominated in CNY and we keep it that way in the local estimate).
 */

/** Compact token count, e.g. 1234 → "1.2k", 1_500_000 → "1.5M". */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0"
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return m.toFixed(m >= 10 ? 0 : 1) + "M"
  }
  if (value >= 1_000) {
    const k = value / 1_000
    return k.toFixed(k >= 10 ? 0 : 1) + "k"
  }
  return String(Math.round(value))
}

/** CNY currency. Symbol is the official ¥; we avoid the homoglyph U+00A5
 *  some fonts render as a backslash. Values under 0.01 show with two
 *  decimals; everything else with two decimals too (kept consistent for
 *  the table scan experience). */
export function formatCNY(value: number): string {
  if (!Number.isFinite(value)) return "¥0.00"
  return "¥" + value.toFixed(2)
}

/** Cache-hit ratio as a percentage string. Returns "0%" / "78%" / "100%".
 *  The denominator is input-side tokens served (cache hit + cache miss +
 *  cache write); a value of zero returns "—" so we don't lie about a
 *  ratio when there's nothing to ratio. */
export function formatCacheHitPercent(hit: number, total: number): string {
  if (total <= 0) return "—"
  const pct = Math.round((hit / total) * 100)
  return `${Math.max(0, Math.min(100, pct))}%`
}

/** Generic integer percent (0..100). */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`
}

/** Format an epoch ms as "YYYY-MM-DD HH:mm" using the runtime's local
 *  timezone. Used by the panel footer and the Today row header. */
export function formatLocalDateTime(ts: number, locale: "zh-CN" | "en-US"): string {
  try {
    return new Date(ts).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  } catch {
    return new Date(ts).toISOString()
  }
}

/** Format an epoch ms as "HH:mm" in the runtime's local timezone. */
export function formatLocalHHMM(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  } catch {
    return "--:--"
  }
}
