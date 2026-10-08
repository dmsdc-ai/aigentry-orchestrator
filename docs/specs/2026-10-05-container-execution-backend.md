# SPEC — Container execution backend for confined workers (task 1193)

Status: design only, no code. Author: ce1193akc-architect, 2026-10-05. Source snapshot:
`base-int2/repo` (paths below are relative to it). Evidence labels: **[src]** = read in the snapshot at the
cited line; **[ext]** = a fact about a third-party product, NOT verified here, to be checked before relying
on it; **[design]** = a proposal in this spec.

## 1. Problem, goals, options

**Problem.** A confined worker today is `dispatch → prepareWorkerSandbox → launcher.sh → runner → srt`
(`src/dispatch/cli.ts:1179-1181`, `src/session/worker-sandbox.ts:284-289`,
`src/session/worker-sandbox-runner.ts:10-14`). `srt` is Seatbelt on macOS and bubblewrap on Linux. Both
the preparer and the runner refuse every other platform (`worker-sandbox.ts:175`,
`worker-sandbox-runner.ts:57`). Windows therefore refuses confined spawn (PRINCIPLES P6), and there is no
unrestricted fallback (Rule 46.3). D-E asks whether a container environment could fill that gap.

**Goals.** G1: a Windows-host operator gets a worker whose file, process and network scope is *enforced and
evidenced* (Rule 46.2), not just requested. G2: the worker contract does not change. It keeps the same
scope file (`WorkerScope`, `worker-sandbox.ts:13-20`), the same sealed manifest and hash, the same
visibility in the operator's terminal and the same telepty inject path. G3: nothing gets weaker on
macOS/Linux (P9). G4: the container runtime stays optional (Article 17).

**Non-goals.** Hosting the orchestrator or the telepty daemon in a container. Multi-host or remote workers.
Windows containers (Windows-kernel images). Replacing `srt` on macOS/Linux. A GUI. Shipping in 0.2.2:
0.2.2 keeps the P6 refusal unchanged (see §6).

### Options (what "runnable in a container environment" can mean)

| | Solves | Costs | Cannot do |
|---|---|---|---|
| **A. Workers in containers, orchestrator on host.** The container is a second isolation backend next to `srt`. | Windows-host confined workers (G1). Uniform worker environment on all OSes. Default-deny filesystem view. cgroup limits. | Optional runtime install. A new image supply chain. Socket privilege (§3). Path translation on Windows. An egress-proxy sidecar. | Run without a runtime. Use host-installed CLIs on Windows (they are Windows binaries). Read the macOS Keychain from inside. |
| **B. Whole control plane in a container/compose project** (orchestrator + telepty daemon + workers). | Server/CI use. Reproducible install. | Workers must either share the control-plane container, which gives no isolation between them, or the control plane needs the runtime socket, which hands root-equivalence to an AI orchestrator session. Terminal hosts (cmux, iTerm, WezTerm) live on the host, so workers become headless (`workspace-host.sh:955-961`) and attachable only through `docker exec`. The daemon port must be published, which means auth and exposure work. | Native terminal integration. Host credentials without copying them in. It also breaks "the user's terminal IS the bridge" (`bin/orchestrator-boot.sh:16-22`). |
| **C. Dev container for contributors** (`.devcontainer/`). | A reproducible contributor toolchain (node ≥20.11, bash, python3, tmux). | Small: one recipe. | Confine workers. `srt`'s bubblewrap inside a default-seccomp container needs user namespaces that are normally blocked [ext], so confined-spawn tests may not run there. |
| **D. WSL2 as the Linux host for the existing `srt` backend** (native Windows orchestrator launches the unchanged runner via `wsl.exe`). This shape is suggested by `bin/init/cli.mjs:138-141`, which already sends Windows users to WSL2. | Windows confinement with **no image** and the unchanged runner/preflight. | The user must provision a distro (node, bubblewrap, socat, ripgrep, Linux CLI builds). Windows interop (running `.exe` from Linux) must be proven blocked. drvfs (`/mnt/c`) breaks the 0600/uid checks (`worker-sandbox.ts:409-421`, `claude-worker-oauth.ts:89-92`). PIDs in the receipt are Linux PIDs, so host `process.kill(pid,0)` checks (`worker-sandbox.ts:307-308`) do not apply. | One-click setup (Art. 10). Uniformity with macOS/Linux. |
| **E. Whole orchestrator inside WSL2.** | Works today per `bin/init/cli.mjs:140`. | None new. | It is not native Windows (fails D-B). |

**Recommendation: A**, limited to workers. B and C are not needed for G1. D is the documented fallback if
the human declines decision H1 or H2 (§6). Every Windows container runtime runs Linux containers in a
WSL2/Hyper-V VM anyway [ext], so A and D share the same kernel boundary. A buys a default-deny view,
uniformity and a sealed environment. It pays for them with a supply chain.

## 2. Design of option A against the current code

### 2.1 Where the backend choice plugs in

1. **Selection** [design]. A new field `backend: "srt" | "container"` is sealed into `WorkerManifest`
   (`worker-sandbox.ts:22-43`), so it is covered by the manifest hash (`:281-283`) and replayed unchanged
   on auto-restart (Rule 46.4). It is chosen by `AIGENTRY_WORKER_BACKEND` in the controller env:
   - win32: `container` is the only backend. If unset or the runtime is unavailable →
     `SANDBOX_PLATFORM_UNSUPPORTED`, exactly as today (P6).
   - darwin/linux: default `srt`, `container` is opt-in.
   - **No implicit cross-backend fallback.** A failure of the selected backend refuses with exit 78; it
     never falls back to the other backend and never to an unrestricted launch.
2. **Preparer.** `prepareWorkerSandbox` (`worker-sandbox.ts:172-296`) keeps its validation prefix
   (CLI/argv/tool-policy/binding, `:175-189`). Changes:
   - The `:175` platform gate becomes per-backend.
   - The `SandboxRuntimeConfig` block (`:261-270`) is built only for `srt`. For `container`, a
     `container` record is built and sealed (§2.2).
   - `executable(argv[0])` (`:215`) and the `apply_patch` symlink (`:205-209`) are host-binary concepts.
     For `container` the command is an absolute in-image path, the identity is the image ID (§3.1), and
     no host binary is linked.
   - `--add-dir` arguments (`:230,236`) and `--append-system-prompt-file` (`:257-258`) are rewritten to
     container paths (§2.5).
   - `tmp` (`:195-198`) becomes an in-container tmpfs, not a host directory.
3. **Runner.** `worker-sandbox-runner.ts` keeps manifest verification (`:42-56`) and the
   OAuth-marker check (`:50-53`).
   - For `container`, `run()` builds a runtime argv instead of calling
     `SandboxManager.wrapWithSandboxArgv` (`:10-11`).
   - It replaces `isSupportedPlatform`/`checkDependenciesAsync` (`:57,65`) with runtime checks: binary
     identity, server reachable, image present locally.
   - The child is still spawned with `stdio: "inherit"` (`:13`).
4. **Launcher.** `launcher.sh` is bash (`worker-sandbox.ts:287`) and so is the guard launcher
   (`cli.ts:171-189`). Native win32 needs a non-bash equivalent. This belongs to the Windows lane (P5) and
   is a **precondition**, not part of this feature (§7 R1).
5. **Dispatch.** `spawnWorkspace` (`cli.ts:1108-1196`) needs no structural change. It passes the backend
   through env, and `boot-prepare --confined` (`cli.ts:1129`) keeps producing argv only.

### 2.2 Scope → mounts and network policy

`loadWorkerScope` (`worker-sandbox.ts:81-98`) stays the single validator. It already accepts only absolute
literal paths, rejects root/home/ancestors-of-home, and accepts only `host:443` public names. Mapping
[design]:

| Scope / staging item | Container mount | Mode |
|---|---|---|
| each `scope.read` path | same path (POSIX) or mapped path (§2.5) | `readonly` |
| each `scope.write` path | same / mapped | read-write |
| role cwd (`cwd`, `:190`) | mapped | `readonly` (today: `denyWrite`, `:266`) |
| attempt `home` (`:193`) | `/home/worker` | read-write, except `.telepty`, `.codex/config.toml`, `.claude/settings.json` re-mounted `readonly` (mirrors `denyWrite`, `:266-267`) |
| git hook copy (`:212-214`) | mapped | `readonly` |
| `TMPDIR` | `--tmpfs /tmp` (size-capped, `noexec` not set: CLIs execute from tmp) | — |
| OAuth handoff file (`:201-202`) | `/run/aigentry/oauth-token`, single file | `readonly` |
| image root | — | `--read-only` |

Nothing else is mounted. The filesystem view is default-deny, where `srt` is a deny-list plus exceptions
(`:264-265`). The canaries (`:218-222`) are never mounted.

- Mounts use `--mount type=bind,source=…,target=…[,readonly]` and never `-v`, because the colon in
  `-v` is ambiguous with drive letters.
- Paths containing `,` or `"` are refused (`SANDBOX_SCOPE_PATH`), not quoted.
- Mounts are emitted parents-first, so a `readonly` parent with a writable child works.
- `protectedPaths` (`:238-241`) is still enforced before any mount.

**Network.** The runtime cannot filter egress by domain, so there are two containers per attempt:
- an **internal network** `aigentry-<attempt>` (`--internal`: no route out, no host gateway);
- a **worker** attached only to that network;
- an **egress proxy** attached to both that network and a default bridge.

The proxy runs from the same image with a different entrypoint. It is node standard library only: a
`CONNECT` proxy that allows exactly `scope.domains` on port 443. It resolves DNS itself and refuses
loopback, private, link-local and host-gateway answers (DNS rebinding). It also refuses IP literals and
accepts no plain HTTP. Reusing `srt`'s own proxy inside the container is preferred if it runs standalone
(not verified, §7). The worker gets `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY=""`.

Like `srt` (`allowUnixSockets: []`, `allowLocalBinding: false`, `:262-263`), the worker cannot reach the
host loopback, so the telepty daemon port is unreachable. This matches the current preflight's 3848
probe (`worker-sandbox-runner.ts:81-82`).

**Fixed hardening flags** [design] are emitted by code and are not configurable:
`--read-only --cap-drop=ALL --security-opt=no-new-privileges --init --pids-limit --memory --cpus
--user <uid:gid> --pull=never --entrypoint <fixed> --label aigentry.managed=1 --label
aigentry.sid=… --label aigentry.attempt=… --name aigentry-<sid>-<attempt8>-<run>`.

**Refused forever:** `--privileged`, `--cap-add`, `--network host`, `--pid/--ipc/--uts host`,
`--device`, `seccomp/apparmor=unconfined`, any mount of a runtime socket, and `--env-file` of host env.
The env is the explicit `childEnv` (`worker-sandbox.ts:243-253`) with paths rewritten.

### 2.3 Visibility, attach and the session daemon

Unchanged by construction:
- The terminal adapter runs `telepty allow --id <sid> --auto-restart <launcher>` on the host
  (`bin/lib/workspace-host.sh:443,869,903,914`; headless: `telepty spawn`, `:958`).
- The launcher execs the runner, and the runner spawns `docker run -i -t …` with inherited stdio.
- The PTY owned by `telepty allow` is the container's TTY. Operator view, `telepty attach`, inject and
  the readiness probe (`cli.ts:221-229`) all address the same PTY. **The worker never talks to the
  daemon.** It has no socket, no token and no route.

This satisfies Rule 49.2 ("no host-wide control token or socket to workers"). Reporting stays as today:
files in write scope plus host-side transport (the sandbox already blocks it, `worker-sandbox-runner.ts:81`).

Details [design]:
- `--detach-keys` is set to an unlikely sequence, so Ctrl-P Ctrl-Q in the CLI is not swallowed.
- `--sig-proxy=true`, and the runner's SIGTERM/SIGINT forwarding (`worker-sandbox-runner.ts:24-26`) is
  kept.
- Auto-restart replays the sealed manifest. The runner first removes any same-attempt containers by
  label, then starts a fresh one. Restrictions cannot disappear on restart (Rule 46.4).

### 2.4 Provider credentials

Today `seedAuth` (`worker-sandbox.ts:130-170`) copies the host Claude/Codex credential into the per-attempt
HOME, and the OAuth opt-in writes a private handoff that the runner reads only for the worker child
(`claude-worker-oauth.ts:43-107`, `worker-sandbox-runner.ts:89-92`).

- **Container, default.** Same seed and same files. The HOME directory is bind-mounted, so exposure
  equals today's: the worker can read its own copy.
- **Container, OAuth opt-in.**
  - The host runner validates the handoff with the existing `readClaudeOAuthHandoff` (owner, mode,
    nlink, size, content).
  - It then bind-mounts that one file read-only.
  - A fixed in-container entrypoint reads it (size and content checks only: ownership and mode of
    Windows bind mounts are not meaningful [ext]) and puts it into the CLI child env only.
- **Rejected:** `-e TOKEN=…` and `--env-file`. They store the secret in container config, where
  `inspect` shows it and the daemon persists it while the container exists. This would widen exposure.
- **Never:** a secret in the image, build args, labels, logs or the manifest.
- **New exposure to state honestly:** on macOS/Windows the copy now lives in the runtime VM's file
  cache. On macOS the Keychain fallback (`:147`) still runs on the host and only the resulting file is
  mounted.

### 2.5 Path mapping (Windows hosts)

- POSIX hosts: identity mapping (target = host path). Dispatch texts that name host paths stay valid.
- win32 [design]: `C:\Users\a\p` → `/host/c/Users/a/p`.
  - Start from `realpathSync.native` casing, lowercase the drive letter, turn `\` into `/`.
  - Case-insensitive duplicates are merged.
  - UNC paths, `\\?\` paths, paths over 259 characters and reparse points inside scope roots
    (P4: refuse junctions/symlinks) are refused in phase 1.
- The map `{host, container, mode}[]` is sealed in the manifest and used for:
  - `AIGENTRY_TARGET_CWD` (`worker-sandbox.ts:249`) and `--add-dir`;
  - the staged context-ref path returned by `stageWorkerRef` (`worker-sandbox.ts:319-341`) and turned
    into the inject message at `cli.ts:1291-1292`, which must carry the **container** path;
  - a host→container table appended to the session contract (`bin/boot-prepare.mjs:241`), so the worker
    can translate the host paths written in the dispatch.
- Git on Windows mounts:
  - `core.fileMode=false`;
  - `safe.directory` set to the exact mapped write paths (never `*`), through the existing
    `GIT_CONFIG_COUNT` channel (`worker-sandbox.ts:250-251`).
- Performance: Windows-drive bind mounts through Docker Desktop's WSL2 backend are reported to be much
  slower than the WSL filesystem [ext]. Phase 1 accepts this and measures it (§7 E4).

### 2.6 Lifecycle and cleanup

1. Prepare and seal (`worker-sandbox.ts:276-294`, unchanged mechanics).
2. The runner verifies hash, OAuth marker, runtime identity and image ID, then:
   - creates the internal network;
   - starts the proxy (detached);
   - runs the **preflight container** (same mounts, network and flags; entrypoint `preflight`;
     non-interactive; 15 s cap, as `:27`);
   - runs the worker container interactively.
3. Receipt `running`, then `exited` (`:16-17,93`). The **exact key set is kept**, because
   `readSealedAgentBinding` refuses extra keys (`worker-sandbox.ts:510`). `childPid` is the host PID of
   the runtime CLI client, so `assertConfinedTarget`'s `process.kill(pid,0)` (`:307-308`) still means
   something. Container identity goes into a separate private `container-evidence.json` (§2.7), and
   `assertConfinedTarget` gains a check that the labelled container is running.
4. On exit (in a `finally`, mirroring `SandboxManager.reset()` at `:96`): `rm -f` the proxy and any
   worker left behind, then `network rm`.
5. A crash or a SIGKILL of the client leaves containers behind (the client dying does not stop a `-t`
   container [ext]). To cover this, session cleanup (`bin/session-cleanup.sh` → `dist/src/cleanup/cli.js`)
   removes everything labelled `aigentry.sid=<sid>`. The reconciler sweep removes labelled containers
   whose sid is not live, using the existing seen-twice debounce idea (`workspace-host.sh:45-48`).
6. Artifacts live on host mounts, so removing a container loses nothing. Attempt directories are
   preserved as today.

### 2.7 Confinement receipt and evidence

The preflight script is the analogue of `worker-sandbox-runner.ts:73-83`. It runs as the worker user,
and **each line is a pass/fail code**:
- the outside canary's host path and its parent are absent (`ENOENT`; the canary exists on the host,
  and the runner checks that first);
- a write to a `readonly` mount fails with `EROFS`;
- a write and an unlink in a write mount succeed;
- TCP to `host.docker.internal:3848`, the network gateway and `127.0.0.1:3848` fails;
- direct TCP to an allowed domain without the proxy fails (no route);
- `CONNECT` through the proxy to a non-allowed host returns 403 (no external traffic needed);
- `/var/run/docker.sock` and any `*.sock` under mounts are absent;
- `CapEff` is 0 and `NoNewPrivs` is 1 (`/proc/self/status`);
- the uid is not 0;
- the root filesystem is read-only.

Then the runner reads the runtime's `inspect` output back and checks it, in the P2 style of "verify the
state, not the behaviour":
- the image ID equals the sealed one;
- `ReadonlyRootfs`, `CapDrop=ALL` and `no-new-privileges` are set, and `Privileged=false`;
- the exact mount set and RW flags match the sealed map;
- `NetworkMode` is the internal network and that network is `Internal=true`.

`container-evidence.json` (0600, Windows: P2 ACL) records: backend, runtime name and version, image ID,
container/network/proxy IDs, inspect digests, preflight codes and timestamps. It is bound to
`{task, sid, attempt, manifest hash}`. Any mismatch is `SANDBOX_PREFLIGHT_FAILED` and the worker never
starts.

## 3. Threat model versus the OS sandbox

**Stronger.**
- Default-deny filesystem: only mounts exist, where `srt` leaves unlisted paths such as `/etc`, `/opt` and
  other users' trees readable (`:264`).
- Process namespace: the worker cannot list or inspect host processes or their argv/env.
- cgroup limits on memory, pids and CPU (today there are none: README "Dispatch capacity").
- On macOS/Windows there is an extra VM boundary.
- A read-only root.

**Weaker.**
- **Larger TCB:** daemon, VM, file-sharing layer, image contents.
- **The runtime socket is root-equivalent on the host** (rootful Linux: membership in the `docker` group
  equals root). On Docker Desktop it controls the VM and can bind-mount anything shared from the host
  [ext].
- A new supply chain (§3.1).
- On a rootful Linux engine, a container escape lands as root, where an `srt` escape lands as the same
  user.

**Different.**
- Network enforcement is an internal network plus our proxy, not `srt`'s proxy. DNS behaviour on internal
  networks must be proven (§7 R3).
- Ownership on mounts: Linux `--user uid:gid` / Podman `--userns=keep-id`; Docker Desktop maps through
  file sharing.
- Symlinks a worker creates inside write mounts resolve inside the container, so they cannot reach the
  host there. Host-side readers must still refuse them (P4), same as today.

**Who needs the socket.** Exactly the host-side runner and cleanup, as the operator. **Never** the worker,
the proxy, the preflight or any mount.

Note: dispatch is invoked by the orchestrator, which is itself an unconfined same-user AI session. So any
root-equivalence the user account holds through a socket is also held by that AI session. This is a
pre-existing property of the account, but this feature would *encourage* granting it. Hence:
- **Linux:** recommend rootless Docker or rootless Podman, where the socket is user-equivalent. Rootful
  works only after the human accepts decision H3.
- **macOS/Windows:** Docker Desktop, Podman Desktop and Rancher Desktop all run a VM; there the socket
  holder controls the VM [ext].

**Runtime binary.** Resolved to an absolute path, with its identity sealed in the manifest
(`assertExecutableIdentity`, `worker-sandbox.ts:50-54`) and `DOCKER_HOST`/`CONTAINER_HOST` recorded. The
context is fixed: the runner never follows an ambient context switch silently.

### 3.1 Image provenance and update

- **Who builds** (phase 1-2): the user's own runtime, by `aigentry-orchestrator container build`, from a
  recipe shipped inside the npm package (`package.json` `files`, `:33-57`). Nothing is published by the
  project.
- **Pins:**
  - base image by **digest**;
  - node version;
  - each CLI (`@anthropic-ai/claude-code`, `@openai/codex`) by exact version with npm integrity hashes in
    a shipped lockfile;
  - our entrypoint, proxy and preflight scripts copied from the package, with their sha256 recorded as
    image labels.
- **Verification:**
  - after the build, the local image ID and the recipe sha256 are stored in a private
    `~/.aigentry/container/image.json`;
  - the runner refuses if the image ID, the recipe-hash label or the script hashes differ (`--pull=never`
    stops silent substitution).
- **Honest limit:** OS packages make local builds pinned-input but not bit-reproducible.
- **Update:** a package release bumps the pins. The runner refuses a stale image ("rebuild required")
  instead of using it.
- **Publication:** a project-published, signed image (registry, signing key, provenance attestation,
  CVE cadence) is decision H2 and is not assumed.

## 4. Constitution review

The constitution's review section has **nine** questions, while the dispatch says "five". All nine are
answered; the five articles the dispatch names are 1, 2, 3, 9 and 17.

| Question | Answer |
|---|---|
| 1. Serves the preamble (closing the AI-skill gap)? | Yes. It removes the one documented Windows gap (P6) for confined delegation. |
| 2. Whose role (Art. 3)? | The orchestrator's spawn/isolation layer, beside `srt`. telepty is unchanged: it stays the transport and never learns about containers. aterm and devkit are untouched. |
| 3. Is the dependency really needed (Art. 1)? | On macOS/Linux, no: `srt` stays the default. On Windows there is no OS sandbox at all (P6). The candidates are a VM-backed runtime (A) or WSL2 (D), and both are VM-backed. Building our own Windows isolation would need native code, which P1 forbids. No npm dependency is added: node standard library plus an external CLI. |
| 4. Same on every OS (Art. 2)? | Better than today, since one backend can run on all three. Path translation makes Windows *texts* differ (§2.5). This difference is disclosed in the session contract. |
| 5. Do other components work without it (Art. 9)? | Yes. Without a runtime everything works, and only Windows confined spawn refuses, as in 0.2.2. |
| 6. One-click (Art. 10)? | Partly. Installing a runtime is a user step, and the image build is one command. Answer: **No** for a fresh Windows machine. Mitigation: `init` detects the runtime and prints the exact next step; it never installs anything. |
| 7. Forces "how" on the user (Art. 11)? | Only the runtime choice (H1). Backend selection is automatic on win32. |
| 8. Safeguards (Art. 14)? | Fail-closed at every step, no cross-backend fallback, a fixed flag set, preflight plus inspect read-back, label-scoped cleanup. |
| 9. SSOT contract (Art. 15)? | `WorkerManifest` gains `backend`/`container`/`pathMap`, and there is a new `container-evidence.json`. Register them if the manifest is an SSOT contract. Not checked here (SSOT not in inputs). |

**Article 17 (no external dependency) versus an optional runtime.**
- 17.1 is met: core features need only aigentry.
- 17.4 is met: macOS/Linux fall back to `srt`. Windows "falls back" to the present refusal, which is a
  *safe* fallback, not a feature-equivalent one.
- Q6 is a partial "No" for Windows one-click. The constitution says to redesign on any "No". The
  redesign options are D (still a user-provisioned VM) or nothing (P6). Neither is one-click either.
  This is surfaced to the human as H1, not waived here.

**Article 1, could it be done without it?** Not on Windows without native code or a VM. Option D is the
"without a container runtime" answer. It trades image supply chain for distro provisioning and unproven
interop blocking.

## 5. Platform matrix

| Host | Runtime (all [ext] facts to verify) | Status in this design |
|---|---|---|
| Windows 11 / 10 22H2, Pro/Enterprise | Docker Desktop (WSL2 backend). Paid subscription required for commercial use in larger organisations; at last known terms, over 250 employees or over USD 10M revenue. | Phase 1 target |
| Windows Home | WSL2 works; no Hyper-V backend | Supported via WSL2 backend |
| Windows (any) | Podman Desktop / Podman machine (Apache-2.0, WSL2); Rancher Desktop (Apache-2.0, moby or containerd) | Phase 2 (CLI-compatibility check) |
| Windows 10 1809-1909, Server 2019 | WSL2 unavailable or limited; Docker Desktop unsupported on Server | **Unsupported**. P6 refusal. Product minimum (P1) is lower than this feature's minimum. |
| Windows | Windows containers (Windows-kernel images) | **Unsupported** (size, licensing, worker CLIs) |
| macOS | Docker Desktop / Podman / Rancher / OrbStack (VM) | Opt-in, phase 2. `srt` stays the default. |
| Linux | rootless Docker or Podman recommended; rootful only after H3 | Opt-in, phase 2 |
| CI ubuntu-latest | Docker Engine present | **Primary automated evidence** for backend logic |
| CI windows-latest | Docker is reported to run Windows containers only; no Linux containers or WSL2 nesting | Unit tests (path map, refusals) only. Windows acceptance needs H5. |
| CI macos (arm64) | No Docker reported (no nested virtualisation) | Unit tests only |

Stays unsupported: native Windows without a runtime, rootful sockets without H3, gemini/grok workers
(already unsupported, `worker-sandbox.ts:176`), and remote runtimes (`DOCKER_HOST` pointing at another
machine), which are refused.

## 6. Phased plan

**0.2.2:** no change. The P6 refusal ships as specified. This feature needs a working native-win32 spawn
chain (launcher, `open-session`, `telepty allow` under ConPTY). That chain is owned by the Windows lane
and is not evidenced in the snapshot: `package.json:61-64` still lists only darwin/linux, and
`bin/init/cli.mjs:132-143` refuses win32.

| Phase | Slice | Acceptance evidence |
|---|---|---|
| 0 | Experiments E1-E6 (§7) on one Windows machine with Docker Desktop and on ubuntu CI. No product code. | A written measurement report per experiment. Any falsified item → HOLD and redesign (switch to D or stop). |
| 1 | **Smallest Windows slice.** Claude CLI only; docker-compatible CLI; win32 selects `container`; local image build command; scope→mount map with win32 path mapping; internal network plus node-stdlib proxy; preflight plus inspect read-back; receipt and `container-evidence.json`; runner `finally` cleanup plus label sweep in session cleanup; OAuth opt-in via file mount. | ubuntu-latest: full deny suite (Rule 46.5: forbidden read/write, symlink escape, host port, non-allowed domain, DNS, socket absence, restart keeps restrictions) on the real runtime. windows-latest: path-map/refusal unit tests plus "no runtime ⇒ `SANDBOX_PLATFORM_UNSUPPORTED`" (P6 test kept). Windows host (H5): the same deny suite plus a visible, injectable worker that completes one task and reports, recorded as NOTRUN until done. |
| 2 | Codex; macOS/Linux opt-in; Podman/Rancher; reconciler orphan sweep; resource-limit tuning. | Same suite per runtime. A kill-9 orphan test shows containers and networks removed within one sweep. |
| 3 | Optional: published signed image (only after H2); dev container (C). | Signature/provenance verified by the runner before use; recipe-hash parity. |

**Decisions for the human owner** (D-C: cost, privilege, private data, publication):
- **H1:** accept an optional third-party runtime (and, for commercial organisations, a possible Docker
  Desktop subscription cost) as the Windows prerequisite, or prefer D or the status quo.
- **H2:** images are built locally only, or the project publishes signed images (registry account,
  signing keys, CVE update duty).
- **H3:** permit rootful Linux runtimes, where socket = root, for the operator account that also runs the
  AI orchestrator; or require rootless.
- **H4:** new data paths: builds pull from a container registry and npm; Docker Desktop telemetry/sign-in
  [ext]; credential copies inside the runtime VM.
- **H5:** Windows verification infrastructure: a self-hosted Windows runner with virtualisation or a
  manual test machine. Both have a cost.
- **H6:** confirm the release placement (0.2.2 = refusal; container slice in a later release).

**Controller technical choices:**
- docker vs podman CLI abstraction;
- the mapping scheme (§2.5);
- reuse of `srt`'s proxy vs a stdlib proxy;
- fixed flags and limit defaults;
- the label schema;
- the evidence format;
- the base image and pins;
- the error names.

## 7. Risks (most severe first) and cheapest falsifying experiment

| # | Risk | Cheapest experiment that falsifies early |
|---|---|---|
| R1 | Native-win32 spawn chain is absent or `telepty allow`/ConPTY does not carry `docker run -it` (TUI, resize, inject). | **E1** (~30 min): on Windows, `telepty allow --id t1 -- docker run --rm -it <node image> node -e "<readline echo>"`, then `telepty inject t1 hello` and resize the pane. |
| R2 | No automated Windows evidence: windows-latest cannot run Linux containers, so P8 can never be met in CI. | **E2** (~5 min CI job): `docker info --format '{{.OSType}}'`, then `docker run --rm alpine true` on windows-latest. |
| R3 | Network leak: an internal network still forwards external DNS (exfiltration), or `host.docker.internal`/the gateway is reachable on Docker Desktop. | **E3:** `network create --internal`; from a container, `nslookup example.com`, TCP to `host.docker.internal:3848` and to the gateway. Run on Desktop (Windows) and Engine (Linux). |
| R4 | Windows bind-mount semantics break git or CLIs (modes, ownership, case, symlinks) or are unusably slow. | **E4:** mount a real repo writable; run `git status`/`commit`, a symlink write, `npm ci`; time it against the WSL filesystem. |
| R5 | A CLI ignores `HTTPS_PROXY` or fails through `CONNECT` (codex in particular). | **E5:** one-turn prompt with each CLI on the internal network plus proxy. |
| R6 | Orphans after client SIGKILL (container keeps running and holds the scope). | **E6:** `kill -9` the runtime client; inspect `ps`; run the label sweep. |
| R7 | Socket privilege normalised: rootful `docker` group makes the AI orchestrator root-equivalent. | Policy, not an experiment. H3; the runner reports `rootless=false` in evidence. |
| R8 | Image staleness and CVEs; local builds drift from the recipe. | Build twice a day apart; compare CLI and node versions plus label hashes. |
| R9 | Credential refresh inside the worker rotates the token and invalidates the host login (already true for `seedAuth` copies). | Watch an existing `srt` worker across one refresh; the container does not change it. |
| R10 | Article 10/17 friction makes the feature unused; D may be preferred. | H1 answer. |

**Not verifiable from source alone:**
- telepty's win32/ConPTY behaviour (telepty is not in the inputs);
- whether `srt`'s proxy runs standalone;
- `model-decision.ts` (the executable binding for an image-hosted CLI);
- `worker-sandbox-bind.ts`;
- the TypeScript cleanup and reconciler implementations (only the shim was read);
- the state of the Windows-lane launcher;
- every [ext] fact: licensing, file-sharing performance, internal-network DNS, Docker on GitHub runners,
  CLI proxy support, client-death semantics, Windows Server/WSL2 availability.

Windows behaviour is NOTRUN for this author. **Observations, not changed (Rule 29):**
- `README.md:5,93,102` says the orchestrator "is not published to npm", while this release is npm 0.2.2.
- `README.md:97` lists telepty 0.7.1, while `package.json:22` requires `^0.8.0`. Both look stale.
- No dead code was identified in the read paths.
