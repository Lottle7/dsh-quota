import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'

let loaderEntry
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaderEntry = entry
    },
  },
  addEventListener() {},
  removeEventListener() {},
}
// The smoke test does not need to mount CSS; returning an existing node keeps
// the generated loader wrapper on the same path as a page that already loaded it.
globalThis.document = {
  visibilityState: 'visible',
  querySelector() {
    return {}
  },
  addEventListener() {},
  removeEventListener() {},
}

const clientUrl = new URL('../lib/client.js', import.meta.url)
await import(`${clientUrl.href}?smoke=${Date.now()}`)

assert.ok(loaderEntry, 'client bundle did not register with window.__ModuleLoader__')
assert.equal(loaderEntry.id, 'dsh-quota')

const plugin = loaderEntry.factory(createRequire(import.meta.url))
assert.deepEqual(plugin.inject, ['slots', 'sessions', 'modelDirectories'])

const mountedSlots = []
const ctx = new Context()
ctx.provide('slots', {
  inject(name, callback) {
    mountedSlots.push(name)
    callback()
  },
  register() {
    return undefined
  },
})
ctx.provide('sessions', {
  currentProvideInfo: {
    getSnapshot() {
      return {}
    },
    subscribe() {
      return () => undefined
    },
  },
})
ctx.provide('modelDirectories', {
  directoryFor() {
    return {
      store: {
        getSnapshot() { return { current: null, status: 'loading' } },
        subscribe() { return () => undefined },
      },
      async load() { return undefined },
    }
  },
})

const fiber = ctx.plugin(plugin)
await fiber
assert.deepEqual(mountedSlots, ['sidebar.footer.action', 'shell.overlay'])
await fiber.dispose()

console.log('dsh-quota client loader smoke test passed')
