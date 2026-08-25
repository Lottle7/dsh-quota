import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMiniMaxAdapter } from '../src/host/adapters/minimax.ts'
import type { QuotaAdapterContext } from '../src/host/adapters/base.ts'

function ctxWithKey(value: string | undefined): QuotaAdapterContext {
  return {
    providerId: 'minimax-official',
    probeCredential: async () => value !== undefined && value.length > 0,
    resolveSecret: async (ref) => ref.includes('COOKIE') ? undefined : value,
  }
}

const originalFetch = globalThis.fetch
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return impl(url, init)
  }) as typeof fetch
}

test('Healthy variant 1: code/data/5h/weekly/plan_tier', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    code: 0,
    data: {
      plan_tier: 'pro',
      '5h': { remaining: 72, total: 100, reset_at: '2026-01-01T05:00:00Z' },
      weekly: { remaining: 54, total: 100 },
    },
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'ok')
  assert.equal(snap.quotas?.length, 3) // tier + 5h + weekly
  const five = snap.quotas!.find((q) => q.id === '5h')
  assert.equal(five?.remainingRatio, 0.72)
  const week = snap.quotas!.find((q) => q.id === 'weekly')
  assert.equal(week?.remainingRatio, 0.54)
})

test('Variant 2: kebab keys (5-hour / weekly) with usage/limit', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    '5-hour': { usage: 28, limit: 100 },
    weekly: { usage: 46, limit: 100 },
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'ok')
  const five = snap.quotas!.find((q) => q.id === '5h')
  assert.equal(five?.remainingRatio, 0.72)
})

test('Variant 3: flat fields (remaining_5h / total_5h)', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    remaining_5h: 36, total_5h: 100,
    remaining_weekly: 50, total_weekly: 100,
    reset_at_5h: '2026-01-01T05:00:00Z',
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'ok')
  const five = snap.quotas!.find((q) => q.id === '5h')
  assert.equal(five?.remainingRatio, 0.36)
})

test('Malformed JSON becomes error, not zero', async () => {
  mockFetch(async () => new Response('not-json', { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'error')
})

test('401 becomes auth-error', async () => {
  mockFetch(async () => new Response('nope', { status: 401 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'auth-error')
})

test('429 becomes rate-limited', async () => {
  mockFetch(async () => new Response('limit', { status: 429 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'rate-limited')
})

test('404 becomes unsupported (endpoint moved)', async () => {
  mockFetch(async () => new Response('missing', { status: 404 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'unsupported')
})

test('Network error becomes network-error, not exhausted', async () => {
  mockFetch(async () => { throw new Error('ETIMEDOUT') })
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'network-error')
})

test('Missing key becomes not-configured (no remote call)', async () => {
  let called = false
  mockFetch(async () => { called = true; return new Response('', { status: 200 }) })
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey(undefined))
  assert.equal(called, false)
  assert.equal(snap.status, 'not-configured')
})

test('Percentages >100 are clamped to 1 (not silently exhausted)', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    code: 0,
    data: {
      '5h': { remaining: 200, total: 100 },
    },
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  const five = snap.quotas!.find((q) => q.id === '5h')
  assert.equal(five?.remainingRatio, 1)
  assert.equal(snap.status, 'ok')
})

test('Negative percentages clamp to 0', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    code: 0,
    data: {
      '5h': { remaining: -5, total: 100 },
    },
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  const five = snap.quotas!.find((q) => q.id === '5h')
  assert.equal(five?.remainingRatio, 0)
  assert.equal(snap.status, 'exhausted')
})

test('Region=cn routes to the CN endpoint', async () => {
  let url = ''
  mockFetch(async (u) => { url = u; return new Response(JSON.stringify({ code: 0, data: { '5h': { remaining: 80, total: 100 } } }), { status: 200 }) })
  await createMiniMaxAdapter({ region: 'cn' }).fetch(ctxWithKey('sk-test'))
  assert.ok(url.includes('minimaxi.com'))
})

test('Region=intl routes to the international endpoint', async () => {
  let url = ''
  mockFetch(async (u) => { url = u; return new Response(JSON.stringify({ code: 0, data: { '5h': { remaining: 80, total: 100 } } }), { status: 200 }) })
  await createMiniMaxAdapter({ region: 'intl' }).fetch(ctxWithKey('sk-test'))
  assert.ok(url.includes('minimax.io'))
})

test('Region=cn prefers CN credential before generic one', async () => {
  let requestedRef: string | undefined
  const ctx: QuotaAdapterContext = {
    providerId: 'minimax-official',
    probeCredential: async (ref) => ref === 'MINIMAX_CN_API_KEY',
    resolveSecret: async (ref) => {
      if (ref.includes('COOKIE')) return undefined
      requestedRef = ref
      return ref === 'MINIMAX_CN_API_KEY' ? 'sk-test' : undefined
    },
  }
  mockFetch(async () => new Response(JSON.stringify({ code: 0, data: { '5h': { remaining: 80, total: 100 } } }), { status: 200 }))
  await createMiniMaxAdapter({ region: 'cn' }).fetch(ctx)
  assert.equal(requestedRef, 'MINIMAX_CN_API_KEY')
})

test('Parses the real base_resp + model_remains response (general + video)', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    model_remains: [
      {
        start_time: 1787140800000,
        end_time: 1787155200000,
        remains_time: 9902779,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        model_name: "general",
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        weekly_start_time: 1786896000000,
        weekly_end_time: 1787500800000,
        weekly_remains_time: 355502779,
        current_interval_status: 1,
        current_interval_remaining_percent: 85,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 85,
        weekly_boost_permille: 1500,
      },
      {
        start_time: 1787068800000,
        end_time: 1787155200000,
        remains_time: 9902779,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        model_name: "video",
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        weekly_start_time: 1786896000000,
        weekly_end_time: 1787500800000,
        weekly_remains_time: 355502779,
        current_interval_status: 3,
        current_interval_remaining_percent: 100,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
      },
    ],
    base_resp: {
      status_code: 0,
      status_msg: "success",
    },
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'ok')
  assert.equal(snap.quotas?.length, 4)
  const general5h = snap.quotas!.find((q) => q.id === 'general:5h')
  assert.ok(general5h !== undefined)
  assert.equal(general5h!.remainingRatio, 0.85)
  assert.equal(general5h!.label, '5h · general')
  const generalWeek = snap.quotas!.find((q) => q.id === 'general:weekly')
  assert.ok(generalWeek !== undefined)
  assert.equal(generalWeek!.remainingRatio, 0.85)
  assert.match(generalWeek!.label, /Week · general \(150%\)/)
  const video5h = snap.quotas!.find((q) => q.id === 'video:5h')
  assert.ok(video5h !== undefined)
  assert.equal(video5h!.remainingRatio, 1)
  assert.match(snap.message ?? '', /general.*video/)
})

test('base_resp status_code != 0 with auth-style code returns auth-error', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    base_resp: {
      status_code: 1004,
      status_msg: "login fail: Please carry the API secret key in the \u0027Authorization\u0027 field of the request header",
    },
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'auth-error')
  assert.match(snap.message ?? '', /Authorization/)
  assert.ok(!(snap.message ?? '').includes('1004'), 'raw status code should not leak through')
})

test('base_resp status_code != 0 with non-auth code returns error', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    base_resp: {
      status_code: 9999,
      status_msg: "internal server error",
    },
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'error')
  assert.equal(snap.quotas, undefined)
})

test('Empty model_remains array falls back to error', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    model_remains: [],
    base_resp: { status_code: 0, status_msg: 'success' },
  }), { status: 200 }))
  const snap = await createMiniMaxAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'error')
})

test('Cookie auth path: sends cookie header and skips Bearer when cookie is provided', async () => {
  let capturedHeaders: Record<string, string> = {}
  mockFetch(async (_url, init) => {
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>
    return new Response(JSON.stringify({
      model_remains: [
        {
          start_time: 0, end_time: 0, remains_time: 0,
          current_interval_total_count: 100, current_interval_usage_count: 10,
          model_name: "general",
          current_weekly_total_count: 1000, current_weekly_usage_count: 50,
          weekly_start_time: 0, weekly_end_time: 0, weekly_remains_time: 0,
          current_interval_status: 1, current_interval_remaining_percent: 90,
          current_weekly_status: 1, current_weekly_remaining_percent: 95,
          weekly_boost_permille: 1000,
        },
      ],
      base_resp: { status_code: 0, status_msg: "success" },
    }), { status: 200 })
  })
  const adapter = createMiniMaxAdapter({
    cookie: "sessionid=abc123; _uid=xyz",
  })
  await adapter.fetch(ctxWithKey("sk-cp-ignored"))
  assert.ok(capturedHeaders["cookie"] !== undefined, "cookie header should be set")
  assert.equal(capturedHeaders["cookie"], "sessionid=abc123; _uid=xyz")
  assert.equal(capturedHeaders["authorization"], undefined, "Authorization header should be omitted when cookie is present")
  assert.ok(capturedHeaders["x-requested-with"] === "XMLHttpRequest")
})

test('Bearer fallback path: when no cookie provided, sends Authorization', async () => {
  let capturedHeaders: Record<string, string> = {}
  mockFetch(async (_url, init) => {
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>
    return new Response("{}", { status: 401 })
  })
  const adapter = createMiniMaxAdapter({})
  await adapter.fetch(ctxWithKey("sk-real-key"))
  assert.equal(capturedHeaders["authorization"], "Bearer sk-real-key")
  assert.equal(capturedHeaders["cookie"], undefined)
})

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test.afterEach(() => {
  globalThis.fetch = originalFetch
})
