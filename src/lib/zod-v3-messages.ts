import type { z } from "zod";

/**
 * Zod 4 rewrote its default validation messages ("Required" became
 * "Invalid input: expected string, received undefined", etc.). Our 400 bodies
 * return `parsed.error.flatten()` / `parsed.error.message`, so callers saw the
 * zod 3 wording for years. This error map restores the zod 3 wording for every
 * issue our request schemas can raise; anything else falls back to zod 4's own.
 * Installed once in src/schemas.ts via `z.config({ customError })`.
 */

function v3TypeName(input: unknown): string {
  if (input === undefined) return "undefined";
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (typeof input === "number") return Number.isNaN(input) ? "nan" : "number";
  if (input instanceof Date) return "date";
  if (input instanceof Map) return "map";
  if (input instanceof Set) return "set";
  if (input instanceof Promise) return "promise";
  return typeof input;
}

const quote = (v: unknown) => (typeof v === "string" ? `'${v}'` : String(v));

type Issue = Parameters<NonNullable<z.core.$ZodConfig["customError"]>>[0];

export function zodV3Message(issue: Issue): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iss = issue as any;
  switch (iss.code) {
    case "invalid_type": {
      if (iss.input === undefined) return "Required";
      if (iss.expected === "int") return "Expected integer, received float";
      return `Expected ${iss.expected}, received ${v3TypeName(iss.input)}`;
    }
    case "invalid_format": {
      if (iss.format === "url") return "Invalid url";
      if (iss.format === "guid" || iss.format === "uuid") return "Invalid uuid";
      if (iss.format === "email") return "Invalid email";
      return undefined;
    }
    case "invalid_value": {
      if (iss.inst?._zod?.def?.type === "enum") {
        const expected = (iss.values as unknown[]).map(quote).join(" | ");
        return `Invalid enum value. Expected ${expected}, received ${quote(iss.input)}`;
      }
      if (iss.inst?._zod?.def?.type === "literal" && iss.values?.length === 1) {
        return `Invalid literal value, expected ${JSON.stringify(iss.values[0])}`;
      }
      return undefined;
    }
    case "too_small": {
      const min = iss.minimum;
      if (iss.origin === "number")
        return `Number must be greater than ${iss.inclusive ? "or equal to " : ""}${min}`;
      if (iss.origin === "array")
        return `Array must contain ${iss.inclusive ? "at least" : "more than"} ${min} element(s)`;
      if (iss.origin === "string")
        return `String must contain ${iss.inclusive ? "at least" : "over"} ${min} character(s)`;
      return undefined;
    }
    case "too_big": {
      const max = iss.maximum;
      if (iss.origin === "number")
        return `Number must be less than ${iss.inclusive ? "or equal to " : ""}${max}`;
      if (iss.origin === "array")
        return `Array must contain ${iss.inclusive ? "at most" : "fewer than"} ${max} element(s)`;
      if (iss.origin === "string")
        return `String must contain ${iss.inclusive ? "at most" : "under"} ${max} character(s)`;
      return undefined;
    }
    default:
      return undefined;
  }
}
