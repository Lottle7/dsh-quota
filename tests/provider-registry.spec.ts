import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderRegistry } from '../src/host/provider-registry.ts'
import { customProviderRecord } from '../src/host/index.ts'
import { normalizeCustomProviderConfig } from '../src/host/adapters/custom-json.ts'
import { resolveBillingRoute } from '../src/host/route-resolver.ts'

function record(id: string) {
  return {
    id,
    displayName: id,
    routeAliases: [id],
    modelVendors: [],
    credentialRefs: [],
    enabled: true,
    adapter: {
      id,
      displayName: id,
      credentialRefs: [],
      supported: true,
      fetch: async () => ({
        providerId: id,
        providerDisplayName: id,
        status: 'ok' as const,
        fetchedAt: new Date(0).toISOString(),
        capabilities: { balance: false, quota: false },
      }),
    },
  }
}

test('unregister removes both lookup and stable list order', () => {
  const registry = new ProviderRegistry()
  registry.register(record('one'))
  registry.register(record('two'))
  assert.equal(registry.unregister('one'), true)
  assert.equal(registry.unregister('missing'), false)
  assert.equal(registry.has('one'), false)
  assert.deepEqual(registry.ids(), ['two'])
  registry.register(record('one'))
  assert.deepEqual(registry.ids(), ['two', 'one'])
})

test('custom provider records flow into provider cards and route resolution', async () => {
  const registry = new ProviderRegistry()
  const config = normalizeCustomProviderConfig({
    id: 'company-relay',
    displayName: 'Company Relay',
    kind: 'local',
    routeAliases: ['internal-llm'],
    brandColor: '#123456',
  })
  registry.register({ ...customProviderRecord(config), enabled: true })
  const providers = await registry.list({ configured: async () => false })
  assert.equal(providers[0]?.custom, true)
  assert.equal(providers[0]?.configured, true)
  assert.equal(providers[0]?.brandColor, '#123456')
  const route = resolveBillingRoute(
    { provider: 'internal-llm', model: 'vendor/model' },
    { registry: registry.asResolverView(), explicitMappings: {} },
  )
  assert.equal(route.billingProviderId, 'company-relay')
  assert.equal(route.confidence, 'exact')
})

test('provider-list payload omits custom endpoint and credential reference', async () => {
  const registry = new ProviderRegistry()
  const config = normalizeCustomProviderConfig({
    id: 'remote-billing',
    displayName: 'Remote Billing',
    kind: 'http-json',
    endpoint: 'https://billing.example.com/v1/account',
    credentialRef: 'REMOTE_BILLING_KEY',
    auth: 'bearer',
    balancePath: 'data.balance',
  })
  registry.register({ ...customProviderRecord(config), enabled: true })
  const payload = JSON.stringify(await registry.list({ configured: async () => true }))
  assert.equal(payload.includes('billing.example.com'), false)
  assert.equal(payload.includes('REMOTE_BILLING_KEY'), false)
})
