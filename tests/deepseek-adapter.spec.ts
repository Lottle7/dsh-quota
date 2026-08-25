import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekAdapter } from '../src/host/adapters/deepseek.ts'
import type { QuotaAdapterContext } from '../src/host/adapters/base.ts'

function ctxWithKey(value: string | undefined): QuotaAdapterContext {
  return {
    providerId: 'deepseek-official',
    probeCredential: async () => value !== undefined && value.length > 0,
    resolveSecret: async () => value,
  }
}

// We capture fetch calls so the adapter does not actually hit DeepSeek.
const originalFetch = globalThis.fetch
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return impl(url, init)
  }) as typeof fetch
}

test('Normalizes a healthy balance response', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '82.47',
      granted_balance: '12.00',
      topped_up_balance: '70.47',
    }],
  }), { status: 200 }))
  const snap = await createDeepSeekAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'ok')
  assert.equal(snap.balances?.length, 1)
  assert.equal(snap.balances![0].total, 82.47)
  assert.equal(snap.balances![0].granted, 12)
  assert.equal(snap.balances![0].toppedUp, 70.47)
  assert.equal(snap.balances![0].currency, 'CNY')
})

test('Returns warning when first currency balance is below threshold', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '5.00',
      topped_up_balance: '5.00',
    }],
  }), { status: 200 }))
  const snap = await createDeepSeekAdapter({ warningBelow: 10 }).fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'warning')
})

test('401 becomes auth-error, not a fake 0 balance', async () => {
  mockFetch(async () => new Response('forbidden', { status: 401 }))
  const snap = await createDeepSeekAdapter().fetch(ctxWithKey('sk-bad'))
  assert.equal(snap.status, 'auth-error')
  assert.equal(snap.balances, undefined)
})

test('429 becomes rate-limited', async () => {
  mockFetch(async () => new Response('rate', { status: 429 }))
  const snap = await createDeepSeekAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'rate-limited')
})

test('Network failure becomes network-error (not zero)', async () => {
  mockFetch(async () => { throw new Error('ECONNREFUSED') })
  const snap = await createDeepSeekAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'network-error')
})

test('Malformed JSON becomes error (not zero)', async () => {
  mockFetch(async () => new Response('not json', { status: 200 }))
  const snap = await createDeepSeekAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'error')
})

test('Missing key becomes not-configured (no remote call)', async () => {
  let called = false
  mockFetch(async () => { called = true; return new Response('', { status: 200 }) })
  const snap = await createDeepSeekAdapter().fetch(ctxWithKey(undefined))
  assert.equal(called, false)
  assert.equal(snap.status, 'not-configured')
})

test('is_available=false becomes error with balances still attached', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    is_available: false,
    balance_infos: [{ currency: 'CNY', total_balance: '82.47', topped_up_balance: '82.47' }],
  }), { status: 200 }))
  const snap = await createDeepSeekAdapter().fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'error')
  assert.equal(snap.balances?.[0].total, 82.47)
})

test('Multi-currency response keeps every entry', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '1.00', topped_up_balance: '1.00' },
      { currency: 'USD', total_balance: '0.20', topped_up_balance: '0.20' },
    ],
  }), { status: 200 }))
  const snap = await createDeepSeekAdapter({ warningBelow: 0.5 }).fetch(ctxWithKey('sk-test'))
  assert.equal(snap.status, 'ok')
  assert.equal(snap.balances?.length, 2)
  assert.equal(snap.balances![1].currency, 'USD')
})

test('Malformed numeric strings become error (not zero)', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: 'not-a-number', topped_up_balance: '70.47' }],
  }), { status: 200 }))
  const snap = await createDeepSeekAdapter().fetch(ctxWithKey('sk-test'))
  // No valid balance => error status with diagnostic
  assert.equal(snap.status, 'error')
})

test.afterEach(() => {
  globalThis.fetch = originalFetch
})
