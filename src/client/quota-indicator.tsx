import type { CSSProperties } from "react"
import type { QuotaSnapshot } from "../shared/types.ts"
import { t } from "./i18n.ts"

export interface QuotaIndicatorProps {
  snapshot: QuotaSnapshot | null
  brandColor?: string
  onOpenPanel(): void
  loading: boolean
  manual: boolean
  locale: "zh-CN" | "en-US"
  wide: boolean
  open: boolean
}

export function QuotaIndicator({ snapshot, brandColor, onOpenPanel, loading, manual, locale, wide, open }: QuotaIndicatorProps) {
  const status = snapshot?.status ?? "unsupported"
  const metric = snapshot === null ? "—" : compactMetric(snapshot, locale)
  const provider = snapshot?.providerDisplayName.replace(/\s+(Official|Global|China)$/i, "") ?? "Quota"
  const description = `${t(locale, "panelTitle")} · ${provider} · ${metric}`
  return (
    <button
      type="button"
      className={`dsh-quota-sidebar-trigger dsh-quota-trigger-${status}${wide ? " is-wide" : " is-rail"}${open ? " is-open" : ""}${snapshot?.stale === true ? " is-stale" : ""}`}
      onClick={onOpenPanel}
      title={description}
      aria-label={description}
      aria-pressed={open}
      style={{ "--q-provider": brandColor ?? providerColor(snapshot?.providerId) } as CSSProperties}
    >
      <span className="dsh-quota-sidebar-icon" aria-hidden="true">
        {loading ? <span className="dsh-quota-spinner" /> : <GaugeIcon />}
        <i className={`is-${status}`} />
      </span>
      {wide ? <span className="dsh-quota-sidebar-label">{metric}</span> : null}
      {manual ? <span className="dsh-quota-sidebar-pin" aria-hidden="true">●</span> : null}
    </button>
  )
}

function compactMetric(snapshot: QuotaSnapshot, locale: "zh-CN" | "en-US"): string {
  const quota = snapshot.quotas?.find((item) => typeof item.remainingRatio === "number")
  if (quota?.remainingRatio !== undefined) return `${Math.round(quota.remainingRatio * 100)}%`
  const balance = snapshot.balances?.[0]
  if (balance !== undefined) return compactMoney(balance.total, balance.currency, locale)
  if (snapshot.usage?.remaining !== undefined) return compactMoney(snapshot.usage.remaining, snapshot.usage.currency, locale)
  return statusLabel(snapshot.status, locale)
}

function compactMoney(value: number, currency: string, locale: "zh-CN" | "en-US"): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: value < 10 ? 2 : 1,
    }).format(value)
  } catch { return `${currency} ${value.toFixed(1)}` }
}

function statusLabel(status: QuotaSnapshot["status"], locale: "zh-CN" | "en-US"): string {
  const key = status === "ok" ? "healthy"
    : status === "warning" ? "warning"
      : status === "exhausted" ? "exhausted"
        : status === "not-configured" ? "notConfigured"
          : status === "auth-error" ? "authError"
            : status === "rate-limited" ? "rateLimited"
              : status === "network-error" ? "networkError"
                : status === "unsupported" ? "unsupported" : "error"
  return t(locale, key)
}

function providerColor(id?: string): string {
  if (id?.startsWith("minimax")) return "#8b5cf6"
  if (id === "deepseek-official") return "#4d6bfe"
  if (id === "siliconflow") return "#0f766e"
  if (id === "openrouter") return "#111827"
  if (id === "moonshot") return "#111827"
  if (id === "zhipu") return "#2563eb"
  if (id === "alibaba-bailian") return "#ff6a00"
  if (id === "volcengine-ark") return "#1664ff"
  if (id === "together") return "#ef4444"
  if (id === "fireworks") return "#f97316"
  return "#64748b"
}

function GaugeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <path d="M3 12.6a6 6 0 1 1 11 0" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="m8.5 8.7 3-2.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <circle cx="8.5" cy="8.7" r="1.15" fill="currentColor" />
      <path d="M4.2 13.6h8.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}
