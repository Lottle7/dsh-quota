import { test } from "node:test"
import assert from "node:assert/strict"
import { createOpenRouterAdapter } from "../src/host/adapters/openrouter.ts"
import type { QuotaAdapterContext } from "../src/host/adapters/base.ts"

const originalFetch = globalThis.fetch
const context = (key?: string): QuotaAdapterContext => ({
  providerId: "openrouter",
  probeCredential: async () => key !== undefined,
  resolveSecret: async () => key,
})

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    return handler(url, init)
  }) as typeof fetch
}

test("OpenRouter normalizes current-key usage and limit", async () => {
  let authorization = ""
  mockFetch((_url, init) => {
    authorization = (init?.headers as Record<string, string>).authorization
    return new Response(JSON.stringify({
      data: {
        label: "quota-test",
        usage: 25.5,
        usage_daily: 1.25,
        usage_weekly: 8.5,
        usage_monthly: 20,
        limit: 100,
        limit_remaining: 74.5,
        limit_reset: "monthly",
      },
    }), { status: 200 })
  })
  const snapshot = await createOpenRouterAdapter().fetch(context("sk-or-test"))
  assert.equal(authorization, "Bearer sk-or-test")
  assert.equal(snapshot.status, "ok")
  assert.equal(snapshot.balances?.[0].total, 74.5)
  assert.equal(snapshot.usage?.monthly, 20)
  assert.equal(snapshot.quotas?.[0].remainingRatio, 0.745)
})

test("OpenRouter works when a key has no spending limit", async () => {
  mockFetch(() => new Response(JSON.stringify({ data: { usage: 2.5, limit: null, limit_remaining: null } }), { status: 200 }))
  const snapshot = await createOpenRouterAdapter().fetch(context("sk-or-test"))
  assert.equal(snapshot.status, "ok")
  assert.equal(snapshot.usage?.total, 2.5)
  assert.equal(snapshot.balances, undefined)
})

test("OpenRouter handles missing keys and authentication errors", async () => {
  let called = false
  mockFetch(() => { called = true; return new Response("", { status: 401 }) })
  assert.equal((await createOpenRouterAdapter().fetch(context())).status, "not-configured")
  assert.equal(called, false)
  assert.equal((await createOpenRouterAdapter().fetch(context("bad"))).status, "auth-error")
})

test.afterEach(() => { globalThis.fetch = originalFetch })
