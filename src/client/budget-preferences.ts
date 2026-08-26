import { BUDGET_PREFERENCES_STORAGE_KEY } from "../shared/usage.ts"
import type { UsageAggregate } from "./usage-store.ts"

export interface BudgetPreferences {
  dailyCostLimitCNY: number | null
  rolling30DayCostLimitCNY: number | null
  /** Ratio from 0.5 to 1 at which the UI enters warning state. */
  warningRatio: number
}

export type BudgetScope = "daily" | "rolling-30-day"
export type BudgetLevel = "disabled" | "unpriced" | "ok" | "warning" | "exceeded"

export interface BudgetEvaluation {
  scope: BudgetScope
  limitCNY: number | null
  spentCNY: number
  ratio: number
  level: BudgetLevel
}

export interface BudgetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_BUDGET_PREFERENCES: BudgetPreferences = {
  dailyCostLimitCNY: null,
  rolling30DayCostLimitCNY: null,
  warningRatio: 0.8,
}

export function normalizeBudgetPreferences(value: unknown): BudgetPreferences {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_BUDGET_PREFERENCES }
  const input = value as Partial<Record<keyof BudgetPreferences, unknown>>
  return {
    dailyCostLimitCNY: budgetLimit(input.dailyCostLimitCNY),
    rolling30DayCostLimitCNY: budgetLimit(input.rolling30DayCostLimitCNY),
    warningRatio: warningRatio(input.warningRatio),
  }
}

export function readBudgetPreferences(storage = browserStorage()): BudgetPreferences {
  if (storage === undefined) return { ...DEFAULT_BUDGET_PREFERENCES }
  try {
    const raw = storage.getItem(BUDGET_PREFERENCES_STORAGE_KEY)
    return raw === null ? { ...DEFAULT_BUDGET_PREFERENCES } : normalizeBudgetPreferences(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_BUDGET_PREFERENCES }
  }
}

export function writeBudgetPreferences(preferences: BudgetPreferences, storage = browserStorage()): void {
  if (storage === undefined) return
  try {
    storage.setItem(BUDGET_PREFERENCES_STORAGE_KEY, JSON.stringify(normalizeBudgetPreferences(preferences)))
  } catch {
    // Private browsing and full storage must not break quota rendering.
  }
}

export function evaluateCostBudget(
  scope: BudgetScope,
  aggregate: UsageAggregate,
  limitCNY: number | null,
  warningAt: number,
): BudgetEvaluation {
  const safeLimit = budgetLimit(limitCNY)
  const spentCNY = Number.isFinite(aggregate.costCNY) ? Math.max(0, aggregate.costCNY) : 0
  if (safeLimit === null) return { scope, limitCNY: null, spentCNY, ratio: 0, level: "disabled" }
  const tokenCount = aggregate.inCacheHit + aggregate.inCacheMiss + aggregate.cacheWrite + aggregate.out
  const ratio = spentCNY / safeLimit
  if (tokenCount > 0 && (!aggregate.hasPricing || aggregate.hasUnpricedUsage === true)) {
    return { scope, limitCNY: safeLimit, spentCNY, ratio, level: "unpriced" }
  }
  const level: BudgetLevel = ratio >= 1
    ? "exceeded"
    : ratio >= warningRatio(warningAt) ? "warning" : "ok"
  return { scope, limitCNY: safeLimit, spentCNY, ratio, level }
}

export function evaluateBudgets(
  today: UsageAggregate,
  rolling30Day: UsageAggregate,
  preferences: BudgetPreferences,
): BudgetEvaluation[] {
  return [
    evaluateCostBudget("daily", today, preferences.dailyCostLimitCNY, preferences.warningRatio),
    evaluateCostBudget("rolling-30-day", rolling30Day, preferences.rolling30DayCostLimitCNY, preferences.warningRatio),
  ]
}

export function strongestBudgetEvaluation(evaluations: readonly BudgetEvaluation[]): BudgetEvaluation | null {
  const active = evaluations.filter((item) => item.level !== "disabled")
  if (active.length === 0) return null
  const severity: Record<BudgetLevel, number> = {
    disabled: 0,
    ok: 1,
    unpriced: 2,
    warning: 3,
    exceeded: 4,
  }
  return [...active].sort((left, right) =>
    severity[right.level] - severity[left.level] || right.ratio - left.ratio)[0] ?? null
}

function budgetLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000_000
    ? Math.round(value * 100) / 100
    : null
}

function warningRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0.5, Math.min(1, Math.round(value * 100) / 100))
    : DEFAULT_BUDGET_PREFERENCES.warningRatio
}

function browserStorage(): BudgetStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage } catch { return undefined }
}
