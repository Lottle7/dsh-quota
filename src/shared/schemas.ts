/**
 * Minimal runtime schema validation for adapter responses.
 *
 * The plugin deliberately avoids a heavyweight schema library; each adapter
 * writes its own narrow check function against the small subset of fields it
 * actually uses. The helpers here are the building blocks — every check
 * returns a normalized value or throws QuotaParseError.
 */

export class QuotaParseError extends Error {
  readonly code = "schema-invalid"
  constructor(message: string) {
    super(message)
  }
}

/** True when the value is a non-empty string. */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

/** True when the value is a finite number. */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/** True when the value is a plain object (not null, not array). */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** True when the value is an array. */
export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

/** Clamp a ratio to [0, 1] and coerce non-numbers to undefined. */
export function clampRatio(v: unknown): number | undefined {
  if (!isFiniteNumber(v)) return undefined
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** Parse a string-or-number money value; throws QuotaParseError on garbage. */
export function parseMoney(v: unknown, field: string): number {
  if (isFiniteNumber(v)) return v
  if (typeof v === "string") {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  throw new QuotaParseError(`${field} is not a valid number: ${JSON.stringify(v)}`)
}

/** Parse a numeric string or number, returning undefined when unparseable. */
export function parseMoneyOrUndefined(v: unknown): number | undefined {
  if (isFiniteNumber(v)) return v
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Parse a permissive string (kept even when unknown). */
export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Assert a value is a plain object; throw QuotaParseError otherwise. */
export function requireObject(v: unknown, field: string): Record<string, unknown> {
  if (!isObject(v)) throw new QuotaParseError(`${field} is not an object`)
  return v
}
