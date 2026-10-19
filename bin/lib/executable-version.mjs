const keys = ["version", "dev", "ino", "size", "mtimeMs"];
const version = /^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}(?:-[A-Za-z0-9.-]{1,32})?$/;

// Pure, closed declaration grammar shared by settings and executable evidence.
// A declaration never supplies identity from a stat or repairs malformed input.
export function parseDeclaredVersion(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  try {
    // JSON.parse alone silently replaces duplicate (including escaped) keys.
    const tokens = raw.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
    const seen = new Set();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith('"') && tokens[i + 1] === ":") {
        const key = JSON.parse(token);
        if (!keys.includes(key) || seen.has(key)) return null;
        seen.add(key);
      }
    }
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return null;
    const o = v;
    if (Object.keys(o).length !== keys.length || keys.some((key) => !Object.hasOwn(o, key))) return null;
    if (typeof o.version !== "string" || !version.test(o.version)) return null;
    for (const key of ["dev", "ino", "size"]) {
      if (typeof o[key] !== "number" || !Number.isSafeInteger(o[key]) || o[key] < 0) return null;
    }
    if (typeof o.mtimeMs !== "number" || !Number.isFinite(o.mtimeMs) || o.mtimeMs < 0 || o.mtimeMs > Number.MAX_SAFE_INTEGER) return null;
    return v;
  } catch { return null; }
}

export const validDeclaredVersion = (raw) => parseDeclaredVersion(raw) !== null;
