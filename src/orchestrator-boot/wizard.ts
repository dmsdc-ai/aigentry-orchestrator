// wizard.ts — the interactive half of the orchestrator boot plan (#1181). NEW SURFACE.
//
// WHY THIS CAN EXIST AT ALL WITHOUT TOUCHING bin/orchestrator-boot.sh. On the boot path the
// shim runs
//
//     ORCH_BOOT_ARGV_RAW="$(node "$AIGENTRY_SHIM_JS")"
//
// and a command substitution captures STDOUT ONLY: fd 0 and fd 2 are still the operator's
// terminal. So the wizard reads the TTY on fd 0, draws on fd 2, and lets cli.ts print the
// agreed argv — and only the agreed argv — on fd 1. The #934 empty-argv gate is untouched,
// the shim is unchanged, and T131 block R's "stdout is EXACTLY the exec argv" stays true
// because this file never writes to fd 1 at all.
//
// CANCELLATION IS CORRECT BY CONSTRUCTION, not by cleanup: on `q`, Ctrl-C or EOF this
// returns `cancelled`, cli.ts exits non-zero having printed NOTHING on stdout, the shim's
// `set -e` aborts at the command substitution, and its `exec` is never reached. Its
// "printed no exec argv — refusing to boot" arm is the backstop under it.
//
// ⚠️ TERMINAL TECHNIQUE, smallest justified (Article 1 + Article 17): `node:readline/
// promises` in LINE MODE — the same stdlib idiom bin/init/cli.mjs:116-128 already uses. NO
// raw keypress mode, NO alternate screen, NO new dependency. Raw mode is rejected for a
// concrete reason: a raw-mode process that dies on a signal leaves the terminal unusable,
// and this is the one script whose successor BECOMES that terminal's shell.
//
// ⚠️ NOTHING IN THIS FILE RUNS A PROVIDER. Availability is decided by looking for an
// executable file on PATH — `fs.accessSync(…, X_OK)`, never a spawn. Measured 2026-09:
// `gemini --help` created `$HOME/.gemini/projects.json.*.tmp`, `grok --help` created
// `$HOME/.grok/`, `codex --help` populated `$CODEX_HOME/tmp/arg0/…`. A planning step that
// shelled out to `--help` on a real HOME would be an EFFECT, and this screen must reach the
// operator's review with none. No login, no auth, no `models` listing, no session/history
// listing, no `--version`. Everything shown comes from provider-capabilities.ts, whose
// strings are labelled with the version they were measured at.
import * as fs from "node:fs";
import * as path from "node:path";
import readline from "node:readline/promises";

import {
  type AxisChoice,
  type BootPlan,
  type EffortChoice,
  type HistoryChoice,
  type ModelChoice,
  ackPhrase,
  buildExecArgv,
  describeEffects,
  describePlan,
  elevatedChoices,
  restrictiveDefaults,
  validateEffort,
  validateModel,
  validateSelector,
  validateSid,
} from "./plan.js";
import { CAPABILITIES, type ProviderCapability } from "./provider-capabilities.js";

export type WizardOutcome =
  | { readonly kind: "plan"; readonly plan: BootPlan }
  /** Every cancel arm lands here: `q`, Ctrl-C, EOF, and a declined confirmation. */
  | { readonly kind: "cancelled"; readonly reason: string };

/** A control answer, kept out of the value space so `b` can never be a session title. */
const BACK = Symbol("back");
const CANCEL = Symbol("cancel");
type Answer = string | typeof BACK | typeof CANCEL;

export interface WizardIo {
  /** Where the wizard draws. fd 2 on every path — fd 1 belongs to the exec argv. */
  readonly out: NodeJS.WritableStream;
  readonly input: NodeJS.ReadableStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/**
 * Is the executable present, without running it?
 *
 * A PATH walk with an X_OK access check. This is the whole of "discovery": no `--version`,
 * no `--help`, no `command -v` subshell. A missing provider is reported as unavailable with
 * the executable name to install — never auto-installed, and never silently replaced by a
 * neighbouring CLI (there is no `agy` substitution for `gemini` here, and no claude
 * fallback for anything).
 */
export function resolveExecutable(exe: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env.PATH;
  if (raw === undefined || raw === "") return null;
  for (const dir of raw.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, exe);
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** `b` = back, `q`/EOF/Ctrl-C = cancel. Anything else is the operator's literal answer. */
function classify(raw: string | null): Answer {
  if (raw === null) return CANCEL;
  const t = raw.trim();
  if (t === "q" || t === "Q") return CANCEL;
  if (t === "b" || t === "B") return BACK;
  return t;
}

const NAV = "[Enter = the shown default · b = back · q = cancel]";

export async function runWizard(io: WizardIo): Promise<WizardOutcome> {
  const write = (s: string): void => {
    io.out.write(s);
  };
  const rl = readline.createInterface({ input: io.input, output: io.out, terminal: true });
  // EOF closes the interface, and a `question` pending at that moment would otherwise never
  // settle — the abort signal is what turns a closed stdin into a clean cancel rather than a
  // boot script hanging on a terminal that has gone away.
  const abort = new AbortController();
  rl.once("close", () => abort.abort());
  // Line mode: SIGINT arrives as an event here rather than killing the process mid-prompt,
  // so Ctrl-C takes the same cancel path as `q` and leaves nothing on stdout.
  rl.on("SIGINT", () => rl.close());

  const ask = async (prompt: string): Promise<Answer> => {
    try {
      return classify(await rl.question(prompt, { signal: abort.signal }));
    } catch {
      return CANCEL;
    }
  };

  try {
    return await drive(io, write, ask);
  } finally {
    rl.close();
  }
}

// ── the step machine ────────────────────────────────────────────────────────
// A cursor rather than an index, so the permission step can be one screen PER AXIS and
// `back` still walks them in order. Back is free everywhere because nothing has happened:
// no reconcile, no kill, no DELETE, no exec until cli.ts gets a confirmed plan.
type Cursor = "provider" | "model" | "effort" | `permission:${number}` | "history" | "options" | "review";

async function drive(
  io: WizardIo,
  write: (s: string) => void,
  ask: (prompt: string) => Promise<Answer>,
): Promise<WizardOutcome> {
  const installed = new Map<string, string | null>();
  for (const cap of CAPABILITIES) installed.set(cap.key, resolveExecutable(cap.key, io.env));

  let provider: ProviderCapability = CAPABILITIES[0];
  let model: ModelChoice = { kind: "provider-default" };
  let effort: EffortChoice = { kind: "provider-default" };
  let permissions: AxisChoice[] = [];
  let history: HistoryChoice = { kind: "new" };
  // The env value is a SUGGESTION on a TTY, never authority and never a confirmation: it
  // pre-fills the prompt and the operator still presses Enter on it.
  let sid = io.env.ORCHESTRATOR_SID ?? "orchestrator";

  write(
    "\n[orchestrator-boot] Orchestrator boot wizard (#1181)\n" +
      "  Nothing is listed, deleted, signalled or exec'd until you type YES on the review screen.\n" +
      "  This screen is drawn on stderr; the agreed command is handed to your shell on stdout.\n" +
      `  ${NAV}\n`,
  );

  let cursor: Cursor = "provider";
  for (;;) {
    if (cursor === "provider") {
      write("\n── 1. Provider ─────────────────────────────────────────────────────\n");
      const rows: ProviderCapability[] = [];
      for (const cap of CAPABILITIES) {
        const where = installed.get(cap.key) ?? null;
        if (where === null) {
          write(
            `   --  ${cap.key.padEnd(8)} ${cap.displayName} — UNAVAILABLE: no executable named '${cap.key}' ` +
              `on PATH. Install it yourself; this wizard never installs anything and never ` +
              `substitutes another provider for it.\n`,
          );
          continue;
        }
        rows.push(cap);
        write(
          `   ${String(rows.length).padEnd(2)}  ${cap.key.padEnd(8)} ${cap.displayName} — capabilities measured at ` +
            `${cap.measuredVersion}; provenance ${cap.provenance} (bytes hashed, publisher signature NOT verified)\n` +
            `       ${where}\n`,
        );
      }
      if (rows.length === 0)
        return { kind: "cancelled", reason: "no registered provider executable is on PATH; nothing to boot into" };
      const hint = io.env.ORCHESTRATOR_CLI;
      if (hint !== undefined && hint !== "")
        // A SUGGESTION, printed and nothing more. On a terminal the environment does not
        // select and does not confirm; this line exists so an operator who set the variable
        // is not left wondering whether it took effect silently.
        write(
          `   (ORCHESTRATOR_CLI in this environment says '${hint}'. On a terminal that is a hint,\n` +
            "    not a selection — choose a number below.)\n",
        );
      const a = await ask(`provider [1-${rows.length}]: `);
      if (a === CANCEL) return { kind: "cancelled", reason: "cancelled at the provider step" };
      if (a === BACK) {
        write("   (already the first step)\n");
        continue;
      }
      const index = Number(a);
      if (!Number.isInteger(index) || index < 1 || index > rows.length) {
        write("   not one of the listed numbers; an unavailable provider is not selectable.\n");
        continue;
      }
      const chosen = rows[index - 1];
      if (chosen.key !== provider.key) {
        // Every later choice is provider-local, so switching provider must discard them
        // rather than carry one provider's token into another's argv.
        model = { kind: "provider-default" };
        effort = { kind: "provider-default" };
        history = { kind: "new" };
        permissions = [];
      }
      provider = chosen;
      if (permissions.length === 0) permissions = [...restrictiveDefaults(provider)];
      cursor = "model";
      continue;
    }

    if (cursor === "model") {
      write("\n── 2. Model ────────────────────────────────────────────────────────\n");
      write(`   ${provider.model.flag} — ${provider.model.evidence}\n`);
      write(`   Enter alone = provider default. ${provider.model.defaultNote}\n`);
      write("   No model catalogue is pinned in this wizard, so nothing here claims to be 'the latest'\n");
      write("   and nothing here can promise your account may use what you type — the provider answers\n");
      write("   that at boot. Shared fresh-model discovery is #1148's; this step will call it, not copy it.\n");
      const a = await ask("model id (or Enter for the provider default): ");
      if (a === CANCEL) return { kind: "cancelled", reason: "cancelled at the model step" };
      if (a === BACK) {
        cursor = "provider";
        continue;
      }
      if (a === "") {
        model = { kind: "provider-default" };
        cursor = "effort";
        continue;
      }
      const v = validateModel(provider, a);
      if (!v.ok) {
        write(`   refused: ${v.error.field} ${v.error.message}\n`);
        continue;
      }
      model = v.choice;
      cursor = "effort";
      continue;
    }

    if (cursor === "effort") {
      const cap = provider.effort;
      if (cap.kind === "unsupported" || cap.kind === "gap") {
        // NOT shown as "default" — an absent capability and a defaulted one are different
        // facts, and this is the screen where conflating them would become a claim.
        write("\n── 3. Effort ───────────────────────────────────────────────────────\n");
        write(
          `   not offered for ${provider.key} ${provider.measuredVersion}: ${cap.evidence}\n` +
            `   ${cap.kind === "gap" ? "This is a RECORDED GAP, not a proven absence, and not a value borrowed from another provider." : "Measured absent at the CLI."}\n`,
        );
        effort = { kind: "provider-default" };
        const a = await ask(`${NAV} Enter to continue: `);
        if (a === CANCEL) return { kind: "cancelled", reason: "cancelled at the effort step" };
        cursor = a === BACK ? "model" : "permission:0";
        continue;
      }
      write("\n── 3. Effort ───────────────────────────────────────────────────────\n");
      if (cap.kind === "enum") {
        write(`   ${cap.flag} — measured values at ${provider.measuredVersion}: ${cap.values.join(" | ")}\n`);
        write(`   ${cap.evidence}\n`);
      } else {
        write(`   ${cap.flag} — ${cap.evidence}\n   ⚠ ${cap.warning}\n`);
      }
      const a = await ask("effort (or Enter for the provider default): ");
      if (a === CANCEL) return { kind: "cancelled", reason: "cancelled at the effort step" };
      if (a === BACK) {
        cursor = "model";
        continue;
      }
      if (a === "") {
        effort = { kind: "provider-default" };
        cursor = "permission:0";
        continue;
      }
      const v = validateEffort(provider, a);
      if (!v.ok) {
        write(`   refused: ${v.error.field} ${v.error.message}\n`);
        continue;
      }
      effort = v.choice;
      cursor = "permission:0";
      continue;
    }

    if (cursor.startsWith("permission:")) {
      // Annotated: `cursor` is later assigned `permission:${at + 1}`, so leaving this to
      // inference makes the cursor's type depend on its own initializer (TS7022).
      const at: number = Number(cursor.slice("permission:".length));
      if (at >= provider.axes.length) {
        cursor = "history";
        continue;
      }
      const axis = provider.axes[at];
      // Already disabled by a value chosen on an earlier axis (codex's combined bypass covers
      // approval AND sandbox). Asking again would either re-add a contradictory policy or
      // imply the earlier choice had not taken effect.
      const disabledBy = permissions.find((p) => p.axis !== axis.axis && p.covers.includes(axis.axis));
      if (disabledBy !== undefined) {
        write(
          `\n── 4.${at + 1} ${axis.axis} (${provider.key} ${axis.flag}) ──────────────────────────\n` +
            `   not asked: '${disabledBy.value}' on the ${disabledBy.axis} axis already disables ${axis.axis},\n` +
            `   so no ${axis.flag} value is passed. Go back (b) to change that choice.\n`,
        );
        permissions = permissions.filter((p) => p.axis !== axis.axis);
        const a = await ask(`${NAV} Enter to continue: `);
        if (a === CANCEL) return { kind: "cancelled", reason: `cancelled at the ${axis.axis} step` };
        cursor = a === BACK ? (at === 0 ? "effort" : `permission:${at - 1}`) : `permission:${at + 1}`;
        continue;
      }
      // Re-seed the restrictive default if an earlier pass dropped this axis (it was covered
      // then, and the operator has since gone back and un-covered it). An axis that reached
      // the review screen with no value would be a plan missing a required choice.
      if (permissions.find((p) => p.axis === axis.axis) === undefined) {
        const seed = restrictiveDefaults(provider).find((d) => d.axis === axis.axis);
        if (seed !== undefined) permissions = [...permissions, seed];
      }
      const current = permissions.find((p) => p.axis === axis.axis);
      write(`\n── 4.${at + 1} ${axis.axis} (${provider.key} ${axis.flag}) ──────────────────────────\n`);
      write(`   ${axis.evidence}\n`);
      axis.values.forEach((v, i) => {
        const mark = v.risk === "bypass" ? "⚠ BYPASS" : v.risk === "elevated" ? "⚠ elevated" : v.risk;
        write(`   ${String(i + 1).padEnd(2)}  ${v.value.padEnd(38)} [${mark}]\n       ${v.note}\n`);
      });
      write(
        `   Default (Enter) = ${current?.value ?? "?"}, the most restrictive value with evidence. An\n` +
          "   elevated or bypass value is never pre-selected and never reachable by pressing Enter.\n",
      );
      const a = await ask(`${axis.axis} [1-${axis.values.length}]: `);
      if (a === CANCEL) return { kind: "cancelled", reason: `cancelled at the ${axis.axis} step` };
      if (a === BACK) {
        cursor = at === 0 ? "effort" : `permission:${at - 1}`;
        continue;
      }
      if (a !== "") {
        const index = Number(a);
        if (!Number.isInteger(index) || index < 1 || index > axis.values.length) {
          write("   not one of the listed numbers.\n");
          continue;
        }
        const value = axis.values[index - 1];
        if (value.risk === "elevated" || value.risk === "bypass") {
          // THE EXTRA TYPED ACKNOWLEDGEMENT. Not a y/N — a y/N is one keystroke away from
          // an elevated control tower, and "never silently select it" has to mean the
          // operator's own hand typed the value's name.
          write(
            `\n   ⚠ '${value.value}' ${value.risk === "bypass" ? "DISABLES a protection mechanism" : "stops the provider asking"} for the whole session.\n` +
              `     ${value.note}\n` +
              `     Type exactly:  ACCEPT ${value.value}\n`,
          );
          const ack = await ask("   acknowledgement: ");
          if (ack === CANCEL) return { kind: "cancelled", reason: `cancelled at the ${axis.axis} acknowledgement` };
          if (ack === BACK || ack !== `ACCEPT ${value.value}`) {
            write("   not acknowledged; the value was NOT selected.\n");
            continue;
          }
        }
        permissions = [
          ...permissions.filter((p) => p.axis !== axis.axis),
          { axis: axis.axis, value: value.value, argv: value.argv, risk: value.risk, covers: value.covers },
        ];
      }
      // A value that covers another axis (codex's combined bypass) makes the axes it covers
      // moot; drop them so the review screen cannot show two contradictory policies.
      const covered = new Set(permissions.flatMap((p) => p.covers.filter((c) => c !== p.axis)));
      if (covered.size > 0) permissions = permissions.filter((p) => !covered.has(p.axis));
      cursor = `permission:${at + 1}`;
      continue;
    }

    if (cursor === "history") {
      write("\n── 5. History ──────────────────────────────────────────────────────\n");
      write(
        "   A NEW conversation is the default. Resuming is explicit, and it is the provider's\n" +
          "   OWN native resume — scoped to this cwd/provider/configuration. No cross-provider\n" +
          "   continuity is offered, no transcript path is accepted, no session list is read, and\n" +
          "   native resume is NOT a context handoff.\n",
      );
      provider.history.forEach((h, i) => {
        write(`   ${String(i + 1).padEnd(2)}  ${h.mode.padEnd(9)} ${h.evidence}\n       scope: ${h.scope}\n`);
      });
      const a = await ask(`history [1-${provider.history.length}] (Enter = new): `);
      if (a === CANCEL) return { kind: "cancelled", reason: "cancelled at the history step" };
      if (a === BACK) {
        cursor = `permission:${Math.max(0, provider.axes.length - 1)}`;
        continue;
      }
      if (a === "") {
        history = { kind: "new" };
        cursor = "options";
        continue;
      }
      const index = Number(a);
      if (!Number.isInteger(index) || index < 1 || index > provider.history.length) {
        write("   not one of the listed numbers.\n");
        continue;
      }
      const support = provider.history[index - 1];
      if (support.mode !== "selected") {
        history = support.mode === "last" ? { kind: "last" } : { kind: "new" };
        cursor = "options";
        continue;
      }
      const spec = support.selector;
      if (spec === undefined) {
        write("   this provider has no measured selector form.\n");
        continue;
      }
      write(`   selector form: ${spec.describe}\n   ${support.evidence}\n`);
      const sel = await ask("selector: ");
      if (sel === CANCEL) return { kind: "cancelled", reason: "cancelled at the history selector" };
      if (sel === BACK) continue;
      const bad = validateSelector(spec.form, "history selector", sel);
      if (bad !== null) {
        write(`   refused: ${bad.message}\n`);
        continue;
      }
      history = { kind: "selected", selector: sel };
      cursor = "options";
      continue;
    }

    if (cursor === "options") {
      write("\n── 6. Important supported options ──────────────────────────────────\n");
      write(`   Everything below was measured at ${provider.key} ${provider.measuredVersion}. This wizard does not\n`);
      write("   run the provider to describe it, so an option missing from this list is UNMEASURED,\n");
      write("   not 'the same as another provider's'.\n");
      for (const opt of provider.info) write(`   ${opt.label}\n       ${opt.detail}\n`);
      write(`   cwd (inherited, display only): ${io.cwd}\n`);
      write(
        `       The shell that runs bin/orchestrator-boot.sh execs the bridge and KEEPS this cwd.\n` +
          `       ${provider.cwd.note}\n` +
          "       This wizard cannot change it: a Node chdir inside a command substitution moves\n" +
          "       only this short-lived child, never the parent shell. Cancel and cd first if it is wrong.\n",
      );
      write(`   ORCHESTRATOR_SID — the bridge's id, the singleton guard's match token, and the\n`);
      write(`       registry record this boot may reconcile. Current suggestion: ${sid}\n`);
      const a = await ask(`session id [Enter = ${sid}]: `);
      if (a === CANCEL) return { kind: "cancelled", reason: "cancelled at the options step" };
      if (a === BACK) {
        cursor = "history";
        continue;
      }
      if (a !== "") {
        const v = validateSid(a);
        if (!v.ok) {
          write(`   refused: ${v.error.field} ${v.error.message}\n`);
          continue;
        }
        sid = v.sid;
      } else {
        const v = validateSid(sid);
        if (!v.ok) {
          write(`   refused: ${v.error.field} ${v.error.message}\n`);
          continue;
        }
        sid = v.sid;
      }
      cursor = "review";
      continue;
    }

    // ── 7. review + the one confirmation ────────────────────────────────────
    const plan: BootPlan = { provider, sid, model, effort, permissions, history, inheritedCwd: io.cwd };
    write("\n── 7. Review ───────────────────────────────────────────────────────\n");
    for (const line of describePlan(plan)) write(`   ${line}\n`);
    write("\n   This boot WILL:\n");
    for (const line of describeEffects(plan)) write(`     - ${line}\n`);
    write("\n   Command your shell will become (one element per line):\n");
    // Prefixed, on fd 2. Nothing here may look like the fd 1 contract channel.
    for (const element of buildExecArgv(plan)) write(`     | ${element}\n`);
    const elevated = elevatedChoices(plan);
    if (elevated.length > 0) {
      write(`\n   ⚠ ELEVATED: ${elevated.map((c) => `${c.axis}=${c.value}`).join(", ")}\n`);
      write(`     To reuse this plan without a terminal, the caller must set\n     AIGENTRY_BOOT_RISK_ACK='${ackPhrase(plan)}'\n`);
    }
    // The accepted set is stated, not implied. The comparison below is case-insensitive, so a
    // screen that said only "type YES" left an operator to discover by experiment whether
    // `yes` works — and a reader of the code to wonder whether the looseness was intended.
    // It is: the affirmative WORD is required, and nothing shorter or longer than it passes.
    write(
      "\n   Type YES to boot — the whole word, in any case: YES, yes, Yes and yEs all confirm.\n" +
        "   Anything else cancels and acts on nothing, including: Enter (the default answer is\n" +
        "   no), 'y' or 'Y' alone, 'ye', 'YES!', 'yes please' or any other trailing text, 'q',\n" +
        "   Ctrl-C and EOF. Cancelling here leaves stdout empty and touches nothing at all.\n",
    );
    const a = await ask("confirm [yes/NO]: ");
    if (a === CANCEL) return { kind: "cancelled", reason: "cancelled at the review step" };
    if (a === BACK) {
      cursor = "options";
      continue;
    }
    if (a.toLowerCase() !== "yes") return { kind: "cancelled", reason: "the review was not confirmed (the default answer is no)" };
    return { kind: "plan", plan };
  }
}
