# V4 Cross-Mesh Team Comm — Phase 2 Sketch (2026-05-10)

> Phase 1 ADR (Q'''-bis core) 작성 시 reference. Phase 2 ADR 본격 작성 시 이 sketch를 출발점으로.

## Decisions (locked in V4 sketch grill)

### V4-1: Identity model
- **Tailscale handle**: `<user>@<machine>.<tailnet>.ts.net`
- 사용자 별칭 configurable (`telepty contact set-alias alice`)

### V4-2: Routing transport
- Q'''-bis 인프라 그대로 (Tailscale + SSH stream + relay + supervisor)
- 새 컴포넌트 0

### V4-3: Trust establishment
- Per-contact key 교환 (`telepty contact add` + `telepty contact accept`)
- ed25519 keypair, ~/.telepty/contacts/ 저장 (POSIX 0600)
- Mutual revocation (`telepty contact remove`)
- Manual rotation (`telepty contact rotate`)

### V4-4: Consent gate
- **외부 inject는 무조건 receiver (= relay) 경유**
- 직접 supervisor inject 금지 (사용자 명시 정책)
- relay 처리: contacts 검증 → inbox file 저장 → orchestrator notification

### V4-5/V4-11: Receiver
- **별도 AI 세션 X**. relay가 receiver 역할 (확장)
- relay 책임: SSH multiplex (기존) + contacts 검증 + inbox 저장 + notification

### V4-6: Notification format
- **단일 channel: orchestrator inject 1줄**
- Format: `[INBOX from <alias>] <≤50 char title>`
- Burst batching (turn-end debounced)
- Title = content 첫 50자 (word boundary 자름)
- File-based inbox 항상 source of truth (`~/.telepty/inbox/<msg-id>.json`)
- Configurable enable/disable, max chars

### V4-7: Inbox
- `~/.telepty/inbox/<msg-id>.json` 분리 디렉토리
- state/task-queue.json과 별개
- 사용자 명시 promote 시 task queue로

### V4-12: Reply mechanism
- 대칭 설계 — Bob → Alice도 inbox 경로
- thread tracking (`reply_to_msg_id` field)

### V4 도달성 정책 (M40)
- **Binary reachability**: Tailscale + SSH + relay running 확인
- 도달 불가 시 sender 즉시 reject ("currently unreachable")
- 자리비움 detection logic 0 (Phase 2). Phase 3+에 D3 (manual away toggle) 검토
- Network flap retry 1-2회 (~3s window)
- Mailbox / store-and-forward 컨셉 제거 (받는 사람 offline 시 큐잉 X)

## V4 mandates
- M37': Wire frame = NDJSON (V4 inject도 동일 frame)
- M40: Binary reachability + sender 즉시 reject + receiver presence detection 0

## Phase 진화 path
- **Phase 2** (V4 launch): 위 모든 항목
- **Phase 3+**:
  - D3 manual away toggle (`telepty status away`)
  - AI-mediated triage (receiver를 AI 세션으로 격상)
  - Multi-receiver per-context (work / personal)
  - aterm sidebar 통합 (별도 task)

## 관련 task
- #385 (예정): aterm sidebar inbox badge 통합 (Phase 4+ aterm 별도 backlog)
- Phase 2 ADR 작성: `docs/adr/<date>-v4-cross-mesh-team-comm.md`
