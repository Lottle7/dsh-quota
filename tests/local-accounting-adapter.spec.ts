import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalAccountingAdapter } from '../src/host/adapters/local-accounting.ts'
import { ProviderRegistry } from '../src/host/provider-registry.ts'

test('local accounting adapter is healthy without resolving a credential', async () => {
  const adapter = createLocalAccountingAdapter({ id: 'together', displayName: 'Together AI' })
  let secretReads = 0
  const snapshot = await adapter.fetch({
    providerId: 'together',
    probeCredential: async () => false,
    resolveSecret: async () => { secretReads += 1; return undefined },
  })
  assert.equal(secretReads, 0)
  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.capabilities.localAccounting, true)
  assert.equal(snapshot.balances, undefined)
  assert.equal(snapshot.quotas, undefined)
})

test('registry marks credential-free local accounting providers as configured', async () => {
  const adapter = createLocalAccountingAdapter({ id: 'moonshot', displayName: 'Moonshot / Kimi' })
  const registry = new ProviderRegistry()
  registry.register({
    id: adapter.id,
    displayName: adapter.displayName,
    routeAliases: ['moonshot', 'kimi'],
    modelVendors: [],
    enabled: true,
    credentialRefs: adapter.credentialRefs,
    capabilities: { balance: false, quota: false, localAccounting: true },
    adapter,
  })
  const [provider] = await registry.list({ configured: async () => false })
  assert.equal(provider.configured, true)
  assert.equal(provider.canRefresh, true)
  assert.equal(provider.capabilities?.localAccounting, true)
})
