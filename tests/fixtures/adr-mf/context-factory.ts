// ADR-MF #10 fixture — frozen SessionContext factories for cross-cutting tests.
// Pure: no I/O, no assertions. Mirrors tests/session/boot-adapter/_fixtures.ts:makeCtx
// generalised to N-level chains.
import { Role, type SessionContext } from "../../../src/session/types.js";

const ISO = "2026-05-12T00:00:00+00:00";

export function makeCtx(over: Partial<SessionContext> = {}): SessionContext {
  const base: SessionContext = {
    session_id: "S-0",
    role: Role.coder,
    cwd: "/work/myproj",
    task_id: "T-0",
    effective_prompt_digest: "0".repeat(64),
    effective_prompt_path: "/snap/effective_prompt.md",
    layers: [],
    spawn_chain: [],
    depth: 0,
    created_at: ISO,
    ...over,
  };
  return Object.freeze(base);
}

export function makeChildOf(
  parent: SessionContext,
  over: Partial<SessionContext> = {},
): SessionContext {
  const child: SessionContext = {
    ...parent,
    session_id: `${parent.session_id}.c`,
    role: parent.role,
    cwd: parent.cwd,
    task_id: `${parent.task_id}.c`,
    parent_id: parent.session_id,
    parent_role: parent.role,
    spawn_chain: Object.freeze([
      parent.session_id,
      ...parent.spawn_chain,
    ]) as readonly string[],
    depth: parent.depth + 1,
    ...over,
  };
  return Object.freeze(child);
}

// Build a chain whose i-th element is a child of the (i-1)-th. Useful for D1/D5.
// `roles` is the full ordered list (root first). `cwds` is optional; falls back
// to inheriting parent's cwd.
export function makeChain(
  roles: readonly Role[],
  cwds?: readonly string[],
): readonly SessionContext[] {
  if (roles.length === 0) return Object.freeze([]);
  const out: SessionContext[] = [];
  out.push(
    makeCtx({
      session_id: "S-root",
      role: roles[0]!,
      ...(cwds?.[0] !== undefined ? { cwd: cwds[0]! } : {}),
      task_id: "T-root",
    }),
  );
  for (let i = 1; i < roles.length; i++) {
    out.push(
      makeChildOf(out[i - 1]!, {
        session_id: `S-${i}`,
        role: roles[i]!,
        task_id: `T-${i}`,
        ...(cwds?.[i] !== undefined ? { cwd: cwds[i]! } : {}),
      }),
    );
  }
  return Object.freeze(out);
}
