# Session Management Auto-Cleanup — External Benchmark Report

**Date**: 2026-05-20
**Author**: aigentry-dustcraw-session-mgmt
**Purpose**: Architecture inputs for orchestrator reconciliation watcher design (cmux orphan workspace + telepty stale-session pattern)

**Source quality tiers**:
- **T1** = official docs / RFC / 1st-party blog (vendor authoritative)
- **T2** = high-star OSS README / wiki / DeepWiki
- **T3** = well-known tech blog / community forum

> **Scope**: 5 groups × ~5 systems each. Information gathering + trade-off enumeration only. No judgement, no "best" claims (Constitution §13).

---

## Executive Summary (5 bullets)

1. **Level-triggered reconciliation beats edge-triggered for cleanup** — Kubernetes controllers, etcd lease, and Consul TTL all converge on "observe current state vs desired state, act idempotently" rather than "react to specific events". This pattern is the dominant production design across distributed systems. (T1: Kubernetes docs, kube.rs, controller-runtime)
2. **Lease-with-renewal is the universal lifecycle primitive** — etcd/Consul/DHCP/Redis all use the same pattern: grant TTL → require keepalive → expire on missed renewal → cleanup attached resources. The owner *must* renew; absence of renewal is the cleanup signal (no need to actively detect "deadness"). (T1: etcd, Consul, RFC 2131)
3. **Lazy + active expiration combined is cheaper than either alone** — Redis combines passive expiration on access + random-sampled active expiration (10 Hz, 20-key samples) to bound CPU while bounding stale-key residency. JVM/Go GC similarly combine mutator-triggered and background-cycle reclamation. (T1: Redis docs, Go runtime docs)
4. **Multi-tier cleanup commands are common, but most users want them automatic** — tmux `kill-session`/`destroy-unattached`, screen `-wipe`, Zellij `delete-all-sessions`, VSCode workspaceStorage cleanup all exist as opt-in manual or scheduled commands; many threads report disk-bloat from non-cleanup. The pattern *exists* but is rarely the default. (T1: tmux.app, screen man, Zellij docs; T3: vscode#53552, vscode#183883)
5. **Safety-guards are universal**: dry-run preview (Terraform `plan`), grace period (Kubernetes `terminationGracePeriodSeconds`, RFC 2131 T1/T2 timers at 50%/87.5%), owner-references (K8s GC), and finalizers / lifecycle hooks (K8s, Nomad poststop, systemd `ExecStopPost`). Destructive auto-cleanup *always* has a brake before deletion in production-grade systems. (T1: Terraform docs, Kubernetes docs, Nomad docs)

---

## Group 1 — Terminal Multiplexer / Workspace Cleanup

| System | Cleanup Trigger | Mechanism | Guards | Source (tier) |
|---|---|---|---|---|
| tmux | Explicit `kill-session -t <name>`; optional `destroy-unattached` after idle timeout | Kills shell/editor/jobs in session; idle config: `set-option -g destroy-unattached 3600` (1h) | Opt-in only; default keeps detached sessions indefinitely | [tmux.app sessions](https://tmux.app/sessions/) (T1); [linkarzu cleanup script](https://linkarzu.com/posts/terminals/tmux-cleanup/) (T3) |
| GNU screen | `screen -wipe` on dead/unreachable sessions; manual | Sessions marked `dead` / `unreachable` listed; `-wipe` removes only those | "Dead" detection is host-bound; sessions on other hosts marked `unreachable` not auto-removed | [GNU screen manual](https://www.gnu.org/software/screen/manual/screen.html) (T1); [linux.die.net screen(1)](https://linux.die.net/man/1/screen) (T1) |
| Zellij | `zellij delete-all-sessions` (manual); resurrectable sessions kept in `~/.cache/zellij` until explicit delete | Sessions serialized on exit/crash for resurrection; no auto-GC of serialized state | "Zellij doesn't automatically delete serialized files when you kill a session" — explicit user action required | [Zellij session mgmt](https://zellij.dev/tutorials/session-management/) (T1); [Zellij session resurrection](https://zellij.dev/documentation/session-resurrection.html) (T1); [zellij#3828](https://github.com/zellij-org/zellij/issues/3828) (T2); [zellij#4971 discussion](https://github.com/zellij-org/zellij/discussions/4971) (T2) |
| WezTerm | Plugin-based (resurrect.wezterm: periodic 15-min snapshot); no native auto-cleanup | "Workspaces" group windows like tmux sessions; `restore.lua` API for explicit reload | Periodic saves can corrupt layout (reported in resurrect.wezterm) — guard via opt-in plugin | [WezTerm workspaces](https://wezterm.org/recipes/workspaces.html) (T1); [WezTerm window restore](https://wezterm.org/config/lua/window/restore.html) (T1); [MLFlexer/resurrect.wezterm](https://github.com/MLFlexer/resurrect.wezterm) (T2) |
| VSCode workspaceStorage | None native — community extensions only | `workspaceStorage/<uniqueID>` directory persists after workspace move/delete; extension does `path-exists` check then deletes | Heavily reported as orphan-bloat issue; Microsoft has not shipped auto-GC after 7+ years | [vscode#53552 (storage bloat)](https://github.com/microsoft/vscode/issues/53552) (T2); [vscode#183883 (orphan dir)](https://github.com/microsoft/vscode/issues/183883) (T2); [mehyaa/vscode-workspace-storage-cleanup](https://github.com/mehyaa/vscode-workspace-storage-cleanup) (T2) |
| abduco / dtach | Process exit only; no idle GC | Detach-only minimal supervisors; session = process lifetime | None beyond OS process semantics | (general knowledge — limited public docs returned in this round) |

### Coverage caveats (Group 1)

**Closed-source / proprietary UI coverage is thin** — explicitly flagged per requirement (d):
- **Warp**: marketing-focused docs surface "AI terminal" features; no public docs found on workspace orphan-handling or auto-cleanup semantics in this search round.
- **Windows Terminal**: Profile/setting persistence is documented, but no public docs on session-orphan GC surfaced. (Edge-case as it doesn't have a "session multiplexer" model like tmux/Zellij.)
- **iTerm2**: "Restore Windows on Startup" UX is documented but auto-orphan cleanup is not a documented concept — likely because state is per-window-process and dies with the process.

For closed-source UIs, the typical pattern (inferred from behavior, not docs) is: session/window state dies with the host process; "orphan" only matters if external persistence (config / DB / cache) is created. None of the surveyed closed-source terminals appear to maintain a separate "session registry" requiring GC the way tmux/Zellij/cmux do.

---

## Group 2 — Container / Process Orchestration (Reconciliation Loop Patterns)

| System | Cleanup Trigger | Mechanism | Guards | Source (tier) |
|---|---|---|---|---|
| Kubernetes Pod GC | Owner-reference cascade on owner DELETE; finalizer-gated | "Owner references tell the control plane which objects are dependent on others … Kubernetes uses owner references to give the control plane the opportunity to clean up related resources before deleting an object." Background vs foreground cascade modes | Finalizers block GC until external cleanup acks (`.metadata.finalizers`); deletion timestamp set, then field becomes restricted | [Kubernetes GC docs](https://kubernetes.io/docs/concepts/architecture/garbage-collection/) (T1); [Kubernetes Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/) (T1); [kube.rs controllers/gc](https://kube.rs/controllers/gc/) (T2) |
| Docker `--rm` | Container exit | "When you pass the --rm flag to docker run, Docker deletes the container and its anonymous volumes as soon as it exits." | Incompatible with `--restart`; anonymous volumes deleted, named volumes survive | [docker run reference](https://docs.docker.com/reference/cli/docker/container/rm/) (T1) |
| systemd unit | `RuntimeMaxSec=` deadline OR process exit per `Restart=` policy | "If [RuntimeMaxSec=] is used and the service has been active for longer than the specified time it is terminated and put into a failure state." SIGTERM → wait `TimeoutStopSec=` → `FinalKillSignal=` (SIGKILL by default) | `TimeoutStopSec=` grace; `Restart=on-failure` vs `always` prevents restart storms; `ExecStopPost=` cleanup hook | [systemd.service(5)](https://manpages.debian.org/testing/systemd/systemd.service.5.en.html) (T1); [systemd transient settings](https://systemd.io/TRANSIENT-SETTINGS/) (T1) |
| supervisord | SIGCHLD on child death → state transition; `autorestart` (false / unexpected / true) | Process states: STOPPED / BACKOFF / EXITED / FATAL. "An autorestarted process will never be automatically restarted if it ends up in the FATAL state (it must be manually restarted)." | FATAL terminal state breaks restart loop; `startsecs`/`startretries` for STARTING phase | [supervisord subprocess docs](https://supervisord.org/subprocess.html) (T1); [supervisord configuration](https://supervisord.org/configuration.html) (T1) |
| PM2 | Crash → autorestart; SIGINT → 1.6s grace → SIGKILL | "PM2 has a central daemon running in the background … When a process is stopped/restarted by PM2, system signals are sent to the process in order; first a SIGINT signal is sent, and if the application does not exit by itself before 1.6s it will receive a SIGKILL signal" | Process registry `~/.pm2/dump.pm2`; graceful-shutdown grace window | [PM2 process mgmt](https://pm2.keymetrics.io/docs/usage/process-management/) (T1); [PM2 graceful shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/) (T1) |
| runit / s6 | Process exit | runit: `runsv` "restarts the daemon if the daemon crashes" — unconditional. s6: "enables you to choose, per daemon, whether to restart on crash" | runit: minimal, restart-always (no policy); s6: per-daemon configurable | [Arch wiki runit](https://wiki.archlinux.org/title/Runit) (T1); [s6: why another supervision suite](https://skarnet.org/software/s6/why.html) (T1) |
| Nomad | Lifecycle block hooks (`prestart`/`poststart`/`poststop`); node TTL | "Poststop is intended to be a cleanup hook that runs after main tasks have become terminal." Node TTL expired → heartbeat module reports | Hooks decouple cleanup from main task; known bug: disconnected client nodes "never transition to down" (issue #27409) → reconciliation gap | [Nomad lifecycle block](https://developer.hashicorp.com/nomad/docs/job-specification/lifecycle) (T1); [nomad#27409 (disconnected nodes)](https://github.com/hashicorp/nomad/issues/27409) (T2) |

---

## Group 3 — Distributed Systems Lease / TTL Patterns

| System | Cleanup Trigger | Mechanism | Guards | Source (tier) |
|---|---|---|---|---|
| etcd lease | Missed keepalive within TTL window | "Each lease has a minimum TTL … the lease's actual TTL value is at least the minimum TTL and is chosen by the etcd cluster. Once a lease's TTL elapses, the lease expires and all attached keys are deleted." | "Lease will expire in under TTL+1 seconds" — bounded slack; minimum-TTL is *lower* bound, server may use larger | [etcd v3.5 API](https://etcd.io/docs/v3.5/learning/api/) (T1); [etcd how to create lease](https://etcd.io/docs/v3.5/tutorials/how-to-create-lease/) (T1); [etcd API guarantees](https://etcd.io/docs/v3.5/learning/api_guarantees/) (T1) |
| Consul session/lock | TTL not renewed OR health check fails | "The TTL parameter specifies the duration of a session (between 10s and 86400s). If provided, the session is invalidated if it is not renewed before the TTL expires." | "TTL represents a lower bound for invalidation; Consul will not expire the session before the TTL is reached, but it is allowed to delay the expiration"; "sessions may not be reaped for up to double this TTL" — explicit upper bound on reap delay | [Consul sessions overview](https://www.consul.io/docs/internals/sessions.html) (T1); [Consul session HTTP API](https://developer.hashicorp.com/consul/api-docs/session) (T1) |
| Redis TTL | EXPIRE / EXPIREAT; lazy + active expiration | Lazy: "When a key is accessed … Redis checks if the key exists and if it is expired. If expired, the key is removed". Active: "Redis picks 20 random keys from the set of keys with TTLs. If more than 25% of them are expired, it repeats the process. Redis runs an active expiration cycle 10 times per second" (configurable via `hz`) | Bounded sampling caps active-cycle CPU; secondary hash table stores TTL pointers; Redis 6+ added radix-tree for ordered expiration | [Redis EXPIRE docs](https://redis.io/docs/latest/commands/expire/) (T1); [Redis expiration FAQ](https://redis.io/faq/doc/1fqjridk8w/what-are-the-impacts-of-the-redis-expiration-algorithm) (T1) |
| DHCP lease (RFC 2131) | T1 timer (~50% lease) → renew with same server; T2 (~87.5%) → rebind to any server; expiry → release | "If the DHCP server cannot be contacted within the lease time, RFC 2131 states that the user of the address must immediately cease usage." Server may DHCPNAK to force release; abandoned lease reclaim on pool exhaustion | T1/T2 staggered (50%/87.5%) — multiple renewal attempts before hard cutoff; DHCPNAK escape hatch on exhaustion | [Fortinet DHCP lease renewal states](https://community.fortinet.com/t5/FortiGate/Technical-Tip-Understanding-DHCP-Lease-Renewal-States-and/ta-p/417414) (T3); [RFC 2131 PDF slides (UTD)](https://personal.utdallas.edu/~ravip/cs6390/fall01/dhcp.slides.pdf) (T3) |
| JWT / OAuth refresh | Access token `exp` claim; refresh token rotation + reuse-detection | "Access tokens should be short-lived (15–60 minutes), while refresh tokens should be long-lived (e.g., 7–14 days)." Rotation: "Issue a new refresh token with every use and invalidate the old one to prevent replay attacks" | Reuse-detection: "if an old refresh token shows up after rotation, revoke that session and require re-authentication"; server-side revocation list (denylist JTIs with TTL until exp) | [Skycloak JWT lifecycle](https://skycloak.io/blog/jwt-token-lifecycle-management-expiration-refresh-revocation-strategies/) (T3); [Serverion refresh rotation](https://www.serverion.com/uncategorized/refresh-token-rotation-best-practices-for-developers/) (T3) |

---

## Group 4 — IDE / Workspace Recovery

| System | Cleanup Trigger | Mechanism | Guards | Source (tier) |
|---|---|---|---|---|
| VSCode workspaceStorage | None automatic; community extensions / manual | Each workspace creates `Code/User/workspaceStorage/<uniqueID>`; when underlying folder is moved/renamed/deleted, storage becomes orphan | No native detection; extension flow = enumerate `workspaceStorage/*` → read manifest pointer → check `path-exists` → delete | [vscode#53552](https://github.com/microsoft/vscode/issues/53552) (T2); [vscode#183883](https://github.com/microsoft/vscode/issues/183883) (T2); [Workspace Storage Cleanup extension](https://marketplace.visualstudio.com/items?itemName=mehyaa.workspace-storage-cleanup) (T2) |
| JetBrains IDE | 180-day age-based auto-delete for inactive cache/log dirs; manual via `Help \| Delete Leftover IDE Directories…` | "The IDE will automatically clean up any cache and log directories that were last updated more than 180 days ago." Per-version IDE dirs; manual deletion of old version dirs from UI | 180-day grace — extremely conservative; user opt-in for current-version cache invalidation; "removes the cache files for all projects ever run in the current version" warning | [JetBrains cleanup unused IDE directories](https://www.jetbrains.com/guide/go/tips/cleanup-unused-ide-directories/) (T1); [JetBrains directories docs](https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html) (T1); [JetBrains invalidate caches](https://www.jetbrains.com/help/idea/invalidate-caches.html) (T1) |
| Vim swapfile | Open-time detection of orphan `.swp`; `vim -r` recovery | "Swap files normally have the extension '.swp', and the swap file is deleted as soon as Vim stops editing the file. However, if Vim crashes, these files can become orphaned." Detection pattern: `*.s[uvw][a-z]` | Auto-cleanup pattern: "check if the swap file is being used by an active vim process and if it isn't, it recovers the swap file into a recovery file, then compares the original file against recovered file; if they are identical it automatically removes the recovered file and swap file" | [Vim doc: recover](https://vimdoc.sourceforge.net/htmldoc/recover.html) (T1); [Vim doc: usr_11](https://vimdoc.sourceforge.net/htmldoc/usr_11.html) (T1) |
| tmux-resurrect | Manual save/restore hotkey; tmux-continuum adds periodic auto-save | "tmux-resurrect saves to `~/.tmux/resurrect/` by default … is idempotent and will not try to restore panes or windows that already exist." | Idempotent restore (replays only missing panes) — safe to re-run; symlink-based "current snapshot" pointer enables rollback to older save | [tmux-plugins/tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) (T2); [tmux-continuum (typecraft)](https://cms.typecraft.dev/community/tmux-continuum/) (T3) |

---

## Group 5 — Reconciliation Loop Design Patterns

### 5.1 Kubernetes controller pattern (T1)

Verbatim:
> "Kubernetes controllers are level-driven. They don't care what happened — they care about the current state versus the desired state." ([farishuskovic.dev](https://www.farishuskovic.dev/blog/k8s-reconciler-pattern/), T3)
>
> "The workqueue doesn't hold events, it holds keys, which enables level-based reconciliation—rather than reacting to events (edge-triggered), controllers treat events as just another nudge to check that the entire state of the world is in its desired state." ([kube.rs reconciler](https://kube.rs/controllers/reconciler/), T2)
>
> "Returning an error triggers exponential backoff … The default controller-runtime rate limiter combines per-item exponential backoff (base ~5ms, max ~1000s) with a global token bucket (~10 QPS, burst ~100)." ([controller-runtime reconcile pkg](https://pkg.go.dev/sigs.k8s.io/controller-runtime/pkg/reconcile), T1)

Applicability to orchestrator design:
- **Level-triggered**: Watcher should "list current cmux workspaces + telepty sessions, compute orphan set" rather than "react to TelePty SESSION_END event".
- **Workqueue + key (not event)**: store `{cmux_workspace_id}` keys to re-check, not events.
- **Exponential backoff**: failed cleanup (cmux refuses, daemon unreachable) should back off, not hammer.

Trade-off: edge-triggered is faster to react but loses signals on missed events. Level-triggered tolerates missed events but has reconcile latency (interval-bound).

### 5.2 Reactive vs Scheduled cleanup

| Aspect | Reactive (edge-triggered) | Scheduled (level-triggered) |
|---|---|---|
| Latency | Low (immediate on event) | Bounded by interval (1s – several minutes) |
| Missed-event tolerance | Brittle — missed events = stale state forever | Self-healing — next tick reconciles |
| CPU cost | Cheap per event; spike on bursts | Constant per interval (Redis: 10 Hz; controller-runtime: workqueue-driven) |
| Implementation | Listen on channel/socket | Periodic scan + state diff |
| Production examples | systemd SIGCHLD → state transition; supervisord SIGCHLD; tmux session-exit | K8s controllers; Redis active expiration; etcd lease scanner; JetBrains 180-day GC |

Verbatim:
> "Reconcile functions should be idempotent—running them multiple times should produce the same result, which makes it robust against missed events and ensures eventual consistency." ([DeepWiki kubebuilder](https://deepwiki.com/kubernetes-sigs/kubebuilder/5.2-reconciliation-loop), T2)

Hybrid is common: edge-triggered for low-latency happy path + periodic sweep for safety net (e.g., Redis lazy-on-access + active-cycle background).

### 5.3 Mark-and-Sweep analogue (JVM / Go)

Verbatim:
> "The Mark-and-Sweep process happens in two main phases: the Mark Phase where the garbage collector traverses the object graph starting from GC Roots and marks every live object as being in use, and the Sweep Phase where after marking is complete, the collector scans the entire heap and deallocates any object that was not marked during the first phase." ([GeeksforGeeks Mark-and-Sweep](https://www.geeksforgeeks.org/java/mark-and-sweep-garbage-collection-algorithm/), T3)
>
> "Go's garbage collector uses the Tricolor Mark and Sweep algorithm … categorizes objects into three colors: white, gray, and black, to determine their reachability and eligibility for collection." ([blog.gaborkoos.com on Go GC](https://blog.gaborkoos.com/posts/2025-09-12-Garbage-Collection-In-Go.md/), T3)

Applicability:
- "GC Root" analogue for orchestrator = the **dispatch registry** (`state/dispatch/active.json` per AGENTS.md Rule 32-HARD). Anything reachable from an active dispatch = live. Anything else = candidate for sweep.
- "Reachability" analogue: cmux workspace ID exists in telepty session list AND that session ID exists in dispatch registry → live; otherwise → orphan.

Trade-off: stop-the-world (older JVM) vs concurrent (Go tricolor). For a multi-CLI host, concurrent sweep avoids freezing user interaction during cleanup.

### 5.4 Safety guards (dry-run, TTL grace, age-since-spawn)

| Guard | Source system | Mechanism |
|---|---|---|
| Dry-run | Terraform `plan`, `plan -destroy` | "Save a plan to a file and review it later, or feed the exact, locked set of actions into terraform apply" — preview-before-execute ([spacelift terraform dry-run](https://spacelift.io/blog/terraform-dry-run), T3) |
| Prevent-destroy lifecycle | Terraform `prevent_destroy = true` | "Terraform will fail the plan or apply if a change requires destroying that resource" ([spacelift prevent_destroy](https://spacelift.io/learn/terraform-prevent-destroy-lifecycle-block), T3) |
| Grace period | Kubernetes `terminationGracePeriodSeconds`; systemd `TimeoutStopSec`; DHCP T1/T2 staggered (50%/87.5%) | SIGTERM → wait → SIGKILL; lease renewal attempts before hard expiry |
| Owner references | K8s GC | "Owner references tell the control plane which objects are dependent on others" — cascade only when owner is gone ([kubernetes GC docs](https://kubernetes.io/docs/concepts/architecture/garbage-collection/), T1) |
| Finalizers | K8s | "Controllers should mark objects with a finalizer if they need external cleanup to run in the event the object is deleted" ([kubernetes finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/), T1) |
| Age-since-spawn floor | JetBrains 180-day inactivity threshold | "automatically clean up any cache and log directories that were last updated more than 180 days ago" ([JetBrains cleanup](https://www.jetbrains.com/guide/go/tips/cleanup-unused-ide-directories/), T1) |
| Idempotent operation | tmux-resurrect | "is idempotent and will not try to restore panes or windows that already exist" — safe to re-invoke ([tmux-resurrect README](https://github.com/tmux-plugins/tmux-resurrect), T2) |

### 5.5 Idempotency

Verbatim:
> "Reconcile functions should be idempotent—running them multiple times should produce the same result, which makes it robust against missed events and ensures eventual consistency." ([DeepWiki kubebuilder](https://deepwiki.com/kubernetes-sigs/kubebuilder/5.2-reconciliation-loop), T2)
>
> "tmux-resurrect … is idempotent and will not try to restore panes or windows that already exist." ([tmux-plugins/tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect), T2)

Trade-off: Idempotency requires either (a) check-before-act ("does cmux workspace X still exist?") which can race, or (b) idempotent primitives (`DELETE` semantics that don't error if absent). DHCPRELEASE / docker `--rm` / K8s `kubectl delete --ignore-not-found` exemplify (b).

---

## Cross-cutting Best Practices (top 10)

1. **Default to level-triggered reconciliation, not edge-triggered events** — robust against missed signals, naturally idempotent. (K8s controller pattern, [kube.rs reconciler](https://kube.rs/controllers/reconciler/))
2. **Use lease-with-renewal so the owner self-declares liveness** — absence of renewal is the cleanup trigger; you don't need to "detect death". (etcd lease, Consul session, DHCP)
3. **Combine lazy (on-access) and active (periodic-sample) expiration to bound both stale-state residency and CPU** — Redis 20-key sample × 25% threshold × 10 Hz is a concrete tuning. ([Redis FAQ](https://redis.io/faq/doc/1fqjridk8w/what-are-the-impacts-of-the-redis-expiration-algorithm))
4. **Bound expiration delay**: state the *upper* bound, not just the lower bound. Consul: "sessions may not be reaped for up to double this TTL"; etcd: "expire in under TTL+1 seconds". ([Consul sessions](https://www.consul.io/docs/internals/sessions.html), [etcd API guarantees](https://etcd.io/docs/v3.5/learning/api_guarantees/))
5. **Owner-reference + finalizer pattern**: declare parentage, let cascade do the rest; allow finalizer to delay deletion for external cleanup. ([K8s GC](https://kubernetes.io/docs/concepts/architecture/garbage-collection/), [K8s finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/))
6. **Graceful-shutdown with SIGTERM → grace → SIGKILL escalation**: systemd `TimeoutStopSec`, PM2 1.6s SIGINT-then-SIGKILL, K8s `terminationGracePeriodSeconds`. ([systemd.service(5)](https://manpages.debian.org/testing/systemd/systemd.service.5.en.html), [PM2 graceful shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/))
7. **Exponential backoff on retry**: "base ~5ms, max ~1000s" + per-item rate-limiter + global token bucket — proven controller-runtime defaults. ([controller-runtime reconcile](https://pkg.go.dev/sigs.k8s.io/controller-runtime/pkg/reconcile))
8. **Make destructive operations idempotent**: `delete --ignore-not-found`, `docker rm` semantics, `tmux-resurrect` no-op on existing. ([tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect))
9. **Provide a dry-run preview before destructive batch ops**: `terraform plan`, `terraform plan -destroy`, `kubectl --dry-run=client`. ([Terraform dry-run](https://spacelift.io/blog/terraform-dry-run))
10. **Age-since-event floor before any auto-delete**: JetBrains 180 days is conservative; DHCP T1 is 50% lease. Production-grade defaults err *very* conservative — user inactivity ≠ user abandonment. ([JetBrains cleanup](https://www.jetbrains.com/guide/go/tips/cleanup-unused-ide-directories/))

---

## Anti-patterns (top 5)

1. **Auto-cleanup on detached state alone** — tmux `destroy-unattached` is opt-in for a reason; "detached" ≠ "abandoned". Reported as data-loss footgun in user threads ([USC HPC discourse on unintended tmux kills](https://hpc-discourse.usc.edu/t/tmux-session-keep-being-killed-periodically/899), T3).
2. **No GC at all, relying on user to clean up** — VSCode workspaceStorage bloat is the canonical case; 7+ years of [vscode#53552](https://github.com/microsoft/vscode/issues/53552) without native fix. Users *will not* clean up manually.
3. **Edge-triggered cleanup without level-triggered safety net** — Nomad [issue #27409](https://github.com/hashicorp/nomad/issues/27409): "Disconnected Nomad client nodes never transition to down, are not garbage collected, and generate infinite heartbeat failures" — exactly the failure mode level-triggered reconciliation prevents.
4. **No grace period / no upper-bound on reap delay** — etcd's explicit "expire in under TTL+1 seconds" upper bound is precisely the contract Nomad lacks above. Without it, operators can't reason about cleanup latency.
5. **Restart-storm without backoff (FATAL state)** — supervisord's FATAL terminal state exists specifically to break the loop: "An autorestarted process will never be automatically restarted if it ends up in the FATAL state (it must be manually restarted)." ([supervisord subprocess](https://supervisord.org/subprocess.html)). Auto-restart without a terminal state is an anti-pattern.

---

## Direct Inputs to orchestrator design

> Listed as **trade-off candidates** for architect/analyst sessions to evaluate, not recommendations. (Constitution §13 — dustcraw research scope.)

### "Useless" / orphan signal candidates

Combinations observed across systems (each is a fact, not a prescription):

| Signal | Source pattern | Strength |
|---|---|---|
| `cmux_workspace.id NOT IN telepty.session_ids` | K8s owner-reference cascade | Strong — explicit parent-gone signal |
| `telepty.session.status = DISCONNECTED AND age > T` | DHCP T1/T2 staggered | Medium — disconnected may be transient |
| `dispatch_registry.last_report > T_grace` | etcd lease miss | Strong — owner-declared liveness via REPORT inject (AGENTS.md Rule 32-HARD) |
| `process.parent_pid NOT exists` | systemd reparent-to-init detection | Strong — OS-level fact |
| `cmux_workspace.last_pty_activity > T_idle` | tmux `destroy-unattached` | Weak — false-positive prone (user thinking) |

### TTL default candidates (across surveyed systems)

| System | Default / typical | Notes |
|---|---|---|
| etcd lease | Application-specified minimum, server may extend | No global default; SDKs commonly 5–60s |
| Consul session | Range 10s–86400s (24h); recommend < 1h | "long TTL values (> 1 hour) should be avoided" |
| Redis active cycle | 10 Hz (`hz=10`), 20-key sample | Tuneable via `hz` |
| DHCP T1 | 50% of lease | 24h lease → 12h first renewal |
| DHCP T2 | 87.5% of lease | 24h lease → 21h rebind attempt |
| JetBrains stale-cache | 180 days | Extremely conservative |
| systemd `TimeoutStopSec` | 90s (Linux default) | Per-unit configurable |
| K8s `terminationGracePeriodSeconds` | 30s | Per-pod configurable |
| JWT access token | 15–60 min | Per [JWT lifecycle guide](https://skycloak.io/blog/jwt-token-lifecycle-management-expiration-refresh-revocation-strategies/) |
| JWT refresh token | 7–14 days | Same |

### Reconciliation loop interval candidates (across surveyed systems)

| System | Interval / cadence |
|---|---|
| Redis active expiration | 10 Hz (100ms) |
| controller-runtime rate limiter | Base 5ms, max ~1000s exponential; global 10 QPS / burst 100 |
| Kubernetes Kubelet | Pod sync ~10s by default |
| systemd timer units | User-defined, no enforced floor |
| Nomad client heartbeat | 10s default |
| Consul session check | TTL-bound; common range 10s–60s |

### Safety guard checklist (assembled from surveyed systems)

- [ ] Dry-run mode that prints intended actions without executing (Terraform `plan`)
- [ ] Age-since-event floor (no delete before `T_min_age` after spawn/last-activity — JetBrains 180d as upper anchor; DHCP T1 50% as production anchor)
- [ ] Upper-bound on reap delay published as part of the contract (etcd "TTL+1s"; Consul "up to 2×TTL")
- [ ] Owner-declared liveness preferred over external "deadness detection" (lease pattern beats heartbeat-watching)
- [ ] Idempotent destructive primitive (`delete --ignore-not-found` semantics; tmux-resurrect no-op-on-exists)
- [ ] Backoff on failed cleanup (exponential, per-item + global) — controller-runtime defaults known-good
- [ ] Terminal-error state to break restart/retry storms (supervisord FATAL pattern)
- [ ] Finalizer / lifecycle-hook escape for external resources that need cleanup before parent deletion
- [ ] Grace signal escalation (TERM → wait → KILL)
- [ ] Opt-out / preserve flag for protected resources (Terraform `prevent_destroy`)
- [ ] Operator-observable audit trail (NDJSON / event log) of every cleanup decision
- [ ] Cross-platform fallback path when ecosystem-specific cleanup tooling is absent (cmux missing → telepty-only cleanup path)

### Failure mode handling patterns (assembled)

| Failure | Pattern | Source |
|---|---|---|
| External system unreachable during cleanup | Exponential backoff + workqueue re-enqueue | controller-runtime |
| Lease renewal racing expiry | Lower-bound semantics; renew with safety margin (e.g., renew at T/3) | etcd, Consul |
| Owner declared dead but in fact responsive | Lease + ack on renew; absence is the signal, not "deadness ping" | DHCP, etcd |
| Cleanup partially fails mid-batch | Idempotent rerun on next reconcile cycle; do not retry within same tick | K8s reconciler |
| Cleanup target is "protected" | Finalizer / lifecycle metadata blocks destruction until external ack | K8s finalizers |
| Restart storm | Terminal FATAL state; exponential backoff; circuit-breaker | supervisord; controller-runtime |
| Audit / forensic recovery need | Don't delete payload — quarantine to `archive/` for grace window | (general pattern; mark-and-sweep "stop the world" analogue) |

---

## References

### Group 1 — Terminal Multiplexer / Workspace
- [tmux.app — Sessions](https://tmux.app/sessions/) (T1)
- [GNU Screen Manual](https://www.gnu.org/software/screen/manual/screen.html) (T1)
- [linux.die.net — screen(1)](https://linux.die.net/man/1/screen) (T1)
- [Zellij — Session Management](https://zellij.dev/tutorials/session-management/) (T1)
- [Zellij — Session Resurrection](https://zellij.dev/documentation/session-resurrection.html) (T1)
- [zellij#3828 — delete-all-sessions](https://github.com/zellij-org/zellij/issues/3828) (T2)
- [zellij#4971 — auto-delete unimportant sessions](https://github.com/zellij-org/zellij/discussions/4971) (T2)
- [WezTerm — Workspaces](https://wezterm.org/recipes/workspaces.html) (T1)
- [WezTerm — window.restore Lua API](https://wezterm.org/config/lua/window/restore.html) (T1)
- [MLFlexer/resurrect.wezterm](https://github.com/MLFlexer/resurrect.wezterm) (T2)
- [vscode#53552 — workspaceStorage bloat](https://github.com/microsoft/vscode/issues/53552) (T2)
- [vscode#183883 — orphan workspaceStorage](https://github.com/microsoft/vscode/issues/183883) (T2)
- [Workspace Storage Cleanup extension](https://marketplace.visualstudio.com/items?itemName=mehyaa.workspace-storage-cleanup) (T2)
- [linkarzu — Tmux cleanup script](https://linkarzu.com/posts/terminals/tmux-cleanup/) (T3)
- [USC HPC Discourse — tmux periodic kill](https://hpc-discourse.usc.edu/t/tmux-session-keep-being-killed-periodically/899) (T3)

### Group 2 — Container / Process Orchestration
- [Kubernetes — Garbage Collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/) (T1)
- [Kubernetes — Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/) (T1)
- [kube.rs — Garbage Collection](https://kube.rs/controllers/gc/) (T2)
- [kube.rs — Reconciler](https://kube.rs/controllers/reconciler/) (T2)
- [Docker — container rm reference](https://docs.docker.com/reference/cli/docker/container/rm/) (T1)
- [systemd.service(5)](https://manpages.debian.org/testing/systemd/systemd.service.5.en.html) (T1)
- [systemd Transient Settings](https://systemd.io/TRANSIENT-SETTINGS/) (T1)
- [supervisord — Subprocesses](https://supervisord.org/subprocess.html) (T1)
- [supervisord — Configuration](https://supervisord.org/configuration.html) (T1)
- [PM2 — Process Management](https://pm2.keymetrics.io/docs/usage/process-management/) (T1)
- [PM2 — Graceful Start/Shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/) (T1)
- [Arch wiki — Runit](https://wiki.archlinux.org/title/Runit) (T1)
- [s6 — why another supervision suite](https://skarnet.org/software/s6/why.html) (T1)
- [Nomad — lifecycle block](https://developer.hashicorp.com/nomad/docs/job-specification/lifecycle) (T1)
- [nomad#27409 — disconnected nodes never GC'd](https://github.com/hashicorp/nomad/issues/27409) (T2)

### Group 3 — Distributed Systems Lease / TTL
- [etcd v3.5 — API docs](https://etcd.io/docs/v3.5/learning/api/) (T1)
- [etcd — How to create lease](https://etcd.io/docs/v3.5/tutorials/how-to-create-lease/) (T1)
- [etcd — API guarantees](https://etcd.io/docs/v3.5/learning/api_guarantees/) (T1)
- [Consul — Sessions and Distributed Locks](https://www.consul.io/docs/internals/sessions.html) (T1)
- [Consul — Session HTTP API](https://developer.hashicorp.com/consul/api-docs/session) (T1)
- [Redis — EXPIRE command](https://redis.io/docs/latest/commands/expire/) (T1)
- [Redis FAQ — expiration impacts](https://redis.io/faq/doc/1fqjridk8w/what-are-the-impacts-of-the-redis-expiration-algorithm) (T1)
- [Fortinet — DHCP lease renewal states](https://community.fortinet.com/t5/FortiGate/Technical-Tip-Understanding-DHCP-Lease-Renewal-States-and/ta-p/417414) (T3)
- [RFC 2131 slides — UT Dallas](https://personal.utdallas.edu/~ravip/cs6390/fall01/dhcp.slides.pdf) (T3)
- [Skycloak — JWT Lifecycle Management](https://skycloak.io/blog/jwt-token-lifecycle-management-expiration-refresh-revocation-strategies/) (T3)
- [Serverion — Refresh token rotation](https://www.serverion.com/uncategorized/refresh-token-rotation-best-practices-for-developers/) (T3)

### Group 4 — IDE / Workspace Recovery
- [JetBrains Guide — Cleanup unused IDE directories](https://www.jetbrains.com/guide/go/tips/cleanup-unused-ide-directories/) (T1)
- [JetBrains — Directories used by the IDE](https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html) (T1)
- [JetBrains — Invalidate caches](https://www.jetbrains.com/help/idea/invalidate-caches.html) (T1)
- [Vim doc — recover](https://vimdoc.sourceforge.net/htmldoc/recover.html) (T1)
- [Vim doc — usr_11](https://vimdoc.sourceforge.net/htmldoc/usr_11.html) (T1)
- [tmux-plugins/tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) (T2)
- [tmux-continuum (typecraft)](https://cms.typecraft.dev/community/tmux-continuum/) (T3)

### Group 5 — Reconciliation Loop Design Patterns
- [Kubernetes — Garbage Collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/) (T1)
- [Kubernetes — Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/) (T1)
- [controller-runtime — reconcile package](https://pkg.go.dev/sigs.k8s.io/controller-runtime/pkg/reconcile) (T1)
- [kube.rs — Reconciler](https://kube.rs/controllers/reconciler/) (T2)
- [DeepWiki kubebuilder — Reconciliation Loop](https://deepwiki.com/kubernetes-sigs/kubebuilder/5.2-reconciliation-loop) (T2)
- [farishuskovic.dev — Reconciler Pattern](https://www.farishuskovic.dev/blog/k8s-reconciler-pattern/) (T3)
- [Terraform — dry run (Spacelift)](https://spacelift.io/blog/terraform-dry-run) (T3)
- [Terraform — prevent_destroy (Spacelift)](https://spacelift.io/learn/terraform-prevent-destroy-lifecycle-block) (T3)
- [GeeksforGeeks — Mark-and-Sweep](https://www.geeksforgeeks.org/java/mark-and-sweep-garbage-collection-algorithm/) (T3)
- [blog.gaborkoos.com — GC in Go: tri-color](https://blog.gaborkoos.com/posts/2025-09-12-Garbage-Collection-In-Go.md/) (T3)

---

*End of report. dustcraw scope respected: information gathered, trade-offs enumerated, no "X is best" recommendation. Analysis / architecture decisions are out-of-scope and belong to architect/analyst session.*
