import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HostUsageLedger,
  foldSessionUsage,
  type SessionEventLike,
  type StorageDomainLike,
} from '../src/host/usage-ledger.ts'

const at = new Date(2026, 7, 25, 12, 0, 0).getTime()

function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

test('session fold replaces repeated usage samples for one step and keeps its route', () => {
  const events: SessionEventLike[] = [
    { seq: 0, time: at, type: 'request/context', data: { provider: 'minimax-cn', model: 'MiniMax-M3' } },
    { seq: 1, time: at + 1, type: 'step/start', data: { turn: 2, step: 4 } },
    { seq: 2, time: at + 2, type: 'assistant/chunk', data: { turn: 2, step: 4, chunk: { type: 'usage', usage: usage(100, 10, 20) } } },
    { seq: 3, time: at + 3, type: 'assistant/message', data: { turn: 2, step: 4, usage: usage(140, 30, 40) } },
    { seq: 4, time: at + 4, type: 'step/end', data: { turn: 2, step: 4 } },
  ]
  const result = foldSessionUsage(
    { identity: { createdAt: at }, lastSeq: -1, cursor: null, entries: {}, updatedAt: at },
    events,
    'session-a',
    (provider) => provider,
    at + 10,
  )
  assert.equal(Object.keys(result.entries).length, 1)
  assert.deepEqual(result.entries['2:4']?.tokens, {
    uncachedInputTokens: 140,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
  })
  assert.equal(result.entries['2:4']?.billingProvider, 'minimax-cn')
  assert.equal(result.entries['2:4']?.model, 'MiniMax-M3')
  assert.equal(result.entries['2:4']?.seq, 3)
})

test('Host backfill is revision-aware and legacy import stores only the uncovered remainder', async () => {
  const tables = new Map<string, MemoryTable<unknown>>()
  const storageDomain: StorageDomainLike = {
    async open() {
      return {
        table(name) {
          let table = tables.get(name)
          if (table === undefined) {
            table = new MemoryTable()
            tables.set(name, table)
          }
          return table
        },
        async close() {},
      }
    },
  }
  const session = {
    id: 'session-b',
    header: { id: 'session-b', createdAt: at },
    events: [
      { seq: 0, time: at, type: 'request/context', data: { provider: 'openrouter', model: 'deepseek/deepseek-chat' } },
      { seq: 1, time: at + 1, type: 'assistant/message', data: { turn: 0, step: 0, usage: usage(100, 20, 30) } },
    ],
  }
  let inspections = 0
  const ledger = await HostUsageLedger.open({
    storageDomain,
    sessions: { list: () => [] },
    sessionPersistence: {
      async listSnapshots() { return [{ header: session.header, revision: 'revision-1' }] },
      async inspect() { inspections += 1; return { meta: session.header, events: session.events } },
    },
    resolveBillingProvider: () => 'openrouter',
    retainedDays: 90,
    now: () => at + 5_000,
  })

  await ledger.startBackfill()
  await ledger.startBackfill()
  assert.equal(inspections, 1, 'the unchanged revision should not be parsed twice')
  assert.equal(ledger.query().entries.length, 1)

  const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
  const imported = await ledger.importLegacy([{
    date,
    provider: 'openrouter',
    model: 'deepseek/deepseek-chat',
    tokens: { uncachedInputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 25 },
  }])
  assert.equal(imported.stored, 1)
  const afterImport = ledger.query().entries
  assert.equal(afterImport.length, 2)
  const migrated = afterImport.find((entry) => entry.source === 'browser-migration')
  assert.deepEqual(migrated?.tokens, {
    uncachedInputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
  })

  await ledger.importLegacy([{
    date,
    provider: 'openrouter',
    model: 'deepseek/deepseek-chat',
    tokens: { uncachedInputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 25 },
  }])
  assert.equal(ledger.query().entries.filter((entry) => entry.source === 'browser-migration').length, 1)
  await ledger.close()
})

test('Host query keeps complete aggregates while cursor pages and filters stay bounded', async () => {
  const tables = new Map<string, MemoryTable<unknown>>()
  const storageDomain: StorageDomainLike = {
    async open() {
      return {
        table(name) {
          let table = tables.get(name)
          if (table === undefined) {
            table = new MemoryTable()
            tables.set(name, table)
          }
          return table
        },
        async close() {},
      }
    },
  }
  const header = { id: 'session-paged', createdAt: at }
  const events: SessionEventLike[] = [
    { seq: 0, time: at, type: 'request/context', data: { provider: 'openrouter', model: 'deepseek/deepseek-chat' } },
    { seq: 1, time: at + 1, type: 'assistant/message', data: { turn: 0, step: 0, usage: usage(100, 10) } },
    { seq: 2, time: at + 2, type: 'assistant/message', data: { turn: 0, step: 1, usage: usage(200, 20, 50) } },
    { seq: 3, time: at + 3, type: 'assistant/message', data: { turn: 0, step: 2, usage: usage(300, 30, 70, 5) } },
  ]
  const ledger = await HostUsageLedger.open({
    storageDomain,
    sessions: { list: () => [] },
    sessionPersistence: {
      async listSnapshots() { return [{ header, revision: 'revision-paged' }] },
      async inspect() { return { meta: header, events } },
    },
    resolveBillingProvider: () => 'openrouter',
    retainedDays: 90,
    now: () => at + 5_000,
  })
  await ledger.startBackfill()

  const first = ledger.query({ limit: 2 })
  assert.equal(first.entries.length, 2)
  assert.equal(first.summary.calls, 3)
  assert.equal(first.summary.sessionCount, 1)
  assert.deepEqual(first.summary.tokens, {
    uncachedInputTokens: 600,
    cacheReadTokens: 120,
    cacheWriteTokens: 5,
    outputTokens: 60,
  })
  assert.equal(first.summary.buckets.length, 1)
  assert.equal(first.hasMore, true)
  assert.ok(first.nextCursor)

  const second = ledger.query({ limit: 2, cursor: first.nextCursor ?? undefined })
  assert.equal(second.entries.length, 1)
  assert.equal(second.hasMore, false)
  assert.equal(second.summary.calls, 3, 'the second page keeps the complete filtered summary')
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size, 3)

  const filtered = ledger.query({ billingProvider: 'OPENROUTER', model: 'deepseek/deepseek-chat', search: 'session-paged' })
  assert.equal(filtered.summary.calls, 3)
  assert.equal(ledger.query({ billingProvider: 'minimax-cn' }).summary.calls, 0)

  const csv = ledger.exportCsv({ billingProvider: 'openrouter' })
  assert.ok(csv.startsWith('\uFEFFoccurred_at,session_id'))
  assert.equal(csv.trim().split('\n').length, 4)
  assert.match(csv, /deepseek\/deepseek-chat/)
  await ledger.close()
})

class MemoryTable<V> {
  private readonly values = new Map<string, V>()
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return new Map(this.values).entries() }
  async put(key: string, value: V): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.values.delete(key) }
}
