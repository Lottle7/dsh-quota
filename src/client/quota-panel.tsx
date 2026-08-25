import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import type { ProviderListItem, QuotaSnapshot, QuotaStatus, QuotaWindow } from "../shared/types.ts"
import type { PriceSet, PricingTable, TokenUsageTotals } from "../shared/usage.ts"
import type {
  UsageBackfillState,
  UsageLedgerEntry,
  UsageLedgerQuery,
  UsageLedgerResponse,
} from "../shared/ledger.ts"
import { PLUGIN_VERSION } from "../shared/constants.ts"
import type { Mode } from "./store.ts"
import type { UsageAggregate, UsageBreakdownItem, UsageSeriesPoint } from "./usage-store.ts"
import { formatCacheHitPercent, formatCount, formatCNY } from "./format.ts"
import type { FloatingMode } from "./floating-preferences.ts"
import { computeDeltaCost, resolvePriceAt } from "./pricing.ts"
import { t } from "./i18n.ts"

type Locale = "zh-CN" | "en-US"
type Tab = "overview" | "usage" | "providers" | "settings"

export interface QuotaPanelProps {
  snapshot: QuotaSnapshot | null
  fallback: QuotaSnapshot | null
  providers: ProviderListItem[]
  mode: Mode
  manualId: string | null
  currentProviderId: string | null
  currentRouteProvider: string | null
  routeConfidence: "exact" | "mapped" | "heuristic" | "unknown" | null
  modelVendor: string | null
  currentSessionId: string | null
  currentTokens: TokenUsageTotals
  currentModel: string | null
  usageToday: UsageAggregate
  usageLifetime: UsageAggregate
  usageSeries: UsageSeriesPoint[]
  usageBreakdown: UsageBreakdownItem[]
  usageEntries: UsageLedgerEntry[]
  usageTotalCalls: number
  usageNextCursor: string | null
  usageSessionCount: number
  usageRetainedDays: number
  usageBackfill: UsageBackfillState
  pricing: PricingTable
  localPriceModels: string[]
  loading: boolean
  error: string | null
  locale: Locale
  refreshIntervalMs: number
  warningBalanceBelow: number
  warningQuotaRemainingBelow: number
  floatingMode: FloatingMode
  onSelectManual(id: string | null): void
  onSetMode(mode: Mode): void
  onRefresh(): void
  onSyncUsage(): Promise<void>
  onQueryUsage(query: UsageLedgerQuery): Promise<UsageLedgerResponse>
  onExportUsage(query: UsageLedgerQuery): Promise<Blob>
  onSavePrice(model: string, prices: PriceSet | null): void
  onSetFloatingMode(mode: FloatingMode): void
  onResetFloatingPosition(): void
  onClose(): void
}

export function QuotaPanel(props: QuotaPanelProps) {
  const [tab, setTab] = useState<Tab>("overview")
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose
  const snapshot = props.snapshot
  const brandColor = props.providers.find((item) => item.id === snapshot?.providerId)?.brandColor
    ?? providerColor(snapshot?.providerId)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeRef.current()
      if (event.key !== "Tab" || panelRef.current === null) return
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => { window.removeEventListener("keydown", onKeyDown); previous?.focus() }
  }, [])
  return (
    <>
      <div className="dsh-quota-backdrop" aria-hidden="true" onMouseDown={props.onClose} />
      <section
        ref={panelRef}
        className="dsh-quota-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t(props.locale, "panelTitle")}
        tabIndex={-1}
        style={{ "--q-provider": brandColor } as CSSProperties}
      >
        <PanelHeader {...props} />
        <RouteStrip {...props} />
        <nav className="dsh-quota-tabs" role="tablist" aria-label={t(props.locale, "panelTitle")}>
          {(["overview", "usage", "providers", "settings"] as const).map((item) => (
            <button
              type="button"
              role="tab"
              key={item}
              className={tab === item ? "is-active" : ""}
              aria-selected={tab === item}
              onClick={() => setTab(item)}
            >
              {t(props.locale, item)}
              {item === "providers" ? <span className="dsh-quota-tab-count">{props.providers.length}</span> : null}
            </button>
          ))}
        </nav>
        <div className="dsh-quota-panel-scroll">
          {props.error !== null ? <Notice kind="error" text={props.error} /> : null}
          {snapshot?.stale === true ? <Notice kind="warning" text={t(props.locale, "stale")} /> : null}
          {tab === "overview" ? <Overview {...props} /> : null}
          {tab === "usage" ? (
            <UsageView
              tokens={props.currentTokens}
              model={props.currentModel}
              today={props.usageToday}
              lifetime={props.usageLifetime}
              snapshot={snapshot}
              locale={props.locale}
              series={props.usageSeries}
              breakdown={props.usageBreakdown}
              entries={props.usageEntries}
              totalCalls={props.usageTotalCalls}
              nextCursor={props.usageNextCursor}
              sessionCount={props.usageSessionCount}
              retainedDays={props.usageRetainedDays}
              backfill={props.usageBackfill}
              pricing={props.pricing}
              onSync={props.onSyncUsage}
              onQuery={props.onQueryUsage}
              onExport={props.onExportUsage}
            />
          ) : null}
          {tab === "providers" ? <ProvidersView {...props} /> : null}
          {tab === "settings" ? <SettingsView {...props} /> : null}
        </div>
        <PanelFooter snapshot={snapshot} locale={props.locale} />
      </section>
    </>
  )
}

function PanelHeader(props: QuotaPanelProps) {
  const snapshot = props.snapshot
  const color = providerColor(snapshot?.providerId)
  return (
    <header className="dsh-quota-header" style={{ "--q-provider": color } as CSSProperties}>
      <div className="dsh-quota-provider-logo" aria-hidden="true">
        {(snapshot?.providerDisplayName ?? "Q").slice(0, 1).toUpperCase()}
      </div>
      <div className="dsh-quota-header-copy">
        <span className="dsh-quota-header-eyebrow">{t(props.locale, "panelTitle")}</span>
        <div className="dsh-quota-header-titleline">
          <strong>{snapshot?.providerDisplayName ?? t(props.locale, "sessionUnavailable")}</strong>
          {snapshot !== null ? <StatusBadge status={snapshot.status} locale={props.locale} /> : null}
        </div>
      </div>
      <button type="button" className="dsh-quota-icon-button" onClick={props.onRefresh} disabled={props.loading} title={t(props.locale, "refresh")} aria-label={t(props.locale, "refresh")}>
        {props.loading ? <span className="dsh-quota-spinner" /> : <RefreshIcon />}
      </button>
      <button type="button" className="dsh-quota-icon-button" onClick={props.onClose} title={t(props.locale, "close")} aria-label={t(props.locale, "close")}>
        <CloseIcon />
      </button>
    </header>
  )
}

function RouteStrip(props: QuotaPanelProps) {
  const manual = props.mode === "manual"
  return (
    <div className="dsh-quota-route-strip">
      <div className="dsh-quota-mode-switch" role="group" aria-label={t(props.locale, "billingProvider")}>
        <button type="button" className={!manual ? "is-active" : ""} onClick={() => props.onSetMode("auto")}>{t(props.locale, "autoMode")}</button>
        <button type="button" className={manual ? "is-active" : ""} onClick={() => props.onSetMode("manual")}>{t(props.locale, "manualMode")}</button>
      </div>
      <div className="dsh-quota-route-copy" title={manual ? t(props.locale, "manualHint") : t(props.locale, "routeHint")}>
        <span>{manual ? t(props.locale, "billingProvider") : t(props.locale, "currentRoute")}</span>
        <strong>{manual ? props.snapshot?.providerDisplayName ?? "—" : props.currentRouteProvider ?? "—"}</strong>
        {!manual && props.currentModel !== null ? <small>{props.currentModel}</small> : null}
      </div>
    </div>
  )
}

function Overview(props: QuotaPanelProps) {
  const { snapshot, locale } = props
  const todayInput = aggregateInput(props.usageToday)
  const pulse = (
    <section className="dsh-quota-pulse-grid" aria-label={copy(locale, "本地用量摘要", "Local usage summary")}>
      <PulseMetric label={t(locale, "today")} value={props.usageToday.hasPricing ? formatCNY(props.usageToday.costCNY) : t(locale, "noPricing")} />
      <PulseMetric label={copy(locale, "今日 Token", "Tokens today")} value={formatCount(todayInput + props.usageToday.out)} />
      <PulseMetric label={t(locale, "cacheHit")} value={formatCacheHitPercent(props.usageToday.inCacheHit, todayInput)} />
      <PulseMetric label={copy(locale, "可用平台", "Available")} value={`${props.providers.filter((item) => item.configured && item.supported).length}/${props.providers.length}`} />
    </section>
  )
  if (snapshot === null || snapshot.providerId === "unknown") {
    return <div className="dsh-quota-view dsh-quota-overview">{pulse}<EmptyState locale={locale} message={snapshot?.message} /></div>
  }
  const quota = primaryQuota(snapshot)
  const balance = snapshot.balances?.[0]
  const localOnly = snapshot.capabilities.localAccounting === true
  const percentage = quota?.remainingRatio === undefined ? null : Math.round(quota.remainingRatio * 100)
  const primaryValue = localOnly
    ? props.usageToday.hasPricing ? formatCNY(props.usageToday.costCNY) : t(locale, "localTracking")
    : balance !== undefined
    ? formatMoney(balance.total, balance.currency, locale)
    : percentage !== null ? `${percentage}%` : snapshot.usage?.remaining !== undefined
      ? formatMoney(snapshot.usage.remaining, snapshot.usage.currency, locale) : "—"
  const primaryLabel = localOnly
    ? copy(locale, "今日本地估算", "Today's local estimate")
    : balance !== undefined ? t(locale, "available") : quota?.label ?? t(locale, "remaining")
  return (
    <div className="dsh-quota-view dsh-quota-overview">
      <section className={`dsh-quota-hero-card is-${snapshot.status}`}>
        <div className="dsh-quota-hero-copy">
          <span>{primaryLabel}</span>
          <strong>{primaryValue}</strong>
          <small>{snapshot.message ?? snapshot.model ?? snapshot.providerDisplayName}</small>
        </div>
        <QuotaRing percent={localOnly ? null : percentage} status={snapshot.status} />
      </section>
      {pulse}
      <CapabilityRow snapshot={snapshot} locale={locale} />
      {(snapshot.balances?.length ?? 0) > 0 ? (
        <PanelSection title={t(locale, "balance")}>
          <div className="dsh-quota-balance-grid">
            {snapshot.balances?.map((item) => (
              <article className="dsh-quota-balance-card" key={item.currency}>
                <span>{item.currency}</span>
                <strong>{formatMoney(item.total, item.currency, locale)}</strong>
                <div>
                  {item.toppedUp !== undefined ? <small>{locale === "zh-CN" ? "充值" : "Paid"} {formatMoney(item.toppedUp, item.currency, locale)}</small> : null}
                  {item.granted !== undefined ? <small>{locale === "zh-CN" ? "赠送" : "Granted"} {formatMoney(item.granted, item.currency, locale)}</small> : null}
                </div>
              </article>
            ))}
          </div>
        </PanelSection>
      ) : null}
      {(snapshot.quotas?.length ?? 0) > 0 ? (
        <PanelSection title={t(locale, "quotaWindows")}>
          <div className="dsh-quota-window-list">
            {snapshot.quotas?.map((item) => <QuotaWindowRow key={item.id} quota={item} locale={locale} />)}
          </div>
        </PanelSection>
      ) : null}
      {snapshot.usage !== undefined ? <ProviderUsage snapshot={snapshot} locale={locale} /> : null}
      {snapshot.status !== "ok" && snapshot.message !== undefined ? <Notice kind={snapshot.status === "warning" ? "warning" : "error"} text={snapshot.message} /> : null}
    </div>
  )
}

function UsageView(props: {
  tokens: TokenUsageTotals
  model: string | null
  today: UsageAggregate
  lifetime: UsageAggregate
  snapshot: QuotaSnapshot | null
  locale: Locale
  series: UsageSeriesPoint[]
  breakdown: UsageBreakdownItem[]
  entries: UsageLedgerEntry[]
  totalCalls: number
  nextCursor: string | null
  sessionCount: number
  retainedDays: number
  backfill: UsageBackfillState
  pricing: PricingTable
  onSync(): Promise<void>
  onQuery(query: UsageLedgerQuery): Promise<UsageLedgerResponse>
  onExport(query: UsageLedgerQuery): Promise<Blob>
}) {
  const [syncing, setSyncing] = useState(false)
  const [ledgerEntries, setLedgerEntries] = useState(props.entries)
  const [nextCursor, setNextCursor] = useState(props.nextCursor)
  const [totalCalls, setTotalCalls] = useState(props.totalCalls)
  const [provider, setProvider] = useState("")
  const [model, setModel] = useState("")
  const [search, setSearch] = useState("")
  const [source, setSource] = useState<"" | UsageLedgerEntry["source"]>("")
  const [activeQuery, setActiveQuery] = useState<UsageLedgerQuery>({})
  const [querying, setQuerying] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const providerOptions = [...new Set([
    ...props.breakdown.map((item) => item.provider),
    ...props.entries.map((entry) => entry.billingProvider),
  ])].sort((left, right) => left.localeCompare(right))

  useEffect(() => {
    if (hasUsageFilters(activeQuery)) return
    setLedgerEntries(props.entries)
    setNextCursor(props.nextCursor)
    setTotalCalls(props.totalCalls)
  }, [activeQuery, props.entries, props.nextCursor, props.totalCalls])
  const input = props.tokens.uncachedInputTokens + props.tokens.cacheReadTokens + props.tokens.cacheWriteTokens
  const any = input + props.tokens.outputTokens > 0
  const currentPrice = props.model === null ? null : resolvePriceAt(props.model, props.pricing, Date.now()).prices
  const currentHasPricing = currentPrice !== null && priceConfigured(currentPrice)
  const currentCost = currentPrice === null ? 0 : computeDeltaCost(props.tokens, currentPrice)
  const synchronize = (): void => {
    setSyncing(true)
    setSyncError(null)
    void props.onSync()
      .catch((error: unknown) => setSyncError(String(error instanceof Error ? error.message : error)))
      .finally(() => setSyncing(false))
  }
  const filterQuery = (): UsageLedgerQuery => ({
    ...(provider.trim().length > 0 ? { billingProvider: provider.trim() } : {}),
    ...(model.trim().length > 0 ? { model: model.trim() } : {}),
    ...(search.trim().length > 0 ? { search: search.trim() } : {}),
    ...(source !== "" ? { source } : {}),
  })
  const replacePage = async (query: UsageLedgerQuery): Promise<void> => {
    setQuerying(true)
    setLedgerError(null)
    try {
      const page = await props.onQuery({ ...query, limit: 30 })
      setActiveQuery(query)
      setLedgerEntries(page.entries)
      setNextCursor(page.nextCursor)
      setTotalCalls(page.summary.calls)
    } catch (error) {
      setLedgerError(String(error instanceof Error ? error.message : error))
    } finally {
      setQuerying(false)
    }
  }
  const resetFilters = (): void => {
    setProvider("")
    setModel("")
    setSearch("")
    setSource("")
    void replacePage({})
  }
  const loadMore = (): void => {
    if (nextCursor === null || loadingMore) return
    setLoadingMore(true)
    setLedgerError(null)
    void props.onQuery({ ...activeQuery, limit: 30, cursor: nextCursor })
      .then((page) => {
        setLedgerEntries((current) => mergeLedgerEntries(current, page.entries))
        setNextCursor(page.nextCursor)
        setTotalCalls(page.summary.calls)
      })
      .catch((error: unknown) => setLedgerError(String(error instanceof Error ? error.message : error)))
      .finally(() => setLoadingMore(false))
  }
  const exportCsv = (): void => {
    setExporting(true)
    setLedgerError(null)
    void props.onExport(activeQuery)
      .then((blob) => downloadBlob(blob, `dsh-quota-usage-${new Date().toISOString().slice(0, 10)}.csv`))
      .catch((error: unknown) => setLedgerError(String(error instanceof Error ? error.message : error)))
      .finally(() => setExporting(false))
  }
  return (
    <div className="dsh-quota-view dsh-quota-usage-view">
      <section className={`dsh-quota-ledger-status is-${props.backfill.status}`}>
        <div className="dsh-quota-ledger-icon"><DatabaseIcon /></div>
        <div className="dsh-quota-ledger-copy">
          <strong>{copy(props.locale, "Host 用量账本", "Host usage ledger")}</strong>
          <small>{ledgerStatusText(props.locale, props.backfill, props.sessionCount, props.retainedDays)}</small>
        </div>
        <button type="button" onClick={synchronize} disabled={syncing || props.backfill.status === "scanning"}>
          {syncing || props.backfill.status === "scanning"
            ? copy(props.locale, "同步中…", "Syncing…")
            : copy(props.locale, "同步历史", "Sync history")}
        </button>
      </section>
      {syncError !== null ? <p className="dsh-quota-ledger-error">{syncError}</p> : null}
      <PanelSection title={t(props.locale, "thisConversation")} subtitle={props.model ?? undefined}>
        <MetricGrid items={[
          [t(props.locale, "input"), formatCount(input)],
          [t(props.locale, "output"), formatCount(props.tokens.outputTokens)],
          [t(props.locale, "cacheHit"), formatCacheHitPercent(props.tokens.cacheReadTokens, input)],
          [t(props.locale, "estimatedCost"), currentHasPricing ? formatCNY(currentCost) : t(props.locale, "noPricing")],
        ]} />
        {!any ? <p className="dsh-quota-section-hint">{t(props.locale, "usageEmpty")}</p> : null}
      </PanelSection>
      <UsageAggregateCard title={t(props.locale, "today")} value={props.today} locale={props.locale} prominent />
      <UsageAggregateCard title={t(props.locale, "lifetime")} value={props.lifetime} locale={props.locale} />
      <PanelSection title={copy(props.locale, "近 7 天趋势", "7-day trend")}>
        <UsageTrend series={props.series} locale={props.locale} />
      </PanelSection>
      <PanelSection title={copy(props.locale, "平台与模型", "Provider & model")} subtitle={copy(props.locale, "近 30 天", "30 days")}>
        <UsageBreakdown items={props.breakdown} locale={props.locale} />
      </PanelSection>
      <PanelSection
        title={copy(props.locale, "逐次调用", "Recent calls")}
        subtitle={copy(props.locale, `显示 ${ledgerEntries.length}/${totalCalls} 条`, `Showing ${ledgerEntries.length}/${totalCalls}`)}
      >
        <form
          className="dsh-quota-ledger-tools"
          onSubmit={(event) => { event.preventDefault(); void replacePage(filterQuery()) }}
        >
          <div className="dsh-quota-ledger-filter-grid">
            <label>
              <span>{copy(props.locale, "平台", "Provider")}</span>
              <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                <option value="">{copy(props.locale, "全部平台", "All providers")}</option>
                {providerOptions.map((item) => <option value={item} key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span>{copy(props.locale, "模型", "Model")}</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={copy(props.locale, "精确模型名", "Exact model name")} />
            </label>
            <label>
              <span>{copy(props.locale, "搜索", "Search")}</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy(props.locale, "会话 / 路由 / 模型", "Session / route / model")} />
            </label>
            <label>
              <span>{copy(props.locale, "来源", "Source")}</span>
              <select value={source} onChange={(event) => setSource(event.target.value as "" | UsageLedgerEntry["source"])}>
                <option value="">{copy(props.locale, "全部来源", "All sources")}</option>
                <option value="session-log">{copy(props.locale, "会话日志", "Session log")}</option>
                <option value="browser-migration">{copy(props.locale, "旧版迁移", "Legacy migration")}</option>
              </select>
            </label>
          </div>
          <div className="dsh-quota-ledger-actions">
            <span>{copy(props.locale, `共 ${totalCalls} 次调用`, `${totalCalls} calls`)}</span>
            <button type="button" className="dsh-quota-secondary-button" onClick={resetFilters} disabled={querying}>{copy(props.locale, "重置", "Reset")}</button>
            <button type="submit" className="dsh-quota-secondary-button" disabled={querying}>{querying ? copy(props.locale, "查询中…", "Filtering…") : copy(props.locale, "应用筛选", "Apply filters")}</button>
            <button type="button" className="dsh-quota-primary-button" onClick={exportCsv} disabled={exporting}>{exporting ? copy(props.locale, "导出中…", "Exporting…") : copy(props.locale, "导出 CSV", "Export CSV")}</button>
          </div>
        </form>
        {ledgerError !== null ? <p className="dsh-quota-ledger-error">{ledgerError}</p> : null}
        <UsageLedgerList entries={ledgerEntries} pricing={props.pricing} locale={props.locale} />
        {nextCursor !== null ? (
          <button type="button" className="dsh-quota-ledger-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? copy(props.locale, "加载中…", "Loading…") : copy(props.locale, "加载更多", "Load more")}
          </button>
        ) : null}
      </PanelSection>
      {props.snapshot?.usage !== undefined ? <ProviderUsage snapshot={props.snapshot} locale={props.locale} /> : null}
      <p className="dsh-quota-privacy-note"><ShieldIcon />{t(props.locale, "costEstimate")}</p>
    </div>
  )
}

function UsageLedgerList({ entries, pricing, locale }: { entries: UsageLedgerEntry[]; pricing: PricingTable; locale: Locale }) {
  const visible = entries.filter((entry) => tokenTotal(entry.tokens) > 0)
  if (visible.length === 0) return <p className="dsh-quota-section-hint">{t(locale, "usageEmpty")}</p>
  return (
    <div className="dsh-quota-ledger-list">
      {visible.map((entry) => {
        const input = entry.tokens.uncachedInputTokens + entry.tokens.cacheReadTokens + entry.tokens.cacheWriteTokens
        const { prices } = resolvePriceAt(entry.model, pricing, entry.occurredAt)
        const cost = computeDeltaCost(entry.tokens, prices)
        const route = entry.routeProvider === entry.billingProvider
          ? entry.billingProvider
          : `${entry.routeProvider} → ${entry.billingProvider}`
        return (
          <article className="dsh-quota-ledger-row" key={entry.id}>
            <div className="dsh-quota-ledger-row-main">
              <strong title={entry.model}>{entry.model}</strong>
              <small>{route}</small>
            </div>
            <div className="dsh-quota-ledger-row-tokens">
              <strong>{formatCount(input + entry.tokens.outputTokens)} tok</strong>
              <small>{copy(locale, `输入 ${formatCount(input)} · 输出 ${formatCount(entry.tokens.outputTokens)}`, `In ${formatCount(input)} · Out ${formatCount(entry.tokens.outputTokens)}`)}</small>
            </div>
            <div className="dsh-quota-ledger-row-cost">
              <strong>{priceConfigured(prices) ? formatCNY(cost) : "—"}</strong>
              <small>{formatLedgerTime(entry.occurredAt, locale)}</small>
            </div>
            <div className="dsh-quota-ledger-row-meta">
              <span>{entry.source === "browser-migration"
                ? copy(locale, "旧版汇总", "Legacy aggregate")
                : `T${entry.turn ?? "?"} · S${entry.step ?? "?"}`}</span>
              <span title={entry.sessionId}>{entry.sessionId === "browser-migration" ? "migration" : entry.sessionId.slice(0, 8)}</span>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function hasUsageFilters(query: UsageLedgerQuery): boolean {
  return query.billingProvider !== undefined
    || query.model !== undefined
    || query.sessionId !== undefined
    || query.source !== undefined
    || query.search !== undefined
}

function mergeLedgerEntries(current: UsageLedgerEntry[], incoming: UsageLedgerEntry[]): UsageLedgerEntry[] {
  const ids = new Set(current.map((entry) => entry.id))
  return [...current, ...incoming.filter((entry) => !ids.has(entry.id))]
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function ledgerStatusText(locale: Locale, state: UsageBackfillState, sessions: number, retainedDays: number): string {
  if (state.status === "scanning") {
    return copy(locale, `正在扫描会话 ${state.scanned}/${state.total}`, `Scanning sessions ${state.scanned}/${state.total}`)
  }
  if (state.status === "error") return state.message ?? copy(locale, "同步失败，可重试", "Sync failed; retry available")
  if (state.status === "idle") return copy(locale, "等待首次历史同步", "Waiting for initial history sync")
  return copy(locale, `已同步 ${sessions} 个会话 · 保留 ${retainedDays} 天`, `${sessions} sessions synced · ${retainedDays}-day retention`)
}

function formatLedgerTime(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp))
}

function tokenTotal(tokens: TokenUsageTotals): number {
  return tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.outputTokens
}

function priceConfigured(prices: PriceSet): boolean {
  return prices.inputCacheHitPerMTokCNY > 0 || prices.inputCacheMissPerMTokCNY > 0 || prices.outputPerMTokCNY > 0
}

function UsageTrend({ series, locale }: { series: UsageSeriesPoint[]; locale: Locale }) {
  const counts = series.map((item) => aggregateInput(item.aggregate) + item.aggregate.out)
  const maximum = Math.max(1, ...counts)
  return (
    <div className="dsh-quota-chart" role="img" aria-label={copy(locale, "最近七天 Token 用量柱状图", "Token usage for the last seven days")}>
      {series.map((item, index) => {
        const tokens = counts[index]
        const height = tokens === 0 ? 3 : Math.max(8, Math.round((tokens / maximum) * 100))
        return (
          <div className="dsh-quota-chart-column" key={item.date} title={`${item.date}: ${formatCount(tokens)} tok`}>
            <span className="dsh-quota-chart-value">{tokens === 0 ? "" : formatCount(tokens)}</span>
            <div className="dsh-quota-chart-track"><i style={{ "--q-height": height } as CSSProperties} /></div>
            <small>{shortDate(item.date, locale)}</small>
          </div>
        )
      })}
    </div>
  )
}

function UsageBreakdown({ items, locale }: { items: UsageBreakdownItem[]; locale: Locale }) {
  if (items.length === 0) return <p className="dsh-quota-section-hint">{t(locale, "usageEmpty")}</p>
  const visible = items.slice(0, 8)
  const max = Math.max(1, ...visible.map((item) => aggregateInput(item.aggregate) + item.aggregate.out))
  return (
    <div className="dsh-quota-breakdown-list">
      {visible.map((item) => {
        const tokens = aggregateInput(item.aggregate) + item.aggregate.out
        return (
          <article className="dsh-quota-breakdown-row" key={item.key}>
            <div><strong>{item.model}</strong><small>{item.provider === "unknown" ? copy(locale, "未识别平台", "Unknown provider") : item.provider}</small></div>
            <span>{formatCount(tokens)} tok</span>
            <b>{item.aggregate.hasPricing ? formatCNY(item.aggregate.costCNY) : "—"}</b>
            <div className="dsh-quota-breakdown-progress"><i style={{ width: `${Math.max(3, (tokens / max) * 100)}%` }} /></div>
          </article>
        )
      })}
    </div>
  )
}

function ProvidersView(props: QuotaPanelProps) {
  return (
    <div className="dsh-quota-view dsh-quota-providers-view">
      <p className="dsh-quota-view-intro">{props.mode === "manual" ? t(props.locale, "manualHint") : t(props.locale, "routeHint")}</p>
      <div className="dsh-quota-provider-grid">
        {props.providers.map((provider) => {
          const active = props.snapshot?.providerId === provider.id
          const localOnly = provider.capabilities?.localAccounting === true
          return (
            <button
              type="button"
              key={provider.id}
              className={`dsh-quota-provider-card${active ? " is-active" : ""}`}
              disabled={!provider.supported}
              onClick={() => props.onSelectManual(provider.id)}
              style={{ "--q-provider": provider.brandColor ?? providerColor(provider.id) } as CSSProperties}
            >
              <span className="dsh-quota-provider-card-logo">{provider.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="dsh-quota-provider-card-copy">
                <strong>{provider.displayName}</strong>
                <small>{provider.description ?? provider.region ?? provider.id}</small>
              </span>
              <span className={`dsh-quota-provider-state is-${provider.supported ? provider.configured ? "configured" : "missing" : "disabled"}`}>
                {provider.supported ? localOnly ? t(props.locale, "localTracking") : provider.configured ? t(props.locale, "configured") : t(props.locale, "noKey") : t(props.locale, "disabled")}
              </span>
              <span className="dsh-quota-provider-capabilities">
                {provider.region !== undefined ? <em>{provider.region}</em> : null}
                {provider.capabilities?.balance === true ? <em>{t(props.locale, "balance")}</em> : null}
                {provider.capabilities?.quota === true ? <em>{localeQuota(props.locale)}</em> : null}
                {localOnly ? <em>{t(props.locale, "localTracking")}</em> : null}
              </span>
            </button>
          )
        })}
      </div>
      <p className="dsh-quota-privacy-note"><ShieldIcon />{t(props.locale, "allSystems")}</p>
    </div>
  )
}

function SettingsView(props: QuotaPanelProps) {
  const [model, setModel] = useState(props.currentModel ?? "")
  const [draft, setDraft] = useState<[string, string, string]>(["0", "0", "0"])
  const [feedback, setFeedback] = useState("")
  useEffect(() => {
    if (props.currentModel !== null) setModel(props.currentModel)
  }, [props.currentModel])
  useEffect(() => {
    if (model.trim().length === 0) { setDraft(["0", "0", "0"]); return }
    const price = resolvePriceAt(model, props.pricing, Date.now()).prices
    setDraft([
      String(price.inputCacheHitPerMTokCNY),
      String(price.inputCacheMissPerMTokCNY),
      String(price.outputPerMTokCNY),
    ])
  }, [model, props.pricing])
  const parsed = draft.map((value) => Number(value))
  const valid = model.trim().length > 0 && parsed.every((value) => Number.isFinite(value) && value >= 0)
  const local = props.localPriceModels.includes(model.trim().toLowerCase())
  const save = (): void => {
    if (!valid) return
    props.onSavePrice(model, {
      inputCacheHitPerMTokCNY: parsed[0],
      inputCacheMissPerMTokCNY: parsed[1],
      outputPerMTokCNY: parsed[2],
    })
    setFeedback(copy(props.locale, "价格已保存到当前浏览器", "Price saved in this browser"))
  }
  const configured = parsed.some((value) => value > 0)
  const schedule = props.pricing.peakHours.windows.length === 0
    ? copy(props.locale, "未启用分时折扣", "Time-of-day discount disabled")
    : `${props.pricing.peakHours.timezone} · ${props.pricing.peakHours.windows.map((item) => `${item.start}–${item.end}`).join(", ")}`
  return (
    <div className="dsh-quota-view dsh-quota-settings-view">
      <PanelSection title={copy(props.locale, "悬浮仪表盘", "Floating dashboard")} subtitle={copy(props.locale, "随时查看当前会话用量", "Keep current-session usage visible")}>
        <div className="dsh-quota-floating-settings">
          <div className="dsh-quota-floating-mode" role="group" aria-label={copy(props.locale, "悬浮仪表盘显示方式", "Floating dashboard display mode")}>
            {([
              ["card", copy(props.locale, "迷你面板", "Mini card")],
              ["icon", copy(props.locale, "仅图标", "Icon only")],
              ["hidden", copy(props.locale, "关闭", "Off")],
            ] as Array<[FloatingMode, string]>).map(([mode, label]) => (
              <button type="button" key={mode} className={props.floatingMode === mode ? "is-active" : ""} onClick={() => props.onSetFloatingMode(mode)}>{label}</button>
            ))}
          </div>
          <div className="dsh-quota-floating-settings-copy">
            <p>{copy(props.locale, "迷你面板会显示平台、模型、会话 Token、估算费用与缓存命中；拖动顶部把手即可改变位置。", "The mini card shows provider, model, session tokens, estimated cost and cache hit. Drag its top handle to move it.")}</p>
            <button type="button" className="dsh-quota-secondary-button" onClick={props.onResetFloatingPosition}>{copy(props.locale, "恢复默认位置", "Reset position")}</button>
          </div>
        </div>
      </PanelSection>

      <PanelSection title={copy(props.locale, "模型价格", "Model pricing")} subtitle={copy(props.locale, "人民币 / 百万 Token", "CNY / 1M tokens")}>
        <div className="dsh-quota-price-editor">
          <label className="dsh-quota-field is-model">
            <span>{copy(props.locale, "模型 ID", "Model ID")}</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" spellCheck={false} />
          </label>
          <div className="dsh-quota-price-grid">
            {[
              copy(props.locale, "缓存命中输入", "Cached input"),
              copy(props.locale, "未命中输入", "Uncached input"),
              copy(props.locale, "输出", "Output"),
            ].map((label, index) => (
              <label className="dsh-quota-field" key={label}>
                <span>{label}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft[index]}
                  onChange={(event) => setDraft((current) => current.map((value, item) => item === index ? event.target.value : value) as [string, string, string])}
                />
              </label>
            ))}
          </div>
          <div className="dsh-quota-editor-actions">
            <span className={`dsh-quota-pricing-state${configured ? " is-ready" : ""}`}>
              {local ? copy(props.locale, "浏览器覆盖", "Browser override") : configured ? copy(props.locale, "Host / 内置价格", "Host / built-in price") : t(props.locale, "noPricing")}
            </span>
            {local ? <button type="button" className="dsh-quota-secondary-button" onClick={() => props.onSavePrice(model, null)}>{copy(props.locale, "恢复 Host 价格", "Restore Host price")}</button> : null}
            <button type="button" className="dsh-quota-primary-button" onClick={save} disabled={!valid}>{copy(props.locale, "保存价格", "Save price")}</button>
          </div>
          {feedback.length > 0 ? <p className="dsh-quota-inline-feedback" role="status">{feedback}</p> : null}
          <p className="dsh-quota-section-hint">{copy(props.locale, "价格只保存在当前浏览器；不会写入 Host，也不会影响平台账单。", "Prices stay in this browser and never change the Host or provider bill.")}</p>
        </div>
      </PanelSection>

      <PanelSection title={copy(props.locale, "路由诊断", "Route diagnostics")}>
        <div className="dsh-quota-diagnostic-grid">
          <DiagnosticRow label={copy(props.locale, "会话路由", "Session route")} value={props.currentRouteProvider ?? "—"} />
          <DiagnosticRow label={t(props.locale, "billingProvider")} value={props.snapshot?.providerDisplayName ?? props.currentProviderId ?? "—"} />
          <DiagnosticRow label={copy(props.locale, "模型厂商", "Model vendor")} value={props.modelVendor ?? "—"} />
          <DiagnosticRow label={copy(props.locale, "解析置信度", "Resolution confidence")} value={props.routeConfidence ?? "—"} />
          <DiagnosticRow label={copy(props.locale, "当前模型", "Current model")} value={props.currentModel ?? "—"} />
          <DiagnosticRow label={copy(props.locale, "刷新周期", "Refresh interval")} value={formatDuration(props.refreshIntervalMs, props.locale)} />
          <DiagnosticRow label={copy(props.locale, "分时价格", "Timed pricing")} value={schedule} />
          <DiagnosticRow label={copy(props.locale, "可用平台", "Available providers")} value={`${props.providers.filter((item) => item.configured && item.supported).length}/${props.providers.length}`} />
        </div>
        <div className="dsh-quota-settings-actions">
          <button type="button" className="dsh-quota-secondary-button" onClick={() => void copyDiagnostics(props, setFeedback)}>{copy(props.locale, "复制脱敏诊断", "Copy safe diagnostics")}</button>
          <button type="button" className="dsh-quota-secondary-button" onClick={() => exportUsage(props)}>{copy(props.locale, "导出用量 JSON", "Export usage JSON")}</button>
        </div>
      </PanelSection>
      <p className="dsh-quota-privacy-note"><ShieldIcon />{t(props.locale, "allSystems")}</p>
    </div>
  )
}

function PulseMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>
}

async function copyDiagnostics(props: QuotaPanelProps, setFeedback: (value: string) => void): Promise<void> {
  const report = {
    plugin: "dsh-quota",
    version: PLUGIN_VERSION,
    generatedAt: new Date().toISOString(),
    mode: props.mode,
    route: props.currentRouteProvider,
    billingProvider: props.snapshot?.providerId ?? props.currentProviderId,
    modelVendor: props.modelVendor,
    model: props.currentModel,
    confidence: props.routeConfidence,
    status: props.snapshot?.status ?? null,
    stale: props.snapshot?.stale ?? false,
    refreshIntervalMs: props.refreshIntervalMs,
    providers: props.providers.map((item) => ({ id: item.id, configured: item.configured, enabled: item.supported, status: item.status ?? null })),
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
    setFeedback(copy(props.locale, "脱敏诊断已复制", "Safe diagnostics copied"))
  } catch {
    setFeedback(copy(props.locale, "浏览器拒绝了剪贴板访问", "Clipboard access was denied"))
  }
}

function exportUsage(props: QuotaPanelProps): void {
  const data = JSON.stringify({
    exportedAt: new Date().toISOString(),
    range: "30-days",
    daily: props.usageSeries,
    breakdown: props.usageBreakdown,
  }, null, 2)
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `dsh-quota-usage-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function ProviderUsage({ snapshot, locale }: { snapshot: QuotaSnapshot; locale: Locale }) {
  const usage = snapshot.usage
  if (usage === undefined) return null
  return (
    <PanelSection title={t(locale, "providerUsage")}>
      <MetricGrid items={[
        [t(locale, "spent"), usage.total === undefined ? "—" : formatMoney(usage.total, usage.currency, locale)],
        [t(locale, "today"), usage.daily === undefined ? "—" : formatMoney(usage.daily, usage.currency, locale)],
        [locale === "zh-CN" ? "本周" : "Week", usage.weekly === undefined ? "—" : formatMoney(usage.weekly, usage.currency, locale)],
        [locale === "zh-CN" ? "本月" : "Month", usage.monthly === undefined ? "—" : formatMoney(usage.monthly, usage.currency, locale)],
      ]} />
      <div className="dsh-quota-provider-usage-meta">
        <span>{t(locale, "limit")} <strong>{usage.limit === undefined ? t(locale, "noLimit") : formatMoney(usage.limit, usage.currency, locale)}</strong></span>
        {usage.reset !== undefined ? <span>{t(locale, "reset")} <strong>{usage.reset}</strong></span> : null}
      </div>
    </PanelSection>
  )
}

function UsageAggregateCard({ title, value, locale, prominent = false }: { title: string; value: UsageAggregate; locale: Locale; prominent?: boolean }) {
  const input = value.inCacheHit + value.inCacheMiss + value.cacheWrite
  return (
    <section className={`dsh-quota-aggregate-card${prominent ? " is-prominent" : ""}`}>
      <div className="dsh-quota-aggregate-head">
        <span>{title}</span>
        <strong>{value.hasPricing ? formatCNY(value.costCNY) : t(locale, "noPricing")}</strong>
      </div>
      <div className="dsh-quota-token-bar" aria-hidden="true">
        <span className="is-cache" style={{ flexGrow: value.inCacheHit }} />
        <span className="is-input" style={{ flexGrow: value.inCacheMiss + value.cacheWrite }} />
        <span className="is-output" style={{ flexGrow: value.out }} />
      </div>
      <div className="dsh-quota-aggregate-meta">
        <span>{t(locale, "input")} <strong>{formatCount(input)}</strong></span>
        <span>{t(locale, "output")} <strong>{formatCount(value.out)}</strong></span>
        <span>{t(locale, "cacheHit")} <strong>{formatCacheHitPercent(value.inCacheHit, input)}</strong></span>
      </div>
    </section>
  )
}

function QuotaWindowRow({ quota, locale }: { quota: QuotaWindow; locale: Locale }) {
  const percent = quota.remainingRatio === undefined ? null : Math.round(quota.remainingRatio * 100)
  return (
    <article className="dsh-quota-window-row">
      <div className="dsh-quota-window-heading">
        <div><strong>{quota.label}</strong><small>{quota.unit ?? localeQuota(locale)}</small></div>
        <b>{percent === null ? "—" : `${percent}%`}</b>
      </div>
      <div className="dsh-quota-progress" style={{ "--q-progress": percent ?? 0 } as CSSProperties}><span /></div>
      <div className="dsh-quota-window-meta">
        <span>{quota.remaining !== undefined ? `${formatCount(quota.remaining)}${quota.total !== undefined ? ` / ${formatCount(quota.total)}` : ""}` : t(locale, "remaining")}</span>
        {quota.resetAt !== undefined ? <span>{relativeReset(quota.resetAt, locale)}</span> : null}
      </div>
    </article>
  )
}

function CapabilityRow({ snapshot, locale }: { snapshot: QuotaSnapshot; locale: Locale }) {
  return (
    <div className="dsh-quota-capability-row">
      <span>{t(locale, "supports")}</span>
      {snapshot.capabilities.balance ? <em>{t(locale, "balance")}</em> : null}
      {snapshot.capabilities.quota ? <em>{localeQuota(locale)}</em> : null}
      {snapshot.capabilities.usage ? <em>{t(locale, "usage")}</em> : null}
      {snapshot.capabilities.localAccounting ? <em>{t(locale, "localTracking")}</em> : null}
      {snapshot.routeProvider !== undefined ? <small>{snapshot.routeProvider} → {snapshot.providerDisplayName}</small> : null}
    </div>
  )
}

function MetricGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="dsh-quota-metric-grid">
      {items.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div>
  )
}

function PanelSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="dsh-quota-section">
      <div className="dsh-quota-section-title"><strong>{title}</strong>{subtitle !== undefined ? <span>{subtitle}</span> : null}</div>
      {children}
    </section>
  )
}

function QuotaRing({ percent, status }: { percent: number | null; status: QuotaStatus }) {
  return (
    <div className={`dsh-quota-hero-ring is-${status}`} style={{ "--q-progress": percent ?? 100 } as CSSProperties}>
      <span>{percent === null ? "●" : `${percent}%`}</span>
    </div>
  )
}

function StatusBadge({ status, locale }: { status: QuotaStatus; locale: Locale }) {
  return <span className={`dsh-quota-status-badge is-${status}`}><i />{statusText(status, locale)}</span>
}

function Notice({ kind, text }: { kind: "warning" | "error"; text: string }) {
  return <div className={`dsh-quota-notice is-${kind}`} role="status">{text}</div>
}

function EmptyState({ locale, message }: { locale: Locale; message?: string }) {
  return (
    <div className="dsh-quota-empty">
      <div className="dsh-quota-empty-orbit"><span>Q</span></div>
      <strong>{t(locale, "sessionUnavailable")}</strong>
      <p>{message ?? t(locale, "routeHint")}</p>
    </div>
  )
}

function PanelFooter({ snapshot, locale }: { snapshot: QuotaSnapshot | null; locale: Locale }) {
  return (
    <footer className="dsh-quota-footer">
      <span><ShieldIcon /> {t(locale, "hostOnly")}</span>
      <span>{snapshot === null ? "—" : `${t(locale, "updated")} ${formatTime(snapshot.fetchedAt, locale)}`}</span>
    </footer>
  )
}

function primaryQuota(snapshot: QuotaSnapshot): QuotaWindow | undefined {
  return snapshot.quotas?.find((item) => item.id.endsWith(":5h"))
    ?? snapshot.quotas?.find((item) => typeof item.remainingRatio === "number")
}

function formatMoney(value: number, currency: string, locale: Locale): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 2 }).format(value)
  } catch { return `${currency} ${value.toFixed(2)}` }
}

function formatTime(iso: string, locale: Locale): string {
  try { return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }) } catch { return iso }
}

function shortDate(iso: string, locale: Locale): string {
  try {
    return new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { month: "numeric", day: "numeric" })
  } catch { return iso.slice(5) }
}

function formatDuration(ms: number, locale: Locale): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}${copy(locale, " 秒", "s")}`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}${copy(locale, " 分钟", "m")}`
  return `${Math.round(ms / 3_600_000)}${copy(locale, " 小时", "h")}`
}

function aggregateInput(value: UsageAggregate): number {
  return value.inCacheHit + value.inCacheMiss + value.cacheWrite
}

function copy(locale: Locale, zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en
}

function relativeReset(iso: string, locale: Locale): string {
  const distance = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(distance) || distance <= 0) return locale === "zh-CN" ? "即将重置" : "Resetting"
  const minutes = Math.ceil(distance / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return locale === "zh-CN" ? `${days} 天后重置` : `Resets in ${days}d`
  if (hours > 0) return locale === "zh-CN" ? `${hours} 小时后重置` : `Resets in ${hours}h`
  return locale === "zh-CN" ? `${minutes} 分钟后重置` : `Resets in ${minutes}m`
}

function statusText(status: QuotaStatus, locale: Locale): string {
  const key = status === "ok" ? "healthy"
    : status === "warning" ? "warning"
      : status === "exhausted" ? "exhausted"
        : status === "unsupported" ? "unsupported"
          : status === "not-configured" ? "notConfigured"
            : status === "auth-error" ? "authError"
              : status === "rate-limited" ? "rateLimited"
                : status === "network-error" ? "networkError" : "error"
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

function localeQuota(locale: Locale): string { return locale === "zh-CN" ? "额度" : "Quota" }

function RefreshIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 6.5A5.2 5.2 0 0 0 3.4 4.7M3 1.8v3.4h3.4M3 9.5a5.2 5.2 0 0 0 9.6 1.8M13 14.2v-3.4H9.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function CloseIcon() {
  return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="m3.5 3.5 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg>
}

function ShieldIcon() {
  return <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M6.5 1.3 11 3v3.1c0 2.7-1.8 4.7-4.5 5.7C3.8 10.8 2 8.8 2 6.1V3l4.5-1.7Z" stroke="currentColor" strokeWidth="1" /><path d="m4.6 6.5 1.2 1.2 2.7-2.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function DatabaseIcon() {
  return <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true"><ellipse cx="8.5" cy="4" rx="5.5" ry="2.25" stroke="currentColor" strokeWidth="1.2" /><path d="M3 4v4c0 1.24 2.46 2.25 5.5 2.25S14 9.24 14 8V4M3 8v4c0 1.24 2.46 2.25 5.5 2.25S14 13.24 14 12V8" stroke="currentColor" strokeWidth="1.2" /></svg>
}
