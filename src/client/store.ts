/** Shared observable state for the compact indicator and expanded panel. */

import type {
  CurrentQuotaResponse,
  ProviderId,
  ProviderListItem,
  QuotaSnapshot,
  SessionSelectionHint,
  SettingsSnapshotResponse,
} from "../shared/types.ts"
import type { PricingTable, TokenUsageTotals } from "../shared/usage.ts"
import type { UsageBackfillState, UsageLedgerEntry, UsageLedgerResponse } from "../shared/ledger.ts"
import type { QuotaApi } from "./api.ts"
import type { UsageAggregate, UsageBreakdownItem, UsageSeriesPoint } from "./usage-store.ts"

export type Mode = "auto" | "manual"

export interface QuotaPreferences {
  mode: Mode
  manualId: ProviderId | null
}

export interface QuotaState {
  mode: Mode
  currentProviderId: ProviderId | null
  currentRouteProvider: string | null
  routeConfidence: "exact" | "mapped" | "heuristic" | "unknown" | null
  modelVendor: string | null
  currentSessionId: string | null
  providers: ProviderListItem[]
  snapshot: QuotaSnapshot | null
  fallback: QuotaSnapshot | null
  manualId: ProviderId | null
  panelOpen: boolean
  loading: boolean
  error: string | null
  refreshIntervalMs: number
  warningBalanceBelow: number
  warningQuotaRemainingBelow: number
  locale: "zh-CN" | "en-US"
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
}

export interface QuotaActions {
  setMode(mode: Mode): Promise<void>
  setManual(id: ProviderId | null): Promise<void>
  setPanelOpen(open: boolean): void
  refreshNow(id?: ProviderId, force?: boolean): Promise<void>
  reloadProviders(): Promise<void>
  applySelection(selection: SessionSelectionHint | null): void
  applySettings(settings: SettingsSnapshotResponse): void
  setLocale(locale: "zh-CN" | "en-US"): void
  applyServer(payload: CurrentQuotaResponse): void
  applyProviders(items: ProviderListItem[]): void
  applyUsage(input: {
    tokens: TokenUsageTotals
    model: string | null
    today: UsageAggregate
    lifetime: UsageAggregate
    series?: UsageSeriesPoint[]
    breakdown?: UsageBreakdownItem[]
  }): void
  applyPricing(pricing: PricingTable, localPriceModels: string[]): void
  applyLedger(payload: UsageLedgerResponse): void
}

export interface QuotaStore {
  getSnapshot(): QuotaState
  subscribe(cb: () => void): () => void
  actions: QuotaActions
}

const EMPTY_USAGE: UsageAggregate = {
  inCacheHit: 0,
  inCacheMiss: 0,
  cacheWrite: 0,
  out: 0,
  costCNY: 0,
  hasPricing: false,
}

const EMPTY_PRICING: PricingTable = {
  default: { inputCacheHitPerMTokCNY: 0, inputCacheMissPerMTokCNY: 0, outputPerMTokCNY: 0 },
  overrides: {},
  peakHours: { weekdays: [], windows: [], timezone: "Asia/Shanghai" },
}

export function createQuotaStore(api: QuotaApi, preferences?: Partial<QuotaPreferences>): QuotaStore {
  let state: QuotaState = {
    mode: preferences?.mode ?? "auto",
    currentProviderId: null,
    currentRouteProvider: null,
    routeConfidence: null,
    modelVendor: null,
    currentSessionId: null,
    providers: [],
    snapshot: null,
    fallback: null,
    manualId: preferences?.manualId ?? null,
    panelOpen: false,
    loading: false,
    error: null,
    refreshIntervalMs: 60_000,
    warningBalanceBelow: 10,
    warningQuotaRemainingBelow: 0.2,
    locale: "en-US",
    currentTokens: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    currentModel: null,
    usageToday: { ...EMPTY_USAGE },
    usageLifetime: { ...EMPTY_USAGE },
    usageSeries: [],
    usageBreakdown: [],
    usageEntries: [],
    usageTotalCalls: 0,
    usageNextCursor: null,
    usageSessionCount: 0,
    usageRetainedDays: 90,
    usageBackfill: { status: "idle", scanned: 0, total: 0, lastCompletedAt: null },
    pricing: EMPTY_PRICING,
    localPriceModels: [],
  }
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const selection = (): SessionSelectionHint | undefined => {
    if (state.currentRouteProvider === null || state.currentModel === null) return undefined
    return {
      provider: state.currentRouteProvider,
      model: state.currentModel,
      ...(state.currentSessionId === null ? {} : { sessionId: state.currentSessionId }),
    }
  }

  const actions: QuotaActions = {
    async setMode(mode) {
      state = {
        ...state,
        mode,
        manualId: mode === "manual" ? state.manualId ?? state.currentProviderId : state.manualId,
      }
      notify()
      await actions.refreshNow(mode === "manual" ? state.manualId ?? undefined : undefined)
    },
    async setManual(id) {
      state = { ...state, mode: id === null ? "auto" : "manual", manualId: id }
      notify()
      await actions.refreshNow(id ?? undefined)
    },
    setPanelOpen(open) {
      state = { ...state, panelOpen: open }
      notify()
      if (open) void actions.reloadProviders()
    },
    applySelection(next) {
      const currentSessionId = next?.sessionId ?? null
      const currentRouteProvider = next?.provider ?? null
      const currentModel = next?.model ?? null
      if (
        currentSessionId === state.currentSessionId &&
        currentRouteProvider === state.currentRouteProvider &&
        currentModel === state.currentModel
      ) return
      state = { ...state, currentSessionId, currentRouteProvider, currentModel }
      notify()
    },
    applySettings(settings) {
      const refreshIntervalMs = Number.isFinite(settings.refreshIntervalMs)
        ? Math.max(15_000, settings.refreshIntervalMs)
        : state.refreshIntervalMs
      const warningBalanceBelow = Number.isFinite(settings.warningBalanceBelow)
        ? settings.warningBalanceBelow
        : state.warningBalanceBelow
      const warningQuotaRemainingBelow = Number.isFinite(settings.warningQuotaRemainingBelow)
        ? settings.warningQuotaRemainingBelow
        : state.warningQuotaRemainingBelow
      state = {
        ...state,
        refreshIntervalMs,
        warningBalanceBelow,
        warningQuotaRemainingBelow,
      }
      notify()
    },
    setLocale(locale) {
      state = { ...state, locale }
      notify()
    },
    applyServer(payload) {
      state = {
        ...state,
        currentProviderId: payload.resolved?.billingProviderId ?? state.currentProviderId,
        routeConfidence: payload.resolved?.confidence ?? state.routeConfidence,
        modelVendor: payload.resolved?.modelVendor ?? state.modelVendor,
        snapshot: payload.snapshot ?? null,
        fallback: payload.fallback ?? null,
      }
      notify()
    },
    applyProviders(items) {
      state = { ...state, providers: items }
      notify()
    },
    applyUsage({ tokens, model, today, lifetime, series, breakdown }) {
      state = {
        ...state,
        currentTokens: tokens,
        currentModel: model,
        usageToday: today,
        usageLifetime: lifetime,
        usageSeries: series ?? state.usageSeries,
        usageBreakdown: breakdown ?? state.usageBreakdown,
      }
      notify()
    },
    applyPricing(pricing, localPriceModels) {
      state = { ...state, pricing, localPriceModels: [...localPriceModels].sort() }
      notify()
    },
    applyLedger(payload) {
      state = {
        ...state,
        usageEntries: [...payload.entries],
        usageTotalCalls: payload.summary.calls,
        usageNextCursor: payload.nextCursor,
        usageSessionCount: payload.summary.sessionCount,
        usageRetainedDays: payload.retainedDays,
        usageBackfill: { ...payload.backfill },
      }
      notify()
    },
    async reloadProviders() {
      try { actions.applyProviders(await api.listProviders()) } catch { /* keep the last roster */ }
    },
    async refreshNow(id, force = false) {
      state = { ...state, loading: true, error: null }
      notify()
      try {
        if (id !== undefined) {
          const output = force ? await api.refresh(id) : await api.getProvider(id)
          const snapshot = output.snapshot
          if (snapshot === undefined) throw new Error("Provider response is missing a snapshot")
          state = {
            ...state,
            loading: false,
            snapshot,
            fallback: "fallback" in output ? output.fallback ?? null : null,
            currentProviderId: snapshot.providerId,
          }
        } else {
          const output = (force
            ? await api.refresh(undefined, selection())
            : await api.getCurrent(selection())) as CurrentQuotaResponse
          state = {
            ...state,
            loading: false,
            snapshot: output.snapshot ?? null,
            fallback: output.fallback ?? null,
            currentProviderId: output.resolved?.billingProviderId ?? state.currentProviderId,
            routeConfidence: output.resolved?.confidence ?? state.routeConfidence,
            modelVendor: output.resolved?.modelVendor ?? state.modelVendor,
          }
        }
        notify()
        void actions.reloadProviders()
      } catch (error) {
        state = { ...state, loading: false, error: error instanceof Error ? error.message : String(error) }
        notify()
      }
    },
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    actions,
  }
}
