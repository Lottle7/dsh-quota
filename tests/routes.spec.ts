import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ProviderRegistry } from '../src/host/provider-registry.ts'
import { QuotaService, type CredentialsServiceLike } from '../src/host/quota-service.ts'
import { makeQuotaRoutes } from '../src/host/routes.ts'
import { isTrustedBrowserRequest } from '../src/host/index.ts'
import { RPC_PATHS } from '../src/shared/types.ts'

const creds: CredentialsServiceLike = {
  async resolve() { return { value: 'test-key', source: 'test' } },
  async describe() { return { configured: true, source: 'test', writable: false } },
}

function fixture(enabled = true) {
  let fetches = 0
  const registry = new ProviderRegistry()
  registry.register({
    id: 'openrouter',
    displayName: 'OpenRouter',
    routeAliases: ['openrouter'],
    modelVendors: ['openrouter'],
    credentialRefs: ['OPENROUTER_API_KEY'],
    enabled,
    adapter: {
      id: 'openrouter',
      displayName: 'OpenRouter',
      credentialRefs: ['OPENROUTER_API_KEY'],
      supported: true,
      async fetch() {
        fetches++
        return {
          providerId: 'openrouter',
          providerDisplayName: 'OpenRouter',
          status: 'ok',
          fetchedAt: new Date(0).toISOString(),
          capabilities: { balance: true, quota: true, usage: true },
        }
      },
    },
  })
  registry.register({
    id: 'minimax-cn',
    displayName: 'MiniMax China',
    routeAliases: ['minimax', 'minimax-cn'],
    modelVendors: ['minimax'],
    credentialRefs: ['MINIMAX_API_KEY'],
    enabled: true,
    adapter: {
      id: 'minimax-cn',
      displayName: 'MiniMax China',
      credentialRefs: ['MINIMAX_API_KEY'],
      supported: true,
      async fetch() {
        throw new Error('MiniMax adapter should not be called for an OpenRouter route')
      },
    },
  })
  const service = new QuotaService(registry, creds, { cacheTtlMs: 60_000 })
  return { registry, service, fetches: () => fetches }
}

function request(url: string, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  return { url, method, headers } as IncomingMessage
}

function response(): ServerResponse & { statusCodeSeen: number; json(): unknown } {
  let statusCodeSeen = 0
  let body = ''
  const headers: Record<string, string> = {}
  return {
    get statusCodeSeen() { return statusCodeSeen },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this },
    writeHead(status: number, nextHeaders?: Record<string, string>) {
      statusCodeSeen = status
      Object.assign(headers, nextHeaders)
      return this
    },
    end(value?: string) { body = value ?? ''; return this },
    json() { return JSON.parse(body) as unknown },
  } as unknown as ServerResponse & { statusCodeSeen: number; json(): unknown }
}

function handlerFor(enabled = true) {
  const data = fixture(enabled)
  const routes = makeQuotaRoutes({ registry: data.registry, service: data.service }).routes
  return {
    ...data,
    run: async (path: string, req: IncomingMessage) => {
      const route = routes.find((item) => item.path === path)
      assert.ok(route, `missing route ${path}`)
      const res = response()
      await route.handler(req, res)
      return res
    },
  }
}

test('current route uses the explicit current-session selection from the browser', async () => {
  const api = handlerFor()
  const query = new URLSearchParams({
    sessionId: 'session-7',
    provider: 'openrouter',
    model: 'minimax/MiniMax-M2',
    reasoningEffort: 'high',
  })
  const res = await api.run(RPC_PATHS.getCurrent, request(`${RPC_PATHS.getCurrent}?${query}`))
  const body = res.json() as {
    selection: { sessionId: string; provider: string; model: string }
    resolved: { billingProviderId: string; modelVendor: string }
    snapshot: { routeProvider: string; model: string }
  }
  assert.equal(res.statusCodeSeen, 200)
  assert.deepEqual(body.selection, {
    sessionId: 'session-7',
    provider: 'openrouter',
    model: 'minimax/MiniMax-M2',
    reasoningEffort: 'high',
  })
  assert.equal(body.resolved.billingProviderId, 'openrouter')
  assert.equal(body.resolved.modelVendor, 'minimax')
  assert.equal(body.snapshot.routeProvider, 'openrouter')
  assert.equal(api.fetches(), 1)
})

test('refresh route requires JSON and rejects disabled providers before fetch', async () => {
  const missingType = handlerFor()
  const first = await missingType.run(
    RPC_PATHS.refresh,
    request(`${RPC_PATHS.refresh}?id=openrouter`, 'POST'),
  )
  assert.equal(first.statusCodeSeen, 415)
  assert.equal(missingType.fetches(), 0)

  const disabled = handlerFor(false)
  const second = await disabled.run(
    RPC_PATHS.refresh,
    request(`${RPC_PATHS.refresh}?id=openrouter`, 'POST', { 'content-type': 'application/json' }),
  )
  assert.equal(second.statusCodeSeen, 409)
  assert.equal(disabled.fetches(), 0)
})

test('browser trust fence allows loopback and explicitly configured LAN hosts only', () => {
  const loopback = request('/', 'GET', { host: '127.0.0.1:13521', origin: 'http://127.0.0.1:13521' })
  assert.equal(isTrustedBrowserRequest(loopback, []), true)

  const crossSite = request('/', 'GET', { host: 'localhost:13521', 'sec-fetch-site': 'cross-site' })
  assert.equal(isTrustedBrowserRequest(crossSite, []), false)

  const lan = request('/', 'GET', { host: '192.168.1.9:13521', origin: 'http://192.168.1.9:13521' })
  assert.equal(isTrustedBrowserRequest(lan, []), false)
  assert.equal(isTrustedBrowserRequest(lan, ['192.168.1.9:13521']), true)

  const mismatchedOrigin = request('/', 'GET', { host: 'localhost:13521', origin: 'https://evil.example' })
  assert.equal(isTrustedBrowserRequest(mismatchedOrigin, []), false)
})
