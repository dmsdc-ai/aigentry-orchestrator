// #1201 — secret scrub (SPEC §5). Applied to every copied string, before budgets.
// A matched value becomes `‹redacted:<kind>›`; a `key: value` keeps its key. Bare 64-hex sha256
// values are kept (evidence the orchestrator relies on). Control characters other than `\n`
// (C0, DEL, C1) are stripped.

const RULES: readonly { kind: string; re: RegExp; keep?: boolean }[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "telepty-token", re: /(x-telepty-token:\s*)\S+/gi, keep: true },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "openai-key", re: /sk-[A-Za-z0-9_-]{16,}/g },
  { kind: "github-token", re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: "github-token", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "slack-token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-key", re: /AKIA[0-9A-Z]{16}/g },
  { kind: "google-key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: "jwt", re: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  { kind: "url-userinfo", re: /(:\/\/)[^/\s:@]+:[^/\s@]+@/g, keep: true },
  // `bearer <v>` before `authorization: <v>`, so `Authorization: Bearer <v>` loses the value too.
  { kind: "authorization", re: /\b(bearer\s*[:=]?\s*)(?!‹redacted)\S+/gi, keep: true },
  { kind: "authorization", re: /\b(authorization\s*[:=]?\s*)(?!‹redacted)\S+/gi, keep: true },
  { kind: "secret", re: /\b((?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret)\b\s*[:=]\s*)(?!‹redacted)\S+/gi, keep: true },
];

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function redact(text: string): string {
  // A tab becomes a space rather than vanishing, so two words never fuse.
  let out = text.replace(/\t/g, " ").replace(CONTROL, "");
  for (const { kind, re, keep } of RULES) {
    out = out.replace(re, (...m: unknown[]) => `${keep ? String(m[1]) : ""}‹redacted:${kind}›`);
  }
  return out;
}
