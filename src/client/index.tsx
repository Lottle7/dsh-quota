/** Browser half: follows the real current Session and renders quota surfaces. */

import { useEffect, useState } from "react"
import { createQuotaApi, type QuotaApi } from "./api.ts"
import { createQuotaStore, type QuotaPreferences, type QuotaState } from "./store.ts"
import { QuotaIndicator } from "./quota-indicator.tsx"
import { QuotaPanel } from "./quota-panel.tsx"
import { FloatingQuota } from "./floating-quota.tsx"
import {
  readBudgetPreferences,
  writeBudgetPreferences,
  type BudgetPreferences,
} from "./budget-preferences.ts"
import {
  readFloatingPreferences,
  writeFloatingPreferences,
  type FloatingPreferences,
} from "./floating-preferences.ts"
import {
  UsageStore,
  aggregateBreakdown,
  aggregateDaily,
  aggregateLifetime,
  aggregateToday,
  defaultUsageStorage,
} from "./usage-store.ts"
import {
  mergePricingTable,
  readLocalPriceOverrides,
  withLocalPrice,
  writeLocalPriceOverrides,
} from "./pricing-preferences.ts"
import type { SessionSelectionHint } from "../shared/types.ts"
import type { PriceSet, PricingTable, TokenUsageTotals } from "../shared/usage.ts"
import { PREFERENCES_STORAGE_KEY, ZERO_USAGE } from "../shared/usage.ts"

export const name = "dsh-quota"
export const inject = ["slots", "sessions", "modelDirectories"] as const

interface SnapshotFace<T = unknown> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

interface ProvideInfo {
  sessionId?: unknown
  projections?: { faceOf(key: string): SnapshotFace }
}

interface ModelDirectoryState {
  current: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
  status?: string
}

interface ClientSlots {
  inject(name: string, callback: () => unknown): void
  register(options: unknown, component: unknown): unknown
}

interface QuotaClientContext {
  effect(callback: () => (() => void), label?: string): unknown
  slots: ClientSlots
  sessions: { currentProvideInfo: SnapshotFace<ProvideInfo> }
  modelDirectories: {
    directoryFor(sessionId: string): {
      store: SnapshotFace<ModelDirectoryState>
      load(): Promise<unknown>
    }
  }
}

type ComponentHandle = ReturnType<typeof createQuotaStore>

export function readTokenTotals(value: unknown): TokenUsageTotals {
  if (typeof value !== "object" || value === null) return { ...ZERO_USAGE }
  const root = value as { totals?: unknown }
  // DSH token-meter keeps `{ totals, last }` internally, but its official
  // projection wire view exposes the four totals directly. Accept both so
  // the client also remains compatible with older/local projection faces.
  const totals = typeof root.totals === "object" && root.totals !== null ? root.totals : root
  const input = totals as Partial<Record<keyof TokenUsageTotals, unknown>>
  return {
    uncachedInputTokens: numberOrZero(input.uncachedInputTokens),
    cacheReadTokens: numberOrZero(input.cacheReadTokens),
    cacheWriteTokens: numberOrZero(input.cacheWriteTokens),
    outputTokens: numberOrZero(input.outputTokens),
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function apply(ctx: QuotaClientContext): void {
  const api: QuotaApi = createQuotaApi("")
  const store = createQuotaStore(api, readPreferences())
  const usageStore = new UsageStore({ storage: defaultUsageStorage() })
  const legacyUsageRows = usageStore.exportLegacyRows()
  let hostPricing: PricingTable = usageStore.getPricing()
  let localPriceOverrides = readLocalPriceOverrides()
  let activeSelection: SessionSelectionHint | null = null
  let lastTokenTotals: TokenUsageTotals = { ...ZERO_USAGE }
  let usageReloadTimer: ReturnType<typeof setTimeout> | null = null
  let usageReloading = false

  const pushUsage = (): void => {
    const pricing = usageStore.getPricing()
    const now = Date.now
    store.actions.applyUsage({
      tokens: lastTokenTotals,
      model: activeSelection?.model ?? null,
      today: aggregateToday(usageStore.getState(), pricing, now),
      lifetime: aggregateLifetime(usageStore.getState(), pricing, now),
      series: aggregateDaily(usageStore.getState(), pricing, now, 7),
      breakdown: aggregateBreakdown(usageStore.getState(), pricing, now),
    })
  }
  const applyEffectivePricing = (): void => {
    const effective = mergePricingTable(hostPricing, localPriceOverrides)
    usageStore.setPricing(effective)
    store.actions.applyPricing(effective, Object.keys(localPriceOverrides))
  }
  const saveLocalPrice = (model: string, prices: PriceSet | null): void => {
    localPriceOverrides = withLocalPrice(localPriceOverrides, model, prices)
    writeLocalPriceOverrides(localPriceOverrides)
    applyEffectivePricing()
  }
  const scheduleUsageReload = (delay = 650): void => {
    if (usageReloadTimer !== null) clearTimeout(usageReloadTimer)
    usageReloadTimer = setTimeout(() => {
      usageReloadTimer = null
      void reloadHostUsage()
    }, delay)
  }
  const reloadHostUsage = async (): Promise<void> => {
    if (usageReloading) return
    usageReloading = true
    try {
      const ledger = await api.getUsage({ days: 30, limit: 30 })
      usageStore.replaceFromSummary(ledger.summary.buckets)
      store.actions.applyLedger(ledger)
      pushUsage()
      if (ledger.backfill.status === "scanning") scheduleUsageReload(800)
    } catch {
      // Keep the last good browser mirror while Host storage is unavailable.
    } finally {
      usageReloading = false
    }
  }
  const synchronizeHistory = async (): Promise<void> => {
    await api.backfillUsage()
    await reloadHostUsage()
    scheduleUsageReload(800)
  }
  const observeUsage = (): void => {
    pushUsage()
    if (activeSelection !== null) scheduleUsageReload()
  }

  const offUsage = usageStore.subscribe(pushUsage)
  ctx.effect(() => () => offUsage(), "dsh-quota: usage-listener")
  ctx.effect(() => () => usageStore.dispose(), "dsh-quota: usage-store")

  const applySettings = async (): Promise<void> => {
    const settings = await api.getSettings()
    hostPricing = settings.pricing
    applyEffectivePricing()
    store.actions.applySettings(settings)
  }
  applyEffectivePricing()
  void applySettings().catch(() => undefined)
  void store.actions.reloadProviders()
  void (async () => {
    if (legacyUsageRows.length > 0) await api.importLegacyUsage(legacyUsageRows)
    await reloadHostUsage()
  })().catch(() => undefined)

  const locale: "zh-CN" | "en-US" =
    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"
  store.actions.setLocale(locale)

  let sessionCleanup: (() => void) | undefined
  let selectionKey = ""
  let bindingGeneration = 0
  const bindCurrentSession = (): void => {
    bindingGeneration += 1
    const generation = bindingGeneration
    sessionCleanup?.()
    sessionCleanup = undefined
    const info = ctx.sessions.currentProvideInfo.getSnapshot()
    const sessionId = typeof info.sessionId === "string" ? info.sessionId : undefined
    if (sessionId === undefined) {
      activeSelection = null
      selectionKey = ""
      lastTokenTotals = { ...ZERO_USAGE }
      store.actions.applySelection(null)
      pushUsage()
      return
    }

    // Do not attribute the new session's first token snapshot to the previous
    // session/model while its model directory is still loading.
    activeSelection = null
    lastTokenTotals = { ...ZERO_USAGE }
    store.actions.applySelection(null)

    const disposers: Array<() => void> = []
    const tokenFace = info.projections?.faceOf("tokenUsage")
    const syncTokens = (): void => {
      if (generation !== bindingGeneration) return
      lastTokenTotals = readTokenTotals(tokenFace?.getSnapshot())
      observeUsage()
    }
    if (tokenFace !== undefined) disposers.push(tokenFace.subscribe(syncTokens))

    const directory = ctx.modelDirectories.directoryFor(sessionId)
    const syncSelection = (): void => {
      if (generation !== bindingGeneration) return
      const state = directory.store.getSnapshot()
      const provider = state.current?.provider
      const model = state.current?.model
      if (typeof provider !== "string" || typeof model !== "string" || provider.length === 0 || model.length === 0) {
        if (state.status !== "loading") void directory.load().catch(() => undefined)
        return
      }
      const reasoning = state.current?.reasoningEffort
      const next: SessionSelectionHint = {
        sessionId,
        provider,
        model,
        ...(typeof reasoning === "string" ? { reasoningEffort: reasoning } : {}),
      }
      const nextKey = `${sessionId}\u0000${provider}\u0000${model}\u0000${String(reasoning ?? "")}`
      activeSelection = next
      store.actions.applySelection(next)
      observeUsage()
      if (nextKey !== selectionKey) {
        selectionKey = nextKey
        if (store.getSnapshot().mode === "auto") void store.actions.refreshNow()
      }
    }
    disposers.push(directory.store.subscribe(syncSelection))
    syncTokens()
    syncSelection()
    sessionCleanup = () => { for (const dispose of disposers.reverse()) dispose() }
  }

  const offProvide = ctx.sessions.currentProvideInfo.subscribe(bindCurrentSession)
  bindCurrentSession()
  ctx.effect(() => () => {
    bindingGeneration += 1
    sessionCleanup?.()
    offProvide()
  }, "dsh-quota: current-session")

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const clearPoll = (): void => {
    if (pollTimer !== null) clearTimeout(pollTimer)
    pollTimer = null
  }
  const schedulePoll = (): void => {
    clearPoll()
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return
    pollTimer = setTimeout(async () => {
      const state = store.getSnapshot()
      const id = state.mode === "manual" ? state.manualId ?? undefined : undefined
      await store.actions.refreshNow(id)
      await reloadHostUsage()
      schedulePoll()
    }, store.getSnapshot().refreshIntervalMs)
  }
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") clearPoll()
    else {
      const state = store.getSnapshot()
      void store.actions.refreshNow(state.mode === "manual" ? state.manualId ?? undefined : undefined)
      void reloadHostUsage()
      schedulePoll()
    }
  }
  const onOnline = (): void => { onVisibility() }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility)
  if (typeof window !== "undefined") window.addEventListener("online", onOnline)
  schedulePoll()

  let observedInterval = store.getSnapshot().refreshIntervalMs
  let observedPreference = preferenceKey(store.getSnapshot())
  const offStore = store.subscribe(() => {
    const state = store.getSnapshot()
    if (state.refreshIntervalMs !== observedInterval) {
      observedInterval = state.refreshIntervalMs
      schedulePoll()
    }
    const key = preferenceKey(state)
    if (key !== observedPreference) {
      observedPreference = key
      writePreferences({ mode: state.mode, manualId: state.manualId })
    }
  })
  ctx.effect(() => () => {
    clearPoll()
    if (usageReloadTimer !== null) clearTimeout(usageReloadTimer)
    offStore()
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility)
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline)
  }, "dsh-quota: polling")

  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-quota-indicator", order: 40 }, function SidebarQuotaAction(props: { wide: boolean }) {
      const state = useStateSync(store)
      return (
        <QuotaIndicator
          snapshot={state.snapshot}
          brandColor={state.providers.find((provider) => provider.id === state.snapshot?.providerId)?.brandColor}
          onOpenPanel={() => {
            store.actions.setPanelOpen(!state.panelOpen)
            if (!state.panelOpen) void reloadHostUsage()
          }}
          loading={state.loading}
          manual={state.mode === "manual"}
          locale={state.locale}
          wide={props.wide}
          open={state.panelOpen}
        />
      )
    }),
  )

  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "dsh-quota-overlay", order: 50 }, function QuotaOverlay() {
      const state = useStateSync(store)
      const [floating, setFloating] = useState<FloatingPreferences>(() => readFloatingPreferences())
      const [budget, setBudget] = useState<BudgetPreferences>(() => readBudgetPreferences())
      const updateFloating = (next: FloatingPreferences): void => {
        setFloating(next)
        writeFloatingPreferences(next)
      }
      const updateBudget = (next: BudgetPreferences): void => {
        setBudget(next)
        writeBudgetPreferences(next)
      }
      return (
        <>
          <FloatingQuota
            snapshot={state.snapshot}
            brandColor={state.providers.find((provider) => provider.id === state.snapshot?.providerId)?.brandColor}
            currentModel={state.currentModel}
            currentTokens={state.currentTokens}
            usageToday={state.usageToday}
            usageRolling30Day={state.usageLifetime}
            pricing={state.pricing}
            loading={state.loading}
            locale={state.locale}
            preferences={floating}
            budgetPreferences={budget}
            panelOpen={state.panelOpen}
            onPreferencesChange={updateFloating}
            onOpenPanel={() => {
              store.actions.setPanelOpen(true)
              void reloadHostUsage()
            }}
          />
          {state.panelOpen ? (
            <QuotaPanel
              {...state}
              floatingMode={floating.mode}
              budgetPreferences={budget}
              onSelectManual={(id) => store.actions.setManual(id)}
              onSetMode={(mode) => store.actions.setMode(mode)}
              onRefresh={() => store.actions.refreshNow(state.mode === "manual" ? state.manualId ?? undefined : undefined, true)}
              onSyncUsage={synchronizeHistory}
              onQueryUsage={(query) => api.getUsage({ days: 30, limit: 30, ...query })}
              onExportUsage={(query) => api.exportUsageCsv({ days: 30, ...query })}
              onSavePrice={saveLocalPrice}
              onSetFloatingMode={(mode) => updateFloating({ ...floating, mode })}
              onBudgetPreferencesChange={updateBudget}
              onResetFloatingPosition={() => updateFloating({ ...floating, position: null })}
              onClose={() => store.actions.setPanelOpen(false)}
            />
          ) : null}
        </>
      )
    }),
  )
}

function useStateSync(store: ComponentHandle): QuotaState {
  const [, force] = useState(0)
  useEffect(() => {
    const off = store.subscribe(() => force((value) => value + 1))
    return () => off()
  }, [store])
  return store.getSnapshot()
}

function readPreferences(): Partial<QuotaPreferences> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PREFERENCES_STORAGE_KEY)
    if (raw === null) return {}
    const value = JSON.parse(raw) as { mode?: unknown; manualId?: unknown }
    return {
      mode: value.mode === "manual" ? "manual" : "auto",
      manualId: typeof value.manualId === "string" ? value.manualId : null,
    }
  } catch { return {} }
}

function writePreferences(preferences: QuotaPreferences): void {
  try { localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences)) } catch { /* private mode */ }
}

function preferenceKey(state: QuotaState): string {
  return `${state.mode}:${state.manualId ?? ""}`
}
