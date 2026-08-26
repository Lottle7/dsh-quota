import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCustomJsonAdapter,
  isPublicAddress,
  normalizeCustomProviderConfig,
  normalizeCustomProviderSet,
  readJsonPath,
  validateCustomEndpointUrl,
  type CustomJsonTransport,
} from '../src/host/adapters/custom-json.ts'
import type { QuotaAdapterContext } from '../src/host/adapters/base.ts'

function context(secret?: string): QuotaAdapterContext {
  return {
    providerId: 'my-relay',
    probeCredential: async () => secret !== undefined,
    resolveSecret: async () => secret,
  }
}

function remoteConfig(overrides: Record<string, unknown> = {}) {
  return normalizeCustomProviderConfig({
    id: 'my-relay',
    displayName: 'My Relay',
    kind: 'http-json',
    endpoint: 'https://billing.example.com/v1/balance',
    credentialRef: 'MY_RELAY_API_KEY',
    auth: 'bearer',
    balancePath: 'data.balance',
    currency: 'USD',
    ...overrides,
  })
}

test('normalizes metadata, aliases and credential references', () => {
  const config = remoteConfig({
    routeAliases: ['My-Route', 'my-route'],
    modelVendors: ['Acme'],
    brandColor: '#AABBCC',
  })
  assert.deepEqual(config.routeAliases, ['my-relay', 'my-route'])
  assert.deepEqual(config.modelVendors, ['acme'])
  assert.equal(config.brandColor, '#aabbcc')
  assert.equal(config.credentialRef, 'MY_RELAY_API_KEY')
})

test('rejects unsafe endpoint and mapping configuration', () => {
  assert.throws(() => remoteConfig({ endpoint: 'http://billing.example.com/balance' }), /public HTTPS/)
  assert.throws(() => remoteConfig({ endpoint: 'https://127.0.0.1/balance' }), /private or reserved/)
  assert.throws(() => remoteConfig({ endpoint: 'https://billing.example.com/balance?token=literal' }), /public HTTPS/)
  assert.throws(() => remoteConfig({ balancePath: 'data.__proto__.balance' }), /safe dot-separated/)
  assert.throws(() => remoteConfig({ credentialRef: 'literal-secret' }), /credentialRef/)
  assert.throws(() => remoteConfig({ id: 'Bad Provider' }), /id must/)
})

test('public address filter rejects local, private and documentation ranges', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '198.18.0.1', '192.0.2.1', '198.51.100.2', '203.0.113.3',
    '::1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', '2001:db8::1',
  ]) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress('1.1.1.1'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
})

test('validateCustomEndpointUrl accepts only fixed public HTTPS endpoints', () => {
  assert.equal(validateCustomEndpointUrl('https://api.example.com/v1/balance').protocol, 'https:')
  assert.throws(() => validateCustomEndpointUrl('https://user:pass@api.example.com/v1'), /public HTTPS/)
  assert.throws(() => validateCustomEndpointUrl('https://api.example.com:8443/v1'), /port 443/)
})

test('readJsonPath supports objects and numeric array segments without prototype access', () => {
  const body = { data: [{ balance: '12.5' }] }
  assert.equal(readJsonPath(body, 'data.0.balance'), '12.5')
  assert.equal(readJsonPath(body, 'constructor.prototype'), undefined)
  assert.equal(readJsonPath(body, 'data.one.balance'), undefined)
})

test('maps balance, usage and limit fields with valueScale', async () => {
  let capturedHeaders: Record<string, string> | undefined
  const transport: CustomJsonTransport = async (request) => {
    capturedHeaders = request.headers
    return {
      status: 200,
      ok: true,
      truncated: false,
      text: JSON.stringify({ data: { balance: '12500', usage: 2500, limit: '10000' } }),
    }
  }
  const config = remoteConfig({
    usagePath: 'data.usage',
    limitPath: 'data.limit',
    valueScale: 0.001,
  })
  const snapshot = await createCustomJsonAdapter(config, transport).fetch(context('sk-custom-secret'))
  assert.equal(capturedHeaders?.authorization, 'Bearer sk-custom-secret')
  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.balances?.[0].total, 12.5)
  assert.equal(snapshot.usage?.total, 2.5)
  assert.equal(snapshot.usage?.limit, 10)
  assert.equal(snapshot.usage?.remaining, 7.5)
  assert.equal(snapshot.quotas?.[0].remainingRatio, 0.75)
  assert.equal(JSON.stringify(snapshot).includes('sk-custom-secret'), false)
})

test('supports X-API-Key and explicit remaining mappings', async () => {
  let apiKey: string | undefined
  const transport: CustomJsonTransport = async (request) => {
    apiKey = request.headers['x-api-key']
    return { status: 200, ok: true, truncated: false, text: '{"meta":{"left":"8"}}' }
  }
  const config = remoteConfig({
    auth: 'x-api-key',
    balancePath: '',
    remainingPath: 'meta.left',
    limitPath: 'meta.limit',
  })
  const snapshot = await createCustomJsonAdapter(config, transport).fetch(context('key-value'))
  assert.equal(apiKey, 'key-value')
  assert.equal(snapshot.balances?.[0].total, 8)
  assert.equal(snapshot.usage?.remaining, 8)
})

test('missing credential never calls the endpoint', async () => {
  let called = false
  const transport: CustomJsonTransport = async () => {
    called = true
    return { status: 200, ok: true, truncated: false, text: '{}' }
  }
  const snapshot = await createCustomJsonAdapter(remoteConfig(), transport).fetch(context())
  assert.equal(called, false)
  assert.equal(snapshot.status, 'not-configured')
})

test('maps authentication, redirect, rate limit and malformed response failures safely', async () => {
  for (const [httpStatus, expected] of [[401, 'auth-error'], [302, 'error'], [429, 'rate-limited']] as const) {
    const adapter = createCustomJsonAdapter(remoteConfig(), async () => ({
      status: httpStatus, ok: false, truncated: false, text: 'upstream-secret-body',
    }))
    const snapshot = await adapter.fetch(context('secret'))
    assert.equal(snapshot.status, expected)
    assert.equal(JSON.stringify(snapshot).includes('upstream-secret-body'), false)
  }
  const malformed = await createCustomJsonAdapter(remoteConfig(), async () => ({
    status: 200, ok: true, truncated: false, text: 'not-json',
  })).fetch(context('secret'))
  assert.equal(malformed.status, 'error')
  const missing = await createCustomJsonAdapter(remoteConfig(), async () => ({
    status: 200, ok: true, truncated: false, text: '{"data":{"other":1}}',
  })).fetch(context('secret'))
  assert.equal(missing.status, 'error')
  const overflow = await createCustomJsonAdapter(remoteConfig({ valueScale: 1_000_000_000 }), async () => ({
    status: 200, ok: true, truncated: false, text: '{"data":{"balance":"1e308"}}',
  })).fetch(context('secret'))
  assert.equal(overflow.status, 'error')
})

test('local custom providers need neither endpoint nor credential', () => {
  const config = normalizeCustomProviderConfig({
    id: 'private-gateway',
    displayName: 'Private Gateway',
    kind: 'local',
    routeAliases: ['private-route'],
  })
  assert.equal(config.kind, 'local')
  assert.equal(config.endpoint, undefined)
  assert.equal(config.credentialRef, undefined)
})

test('provider sets reject duplicate ids and route aliases', () => {
  const local = (id: string, alias: string) => ({ id, displayName: id, kind: 'local' as const, routeAliases: [alias] })
  assert.throws(() => normalizeCustomProviderSet([local('one', 'route'), local('one', 'other')]), /id "one"/)
  assert.throws(() => normalizeCustomProviderSet([local('one', 'route'), local('two', 'route')]), /alias "route"/)
  assert.throws(() => normalizeCustomProviderSet([local('deepseek-official', 'other')], new Set(['deepseek-official'])), /already registered/)
  assert.throws(() => normalizeCustomProviderSet([local('one', 'deepseek')], new Set(), new Set(['deepseek'])), /already registered/)
})
