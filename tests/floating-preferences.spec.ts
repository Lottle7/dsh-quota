import assert from "node:assert/strict"
import test from "node:test"
import {
  clampFloatingPosition,
  normalizeFloatingPreferences,
  readFloatingPreferences,
  writeFloatingPreferences,
  type FloatingStorage,
} from "../src/client/floating-preferences.ts"

function memoryStorage(): FloatingStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
  }
}

test("floating preferences default to a visible mini card", () => {
  assert.deepEqual(normalizeFloatingPreferences(undefined), { mode: "card", position: null })
  assert.deepEqual(normalizeFloatingPreferences({ mode: "unexpected", position: { x: "1", y: 2 } }), { mode: "card", position: null })
})

test("floating preferences round-trip card mode and rounded coordinates", () => {
  const storage = memoryStorage()
  writeFloatingPreferences({ mode: "icon", position: { x: 80.4, y: 120.6 } }, storage)
  assert.deepEqual(readFloatingPreferences(storage), { mode: "icon", position: { x: 80, y: 121 } })
})

test("malformed floating preference storage safely returns defaults", () => {
  const storage = memoryStorage()
  storage.setItem("dsh-quota.floating-preferences.v1", "{broken")
  assert.deepEqual(readFloatingPreferences(storage), { mode: "card", position: null })
})

test("floating surfaces remain on screen and above the reserved bottom bar", () => {
  assert.deepEqual(
    clampFloatingPosition({ x: -200, y: 900 }, { width: 1280, height: 720 }, { width: 286, height: 142 }),
    { x: 12, y: 516 },
  )
  assert.deepEqual(
    clampFloatingPosition({ x: 1250, y: -10 }, { width: 1280, height: 720 }, { width: 52, height: 52 }),
    { x: 1216, y: 12 },
  )
})
