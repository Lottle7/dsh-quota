import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import type { QuotaSnapshot } from "../shared/types.ts"
import type { PricingTable, TokenUsageTotals } from "../shared/usage.ts"
import type { UsageAggregate } from "./usage-store.ts"
import {
  evaluateBudgets,
  strongestBudgetEvaluation,
  type BudgetEvaluation,
  type BudgetPreferences,
} from "./budget-preferences.ts"
import { formatCacheHitPercent, formatCount, formatCNY } from "./format.ts"
import {
  clampFloatingPosition,
  type FloatingPosition,
  type FloatingPreferences,
} from "./floating-preferences.ts"
import { computeDeltaCost, resolvePriceAt } from "./pricing.ts"

type Locale = "zh-CN" | "en-US"

export interface FloatingQuotaProps {
  snapshot: QuotaSnapshot | null
  currentModel: string | null
  currentTokens: TokenUsageTotals
  usageToday: UsageAggregate
  usageRolling30Day: UsageAggregate
  pricing: PricingTable
  loading: boolean
  locale: Locale
  preferences: FloatingPreferences
  budgetPreferences: BudgetPreferences
  panelOpen: boolean
  onPreferencesChange(preferences: FloatingPreferences): void
  onOpenPanel(): void
}

export function FloatingQuota(props: FloatingQuotaProps) {
  const rootRef = useRef<HTMLElement>(null)
  const draftRef = useRef<FloatingPosition | null>(null)
  const movedRef = useRef(false)
  const suppressClickRef = useRef(false)
  const [draftPosition, setDraftPosition] = useState<FloatingPosition | null>(null)
  const position = draftPosition ?? props.preferences.position

  useEffect(() => {
    const keepInsideViewport = (): void => {
      const root = rootRef.current
      if (root === null || props.preferences.position === null) return
      const rect = root.getBoundingClientRect()
      const next = clampFloatingPosition(
        props.preferences.position,
        { width: window.innerWidth, height: window.innerHeight },
        { width: rect.width, height: rect.height },
      )
      if (next.x !== props.preferences.position.x || next.y !== props.preferences.position.y) {
        props.onPreferencesChange({ ...props.preferences, position: next })
      }
    }
    keepInsideViewport()
    window.addEventListener("resize", keepInsideViewport)
    return () => window.removeEventListener("resize", keepInsideViewport)
  }, [props.preferences.mode, props.preferences.position?.x, props.preferences.position?.y])

  if (props.preferences.mode === "hidden" || props.panelOpen) return null

  const startDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || rootRef.current === null) return
    event.preventDefault()
    event.stopPropagation()
    const root = rootRef.current
    const rect = root.getBoundingClientRect()
    const origin = { x: rect.left, y: rect.top }
    const start = { x: event.clientX, y: event.clientY }
    const pointerId = event.pointerId
    movedRef.current = false
    root.classList.add("is-dragging")

    const move = (nextEvent: PointerEvent): void => {
      if (nextEvent.pointerId !== pointerId) return
      const dx = nextEvent.clientX - start.x
      const dy = nextEvent.clientY - start.y
      if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true
      const next = clampFloatingPosition(
        { x: origin.x + dx, y: origin.y + dy },
        { width: window.innerWidth, height: window.innerHeight },
        { width: rect.width, height: rect.height },
      )
      draftRef.current = next
      setDraftPosition(next)
    }
    const finish = (nextEvent: PointerEvent): void => {
      if (nextEvent.pointerId !== pointerId) return
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      root.classList.remove("is-dragging")
      const finalPosition = draftRef.current
      if (movedRef.current && finalPosition !== null) {
        props.onPreferencesChange({ ...props.preferences, position: finalPosition })
        suppressClickRef.current = true
        window.setTimeout(() => { suppressClickRef.current = false }, 0)
      }
      draftRef.current = null
      setDraftPosition(null)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
  }

  const openPanel = (): void => {
    if (!suppressClickRef.current) props.onOpenPanel()
  }
  const provider = props.snapshot?.providerDisplayName ?? copy(props.locale, "等待会话", "Waiting for session")
  const status = props.snapshot?.status ?? "unsupported"
  const model = props.currentModel ?? copy(props.locale, "尚未选择模型", "No model selected")
  const input = props.currentTokens.uncachedInputTokens + props.currentTokens.cacheReadTokens + props.currentTokens.cacheWriteTokens
  const total = input + props.currentTokens.outputTokens
  const resolved = props.currentModel === null ? null : resolvePriceAt(props.currentModel, props.pricing, Date.now()).prices
  const hasPrice = resolved !== null && Object.values(resolved).some((value) => value > 0)
  const cost = resolved === null ? 0 : computeDeltaCost(props.currentTokens, resolved)
  const budget = strongestBudgetEvaluation(evaluateBudgets(
    props.usageToday,
    props.usageRolling30Day,
    props.budgetPreferences,
  ))
  const visualStatus = budget?.level === "exceeded"
    ? "exhausted"
    : budget?.level === "warning" ? "warning" : status
  const style = {
    "--q-provider": providerColor(props.snapshot?.providerId),
    ...(position === null ? {} : { left: position.x, top: position.y, right: "auto", bottom: "auto" }),
  } as CSSProperties
  const title = `${provider} · ${model} · ${formatCount(total)} tok${budget === null ? "" : ` · ${budgetTitle(budget, props.locale)}`}`

  if (props.preferences.mode === "icon") {
    return (
      <aside ref={rootRef} className={`dsh-quota-floating is-icon is-${visualStatus}`} style={style} aria-label={title}>
        <button
          type="button"
          className="dsh-quota-floating-orb"
          onPointerDown={startDrag}
          onClick={openPanel}
          title={copy(props.locale, "拖动改变位置，点击打开额度中心", "Drag to move, click to open quota center")}
          aria-label={title}
        >
          {props.loading ? <span className="dsh-quota-spinner" /> : <GaugeIcon />}
          <i className={`is-${visualStatus}`} />
        </button>
      </aside>
    )
  }

  return (
    <aside ref={rootRef} className={`dsh-quota-floating is-card is-${visualStatus}`} style={style} aria-label={title}>
      <header className="dsh-quota-floating-header">
        <span className={`dsh-quota-floating-status is-${visualStatus}`} aria-hidden="true" />
        <div className="dsh-quota-floating-heading">
          <strong title={provider}>{provider}</strong>
          <small title={model}>{model}</small>
        </div>
        <button
          type="button"
          className="dsh-quota-floating-control is-drag"
          onPointerDown={startDrag}
          title={copy(props.locale, "拖动仪表盘", "Move dashboard")}
          aria-label={copy(props.locale, "拖动仪表盘", "Move dashboard")}
        ><DragIcon /></button>
        <button
          type="button"
          className="dsh-quota-floating-control"
          onClick={() => props.onPreferencesChange({ ...props.preferences, mode: "icon" })}
          title={copy(props.locale, "折叠成图标", "Collapse to icon")}
          aria-label={copy(props.locale, "折叠成图标", "Collapse to icon")}
        ><MinimizeIcon /></button>
        <button
          type="button"
          className="dsh-quota-floating-control"
          onClick={() => props.onPreferencesChange({ ...props.preferences, mode: "hidden" })}
          title={copy(props.locale, "关闭悬浮仪表盘", "Hide floating dashboard")}
          aria-label={copy(props.locale, "关闭悬浮仪表盘", "Hide floating dashboard")}
        ><CloseIcon /></button>
      </header>
      <button type="button" className="dsh-quota-floating-body" onClick={openPanel} title={copy(props.locale, "打开完整额度中心", "Open full quota center")}>
        <span><small>{copy(props.locale, "会话 Token", "Session tokens")}</small><strong>{formatCount(total)}</strong></span>
        <span><small>{copy(props.locale, "估算费用", "Est. cost")}</small><strong>{hasPrice ? formatCNY(cost) : "—"}</strong></span>
        <span><small>{copy(props.locale, "缓存命中", "Cache hit")}</small><strong>{formatCacheHitPercent(props.currentTokens.cacheReadTokens, input)}</strong></span>
        <i aria-hidden="true"><ChevronIcon /></i>
      </button>
      {budget !== null ? (
        <div className={`dsh-quota-floating-budget is-${budget.level}`}>
          <span>{budgetScopeLabel(budget, props.locale)}</span>
          <strong>{budget.level === "unpriced" ? copy(props.locale, "缺少价格", "No pricing") : `${Math.round(budget.ratio * 100)}%`}</strong>
          <i aria-hidden="true"><b style={{ width: `${Math.min(100, Math.max(0, budget.ratio * 100))}%` }} /></i>
        </div>
      ) : null}
      <footer className="dsh-quota-floating-footer">
        <span>{props.loading ? copy(props.locale, "刷新中", "Refreshing") : budgetStatusText(budget, status, props.locale)}</span>
        <span>{copy(props.locale, "点击查看详情", "Open details")}</span>
      </footer>
    </aside>
  )
}

function budgetScopeLabel(value: BudgetEvaluation, locale: Locale): string {
  return value.scope === "daily"
    ? copy(locale, "今日预算", "Daily budget")
    : copy(locale, "30 天预算", "30-day budget")
}

function budgetTitle(value: BudgetEvaluation, locale: Locale): string {
  if (value.level === "unpriced") return `${budgetScopeLabel(value, locale)} ${copy(locale, "缺少价格", "needs pricing")}`
  return `${budgetScopeLabel(value, locale)} ${Math.round(value.ratio * 100)}%`
}

function budgetStatusText(
  budget: BudgetEvaluation | null,
  status: QuotaSnapshot["status"],
  locale: Locale,
): string {
  if (budget?.level === "exceeded") return copy(locale, "费用预算已超出", "Cost budget exceeded")
  if (budget?.level === "warning") return copy(locale, "费用接近预算", "Cost nearing budget")
  if (budget?.level === "unpriced") return copy(locale, "预算等待价格", "Budget needs pricing")
  return statusText(status, locale)
}

function copy(locale: Locale, zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en
}

function statusText(status: QuotaSnapshot["status"], locale: Locale): string {
  const zh: Record<QuotaSnapshot["status"], string> = {
    ok: "运行正常",
    warning: "额度偏低",
    exhausted: "额度耗尽",
    unsupported: "等待数据",
    "not-configured": "未配置",
    "auth-error": "鉴权失败",
    "rate-limited": "请求受限",
    "network-error": "网络异常",
    error: "读取失败",
  }
  const en: Record<QuotaSnapshot["status"], string> = {
    ok: "Healthy",
    warning: "Low quota",
    exhausted: "Exhausted",
    unsupported: "Waiting",
    "not-configured": "Not configured",
    "auth-error": "Auth failed",
    "rate-limited": "Rate limited",
    "network-error": "Network error",
    error: "Read failed",
  }
  return locale === "zh-CN" ? zh[status] : en[status]
}

function providerColor(id?: string): string {
  if (id?.startsWith("minimax")) return "#8b5cf6"
  if (id === "deepseek-official") return "#4d6bfe"
  if (id === "siliconflow") return "#0f766e"
  if (id === "openrouter" || id === "moonshot") return "#111827"
  if (id === "zhipu") return "#2563eb"
  if (id === "alibaba-bailian") return "#ff6a00"
  if (id === "volcengine-ark") return "#1664ff"
  if (id === "together") return "#ef4444"
  if (id === "fireworks") return "#f97316"
  return "#64748b"
}

function GaugeIcon() {
  return <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><path d="M4 16.5a7.5 7.5 0 1 1 14 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="m11 11 3.8-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><circle cx="11" cy="11" r="1.5" fill="currentColor"/><path d="M5.5 18h11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
}

function DragIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4 3h.01M4 7h.01M4 11h.01M10 3h.01M10 7h.01M10 11h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
}

function MinimizeIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M3 7.8h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
}

function CloseIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="m3.5 3.5 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/></svg>
}

function ChevronIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="m5 3.5 3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
}
