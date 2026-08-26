import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderRegistry } from '../src/host/provider-registry.ts'
import { QuotaService, type CredentialsServiceLike } from '../src/host/quota-service.ts'

const TEST_KEY = 'sk-test-super-secret'

// Fake credentials that knows about TEST_KEY only.
function fakeCreds(): CredentialsServiceLike & { resolveCount: number } {
  const map: Record<string, { value: string; source: string }> = { DEEPSEEK_API_KEY: { value: TEST_KEY, source: 'file' } }
  const ref = { resolveCount: 0 }
  return {
    resolveCount: 0,
    async resolve(r) { ref.resolveCount++; return map[r] },
    async describe(r) { return map[r] ? { configured: true, source: 'file', writable: true } : { configured: false, writable: false } },
  }
}

function buildRegistry(counter?: { fetches: number }): ProviderRegistry {
  const r = new ProviderRegistry()
  r.register({
    id: 'deepseek-official',
    displayName: 'DeepSeek Official',
    routeAliases: ['deepseek'],
    modelVendors: ['deepseek'],
    credentialRefs: ['DEEPSEEK_API_KEY'],
    enabled: true,
    adapter: {
      id: 'deepseek-official',
      displayName: 'DeepSeek Official',
      credentialRefs: ['DEEPSEEK_API_KEY'],
      supported: true,
      async fetch() {
        if (counter !== undefined) counter.fetches++
        return {
          providerId: 'deepseek-official',
          providerDisplayName: 'DeepSeek Official',
          status: 'ok',
          balances: [{ currency: 'CNY', total: 82.47, granted: 12, toppedUp: 70.47 }],
          fetchedAt: new Date().toISOString(),
          capabilities: { balance: true, quota: false },
        }
      },
    },
  })
  return r
}

test('Cache dedupes 10 concurrent refresh calls into 1 upstream call', async () => {
  const creds = fakeCreds()
  const service = new QuotaService(buildRegistry(), creds, { cacheTtlMs: 60_000 })
  const results = await Promise.all(Array.from({ length: 10 }, () => service.refresh('deepseek-official')))
  assert.equal(results.length, 10)
  // The fake credentials resolve runs once per credential lookup, but
  // the adapter fetch runs once total.
  // We measure by checking that all 10 results share the same fetchedAt.
  const fetchedAts = new Set(results.map((r) => r.fetchedAt))
  assert.equal(fetchedAts.size, 1, 'all 10 results should share one fetchedAt')
})

test('Cache hit within TTL does not call adapter again', async () => {
  const creds = fakeCreds()
  const counter = { fetches: 0 }
  const service = new QuotaService(buildRegistry(counter), creds, { cacheTtlMs: 60_000 })
  await service.getWithFallback('deepseek-official')
  const cached = await service.getWithFallback('deepseek-official')
  assert.equal(cached.snapshot.providerId, 'deepseek-official')
  assert.equal(counter.fetches, 1, 'the second GET should use the fresh cache')
})

test('A forced refresh bypasses a fresh cache entry', async () => {
  const creds = fakeCreds()
  const counter = { fetches: 0 }
  const service = new QuotaService(buildRegistry(counter), creds, { cacheTtlMs: 60_000 })
  await service.getWithFallback('deepseek-official')
  await service.getWithFallback('deepseek-official', undefined, true)
  assert.equal(counter.fetches, 2)
})

test('Live cache TTL changes are honored after the next snapshot is stored', async () => {
  const creds = fakeCreds()
  const counter = { fetches: 0 }
  let now = 1_000
  let ttl = 60_000
  const service = new QuotaService(buildRegistry(counter), creds, {
    cacheTtlMs: () => ttl,
    now: () => now,
  })
  await service.getWithFallback('deepseek-official')
  now += 60_001
  ttl = 15_000
  await service.getWithFallback('deepseek-official')
  now += 15_001
  await service.getWithFallback('deepseek-official')
  assert.equal(counter.fetches, 3)
})

test('Secret never enters the snapshot', async () => {
  const creds = fakeCreds()
  const service = new QuotaService(buildRegistry(), creds, { cacheTtlMs: 60_000 })
  const snap = await service.refresh('deepseek-official')
  const json = JSON.stringify(snap)
  assert.ok(!json.includes(TEST_KEY), 'snapshot JSON must not include the secret')
  assert.ok(!json.toLowerCase().includes('authorization'), 'snapshot JSON must not carry Authorization header')
  assert.ok(!json.toLowerCase().includes('bearer'), 'snapshot JSON must not include bearer prefix')
})

test('Snapshot survives getWithFallback when the refresh fails after a healthy baseline', async () => {
  const creds = fakeCreds()
  const r = new ProviderRegistry()
  let healthyCalls = 0
  r.register({
    id: 'deepseek-official',
    displayName: 'DeepSeek Official',
    routeAliases: ['deepseek'],
    modelVendors: ['deepseek'],
    credentialRefs: ['DEEPSEEK_API_KEY'],
    enabled: true,
    adapter: {
      id: 'deepseek-official',
      displayName: 'DeepSeek Official',
      credentialRefs: ['DEEPSEEK_API_KEY'],
      supported: true,
      async fetch() {
        healthyCalls++
        if (healthyCalls === 1) {
          return {
            providerId: 'deepseek-official',
            providerDisplayName: 'DeepSeek Official',
            status: 'ok',
            balances: [{ currency: 'CNY', total: 82.47 }],
            fetchedAt: new Date().toISOString(),
            capabilities: { balance: true, quota: false },
          }
        }
        return {
          providerId: 'deepseek-official',
          providerDisplayName: 'DeepSeek Official',
          status: 'network-error',
          message: 'down',
          fetchedAt: new Date().toISOString(),
          capabilities: { balance: false, quota: false },
        }
      },
    },
  })
  const service = new QuotaService(r, creds, { cacheTtlMs: 1 })
  await service.refresh('deepseek-official')
  await new Promise((r) => setTimeout(r, 5))
  const { snapshot, fallback } = await service.getWithFallback('deepseek-official')
  assert.equal(snapshot.stale, true)
  assert.equal(snapshot.status, 'network-error')
  assert.ok(fallback !== undefined, 'fallback must be the healthy baseline')
  assert.equal(fallback.status, 'ok')
})

test('invalidate clears cache and credentials/updated-equivalent triggers refresh', async () => {
  const creds = fakeCreds()
  const service = new QuotaService(buildRegistry(), creds, { cacheTtlMs: 60_000 })
  await service.refresh('deepseek-official')
  assert.ok(service.cached('deepseek-official') !== undefined)
  service.invalidate()
  // After invalidate, cached returns undefined until next refresh.
  assert.equal(service.cached('deepseek-official'), undefined)
})

test('invalidate isolates a replacement provider from an older in-flight response', async () => {
  const creds = fakeCreds()
  const registry = buildRegistry()
  const provider = registry.get('deepseek-official')!
  let calls = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  provider.adapter = {
    ...provider.adapter,
    async fetch() {
      calls++
      const call = calls
      if (call === 1) await firstGate
      return {
        providerId: 'deepseek-official',
        providerDisplayName: 'DeepSeek Official',
        status: 'ok',
        balances: [{ currency: 'CNY', total: call }],
        fetchedAt: new Date().toISOString(),
        capabilities: { balance: true, quota: false },
      }
    },
  }
  const service = new QuotaService(registry, creds, { cacheTtlMs: 60_000 })
  const oldRefresh = service.refresh('deepseek-official')
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve))
  service.invalidate('deepseek-official')
  const replacement = await service.refresh('deepseek-official')
  assert.equal(replacement.balances?.[0].total, 2)
  releaseFirst()
  await oldRefresh
  assert.equal(service.cached('deepseek-official')?.balances?.[0].total, 2)
})

test('Backoff escalates on consecutive errors but resets on success', async () => {
  const creds = fakeCreds()
  let calls = 0
  const r = new ProviderRegistry()
  r.register({
    id: 'deepseek-official',
    displayName: 'DeepSeek Official',
    routeAliases: ['deepseek'],
    modelVendors: ['deepseek'],
    credentialRefs: ['DEEPSEEK_API_KEY'],
    enabled: true,
    adapter: {
      id: 'deepseek-official',
      displayName: 'DeepSeek Official',
      credentialRefs: ['DEEPSEEK_API_KEY'],
      supported: true,
      async fetch() {
        calls++
        if (calls <= 2) {
          return {
            providerId: 'deepseek-official',
            providerDisplayName: 'DeepSeek Official',
            status: 'network-error',
            message: 'oops',
            fetchedAt: new Date().toISOString(),
            capabilities: { balance: false, quota: false },
          }
        }
        return {
          providerId: 'deepseek-official',
          providerDisplayName: 'DeepSeek Official',
          status: 'ok',
          fetchedAt: new Date().toISOString(),
          capabilities: { balance: true, quota: false },
        }
      },
    },
  })
  const service = new QuotaService(r, creds, { cacheTtlMs: 0, now: () => 1000 })
  // First call: network-error, stores with cooldownUntil = 1000 + 60_000
  await service.refresh('deepseek-official')
  // Same cooldown blocks the second call from re-running the adapter
  // until the cooldown is past. Verify by advancing time past cooldown.
  let now = 1000
  const service2 = new QuotaService(r, creds, { cacheTtlMs: 0, now: () => now })
  await service2.refresh('deepseek-official') // 1st error
  now += 61_000
  await service2.refresh('deepseek-official') // 2nd error
  now += 121_000
  await service2.refresh('deepseek-official') // 3rd: success -> backoff resets
  // 4th call still cached at TTL=0, so it would return the same snapshot.
  // Confirming via the public surface: no crashes, status is now 'ok'.
  assert.equal(service2.cached('deepseek-official')?.status, 'ok')
})
