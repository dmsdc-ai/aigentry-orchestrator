// ADR §4.8.2 — canonical bytes (digest input).
// UTF-8 + LF + no BOM + NFC + sorted-keys JSON. sha256 is computed over these bytes.
import { createHash } from "node:crypto";

const ENCODER = new TextEncoder();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype ||
      Object.getPrototypeOf(v) === null)
  );
}

function encodeJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonical-bytes: non-finite number ${value} not encodable`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(encodeJsonValue).join(",") + "]";
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + encodeJsonValue(value[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error(
    `canonical-bytes: unsupported type ${typeof value} (${Object.prototype.toString.call(value)})`,
  );
}

// Normalize text: strip BOM, normalize CRLF/CR → LF, NFC normalize.
function normalizeText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lf = noBom.replace(/\r\n?/g, "\n");
  return lf.normalize("NFC");
}

// Encode arbitrary content into canonical bytes.
//   - string  → treated as text (LF + NFC + no BOM, UTF-8 encoded)
//   - object/array/scalar → JSON-encoded with sorted object keys, then text-normalized
export function canonicalBytes(value: unknown): Uint8Array {
  const text =
    typeof value === "string" ? normalizeText(value) : normalizeText(encodeJsonValue(value));
  return ENCODER.encode(text);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Canonical ISO-8601 timestamp with explicit +00:00 offset (per ADR §4.8.2).
//   Date.prototype.toISOString() emits ...Z; we substitute +00:00 to match the spec.
export function canonicalTimestamp(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/Z$/, "+00:00");
}
