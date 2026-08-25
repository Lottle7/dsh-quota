import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBillingRoute, classifyModelVendor, unsupportedSnapshot } from '../src/host/route-resolver.ts'
import type { ProviderRegistry } from '../src/host/provider-registry.ts'

interface Entry { id: string; routeAliases: readonly string[]; modelVendors: readonly string[] }
function view(entries: Entry[]) {
  const m = new Map<string, Entry>()
  for (const e of entries) m.set(e.id, e)
  return m
}

const reg = view([
  { id: 'minimax-cn', routeAliases: ['minimax', 'minimax-cn', 'minimaxi', 'minimax-official'], modelVendors: ['minimax'] },
  { id: 'minimax-intl', routeAliases: ['minimax-intl', 'minimax-global', 'minimax-io'], modelVendors: ['minimax'] },
  { id: 'deepseek-official', routeAliases: ['deepseek', 'deepseek-official', 'deepseek-cn', 'deepseek-intl'], modelVendors: ['deepseek'] },
  { id: 'openrouter', routeAliases: ['openrouter', 'open-router'], modelVendors: ['openrouter'] },
])

test('Case 1: minimax-cn route resolves to the China account (exact alias)', () => {
  const route = resolveBillingRoute(
    { provider: 'minimax-cn', model: 'MiniMax-M2.7' },
    { registry: reg, explicitMappings: {} },
  )
  assert.equal(route.billingProviderId, 'minimax-cn')
  assert.equal(route.confidence, 'exact')
  assert.equal(route.modelVendor, 'minimax')
  assert.equal(route.model, 'MiniMax-M2.7')
})

test('MiniMax international aliases stay on the international account', () => {
  const route = resolveBillingRoute(
    { provider: 'minimax-global', model: 'MiniMax-M2.7' },
    { registry: reg, explicitMappings: {} },
  )
  assert.equal(route.billingProviderId, 'minimax-intl')
  assert.equal(route.confidence, 'exact')
})

test('Case 2: openrouter route with minimax/* model stays on openrouter (not minimax)', () => {
  const route = resolveBillingRoute(
    { provider: 'openrouter', model: 'minimax/MiniMax-M3' },
    { registry: reg, explicitMappings: {} },
  )
  assert.equal(route.billingProviderId, 'openrouter')
  assert.equal(route.modelVendor, 'minimax')
  assert.notEqual(route.billingProviderId, 'minimax-cn')
})

test('Case 3: explicit routeMapping wins over heuristic (confidence=mapped)', () => {
  const route = resolveBillingRoute(
    { provider: 'my-relay', model: 'deepseek-chat' },
    { registry: reg, explicitMappings: { 'my-relay': 'deepseek-official' } },
  )
  assert.equal(route.billingProviderId, 'deepseek-official')
  assert.equal(route.confidence, 'mapped')
  assert.equal(route.modelVendor, 'deepseek')
})

test('Unknown provider stays unknown (no false charge)', () => {
  const route = resolveBillingRoute(
    { provider: 'weird-future-vendor', model: 'some-model' },
    { registry: reg, explicitMappings: {} },
  )
  assert.equal(route.billingProviderId, 'unknown')
  assert.equal(route.confidence, 'unknown')
})

test('MiniMax through deepseek-intl route stays deepseek', () => {
  const route = resolveBillingRoute(
    { provider: 'deepseek-intl', model: 'MiniMax/MiniMax-M3' },
    { registry: reg, explicitMappings: {} },
  )
  assert.equal(route.billingProviderId, 'deepseek-official')
  assert.equal(route.modelVendor, 'minimax')
  assert.equal(route.confidence, 'exact')
})

test('classifyModelVendor handles slash, dash, and underscore separators', () => {
  assert.equal(classifyModelVendor('MiniMax/MiniMax-M3', reg), 'minimax')
  assert.equal(classifyModelVendor('MiniMax-M3', reg), 'minimax')
  assert.equal(classifyModelVendor('MiniMax_M3', reg), 'minimax')
  assert.equal(classifyModelVendor('MiniMax:M3', reg), 'minimax')
  assert.equal(classifyModelVendor('completely-unrelated', reg), undefined)
})

test('unsupportedSnapshot keeps stable layout for unknown providers', () => {
  const route = resolveBillingRoute(
    { provider: 'weird-future-vendor', model: 'some-model' },
    { registry: reg, explicitMappings: {} },
  )
  const snap = unsupportedSnapshot(route, '2026-01-01T00:00:00.000Z')
  assert.equal(snap.providerId, 'unknown')
  assert.equal(snap.status, 'unsupported')
  assert.equal(snap.fetchedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(snap.capabilities.balance, false)
  assert.equal(snap.capabilities.quota, false)
})

test('Heuristic fallback still differentiates between MiniMax-via-OpenRouter and MiniMax-direct', () => {
  // The billing provider is always the route provider; we never derive it from the model.
  const r1 = resolveBillingRoute({ provider: 'openrouter', model: 'minimax/MiniMax-M3' }, { registry: reg, explicitMappings: {} })
  const r2 = resolveBillingRoute({ provider: 'minimax', model: 'MiniMax-M3' }, { registry: reg, explicitMappings: {} })
  assert.notEqual(r1.billingProviderId, r2.billingProviderId)
})
