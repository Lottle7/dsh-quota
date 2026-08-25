import { FLOATING_PREFERENCES_STORAGE_KEY } from "../shared/usage.ts"

export type FloatingMode = "card" | "icon" | "hidden"

export interface FloatingPosition {
  x: number
  y: number
}

export interface FloatingPreferences {
  mode: FloatingMode
  position: FloatingPosition | null
}

export interface FloatingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_FLOATING_PREFERENCES: FloatingPreferences = {
  mode: "card",
  position: null,
}

export function normalizeFloatingPreferences(value: unknown): FloatingPreferences {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_FLOATING_PREFERENCES }
  const input = value as { mode?: unknown; position?: unknown }
  const mode: FloatingMode = input.mode === "icon" || input.mode === "hidden" ? input.mode : "card"
  const raw = input.position
  const position = typeof raw === "object" && raw !== null
    && Number.isFinite((raw as { x?: unknown }).x)
    && Number.isFinite((raw as { y?: unknown }).y)
    ? {
        x: Math.round((raw as { x: number }).x),
        y: Math.round((raw as { y: number }).y),
      }
    : null
  return { mode, position }
}

export function readFloatingPreferences(storage = browserStorage()): FloatingPreferences {
  if (storage === undefined) return { ...DEFAULT_FLOATING_PREFERENCES }
  try {
    const raw = storage.getItem(FLOATING_PREFERENCES_STORAGE_KEY)
    return raw === null ? { ...DEFAULT_FLOATING_PREFERENCES } : normalizeFloatingPreferences(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_FLOATING_PREFERENCES }
  }
}

export function writeFloatingPreferences(preferences: FloatingPreferences, storage = browserStorage()): void {
  if (storage === undefined) return
  try {
    storage.setItem(FLOATING_PREFERENCES_STORAGE_KEY, JSON.stringify(normalizeFloatingPreferences(preferences)))
  } catch {
    // Private browsing and full storage must not break the dashboard.
  }
}

export function clampFloatingPosition(
  position: FloatingPosition,
  viewport: { width: number; height: number },
  surface: { width: number; height: number },
  margin = 12,
  reservedBottom = 62,
): FloatingPosition {
  const maximumX = Math.max(margin, viewport.width - surface.width - margin)
  const maximumY = Math.max(margin, viewport.height - surface.height - reservedBottom)
  return {
    x: Math.round(Math.min(maximumX, Math.max(margin, position.x))),
    y: Math.round(Math.min(maximumY, Math.max(margin, position.y))),
  }
}

function browserStorage(): FloatingStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage } catch { return undefined }
}
