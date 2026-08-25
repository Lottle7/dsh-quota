import { test } from "node:test"
import assert from "node:assert/strict"
import { createSiliconFlowAdapter } from "../src/host/adapters/siliconflow.ts"
import type { QuotaAdapterContext } from "../src/host/adapters/base.ts"

const originalFetch = globalThis.fetch
const context = (key?: string): QuotaAdapterContext => ({
  providerId: "siliconflow",
  probeCredential: async () => key !== undefined,
  resolveSecret: async () => key,
})

function mockFetch(response: Response): void {
  globalThis.fetch = (async () => response) as typeof fetch
}

test("SiliconFlow normalizes recharge, gift and total balances", async () => {
  mockFetch(new Response(JSON.stringify({
    code: 20000,
    data: { balance: "8.25", chargeBalance: "50.00", totalBalance: "58.25" },
  }), { status: 200 }))
  const snapshot = await createSiliconFlowAdapter().fetch(context("sf-test"))
  assert.equal(snapshot.status, "ok")
  assert.deepEqual(snapshot.balances?.[0], {
    currency: "CNY",
    total: 58.25,
    toppedUp: 50,
    granted: 8.25,
  })
})

test("SiliconFlow accepts a flat legacy response", async () => {
  mockFetch(new Response(JSON.stringify({ balance: 12.5 }), { status: 200 }))
  const snapshot = await createSiliconFlowAdapter().fetch(context("sf-test"))
  assert.equal(snapshot.balances?.[0].total, 12.5)
})

test("SiliconFlow rejects missing keys and malformed account data", async () => {
  assert.equal((await createSiliconFlowAdapter().fetch(context())).status, "not-configured")
  mockFetch(new Response(JSON.stringify({ data: { name: "hidden" } }), { status: 200 }))
  assert.equal((await createSiliconFlowAdapter().fetch(context("sf-test"))).status, "error")
})

test.afterEach(() => { globalThis.fetch = originalFetch })
