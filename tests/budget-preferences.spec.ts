import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_BUDGET_PREFERENCES,
  evaluateBudgets,
  evaluateCostBudget,
  normalizeBudgetPreferences,
  readBudgetPreferences,
  strongestBudgetEvaluation,
  writeBudgetPreferences,
  type BudgetStorage,
} from '../src/client/budget-preferences.ts'
import { BUDGET_PREFERENCES_STORAGE_KEY } from '../src/shared/usage.ts'

function aggregate(costCNY: number, hasPricing = true, hasUnpricedUsage = false) {
  return {
    inCacheHit: 100,
    inCacheMiss: 200,
    cacheWrite: 0,
    out: 50,
    costCNY,
    hasPricing,
    hasUnpricedUsage,
  }
}

class MemoryStorage implements BudgetStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

test('budget preferences normalize limits and clamp the warning ratio', () => {
  assert.deepEqual(normalizeBudgetPreferences({
    dailyCostLimitCNY: 12.345,
    rolling30DayCostLimitCNY: -1,
    warningRatio: 0.2,
  }), {
    dailyCostLimitCNY: 12.35,
    rolling30DayCostLimitCNY: null,
    warningRatio: 0.5,
  })
  assert.deepEqual(normalizeBudgetPreferences({ warningRatio: 9 }), {
    dailyCostLimitCNY: null,
    rolling30DayCostLimitCNY: null,
    warningRatio: 1,
  })
})

test('budget preferences persist safely and corrupt storage falls back to defaults', () => {
  const storage = new MemoryStorage()
  writeBudgetPreferences({ dailyCostLimitCNY: 5, rolling30DayCostLimitCNY: 50, warningRatio: 0.75 }, storage)
  assert.deepEqual(readBudgetPreferences(storage), {
    dailyCostLimitCNY: 5,
    rolling30DayCostLimitCNY: 50,
    warningRatio: 0.75,
  })
  storage.values.set(BUDGET_PREFERENCES_STORAGE_KEY, '{broken')
  assert.deepEqual(readBudgetPreferences(storage), DEFAULT_BUDGET_PREFERENCES)
})

test('cost budget evaluation distinguishes safe, warning, exceeded and unpriced usage', () => {
  assert.equal(evaluateCostBudget('daily', aggregate(7.9), 10, 0.8).level, 'ok')
  assert.equal(evaluateCostBudget('daily', aggregate(8), 10, 0.8).level, 'warning')
  assert.equal(evaluateCostBudget('daily', aggregate(10), 10, 0.8).level, 'exceeded')
  assert.equal(evaluateCostBudget('daily', aggregate(0, false), 10, 0.8).level, 'unpriced')
  assert.equal(evaluateCostBudget('daily', aggregate(8, true, true), 10, 0.8).level, 'unpriced')
  assert.equal(evaluateCostBudget('daily', aggregate(100), null, 0.8).level, 'disabled')
})

test('strongest budget alert prioritizes exceeded scope over a lower daily warning', () => {
  const evaluations = evaluateBudgets(aggregate(9), aggregate(120), {
    dailyCostLimitCNY: 10,
    rolling30DayCostLimitCNY: 100,
    warningRatio: 0.8,
  })
  const strongest = strongestBudgetEvaluation(evaluations)
  assert.equal(strongest?.scope, 'rolling-30-day')
  assert.equal(strongest?.level, 'exceeded')
  assert.equal(strongest?.ratio, 1.2)
})

test('zero-token days remain safe even before a price is configured', () => {
  const empty = { inCacheHit: 0, inCacheMiss: 0, cacheWrite: 0, out: 0, costCNY: 0, hasPricing: false, hasUnpricedUsage: false }
  assert.equal(evaluateCostBudget('daily', empty, 10, 0.8).level, 'ok')
})
