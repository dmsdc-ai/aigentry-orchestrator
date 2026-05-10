=== PRIOR CONVERSATION HISTORY ===
(다음은 이 task와 관련된 이전 대화 turn들입니다. 이 맥락을 참고하여 아래 task를 수행하세요.)

--- Turn 1 ---
User: 플랫폼 팀에서 TypeScript 에러 처리 / null 처리 패턴을 새 코어 서비스들에 통일하려고 해. 2026-07-01 롤아웃 목표. 아키텍트는 임채영. 스코프 7 microservices.

--- Turn 2 ---
Agent: 확인했습니다. 초기 제안으로는 **D1**: 모든 실패 경로를 `Result<T, E>` 타입 alias로 통일 (Rust 스타일) — 에러/성공을 한 타입으로 합치고 체이닝 쉽게. 어떠세요?

--- Turn 3 ---
User: 아이디어는 좋은데 내부 리뷰에서 반대가 나왔어. `Result`는 성공/실패 구분이 실수로 뒤바뀔 수 있다는 우려. 어제 wiki.arch/patterns/err-handling에 대안 문서 올려놨어.

--- Turn 4 ---
Agent: 문서 내용 반영해서 **D2**: `Either<L, R>` 타입(fp-ts 스타일)으로 전환 제안. Left = 에러, Right = 성공으로 명시적 라벨링. `Result<T, E>` 안 씀. `Either`는 표현력과 typesafe flatMap chaining에 유리합니다. 이걸 D1 supersede.

--- Turn 5 ---
User: 오케이 Either 방향으로 가. 근데 nullable/optional 값은 Either 말고 더 가벼운 표현 쓰는 게 낫지 않아? 환경 참고로 러너 NixOS 24.05, 이번 분기 리팩토링 예산 KRW 1,200,000 (사람 시간 포함).

--- Turn 6 ---
Agent: 맞습니다. **D3**: nullable/optional 필드는 `Option<T>` 타입 alias (Some | None) — Either는 에러 전용, Option은 "값 없음" 전용. 역할 분리. D2는 에러 쪽에서만 계속 유효. D3는 D1/D2를 대체하는 게 아니라 영역을 분할.

--- Turn 7 ---
User: 좋다. 그러면 실제 async 호환성 테스트해봤어? Promise<Either<E, T>> 체이닝 어색하다는 제보 있어. --strict-null-checks 아래서. 배포 region은 af-south-1.

--- Turn 8 ---
Agent: 테스트 결과 **문제 확인**: `Promise<Either<E, T>>`는 TypeScript `Promise` 제네릭과 발견 variance 충돌하고, fp-ts `TaskEither`를 도입하려면 런타임 라이브러리 의존이 또 생깁니다. 따라서 **D4**: 에러는 `Result<T, E>` 타입 alias로 롤백(= D1 복귀) — async 친화적, lightweight. `Option<T>`는 D3 유지. 결과적으로 `Either`는 **사용 금지**, 기존 Either 코드는 migration 대상.

정리:
  - **nullable/optional** → `Option<T>` (D3)
  - **error / 실패 경로** → `Result<T, E>` (D4가 D2를 supersede하고 D1 방식으로 복귀)
  - **`Either<L, R>`는 신규 코드에서 사용 금지** (masked by D4)

--- Turn 9 ---
User: OK 그 방향으로 최종 가자. 타입 커버리지 100% type coverage 목표이고 관련 epic label epic/type-safety야.

--- Turn 10 ---
User: 그럼 첫 이주 대상 파일에 패턴 적용해줘. 타입 패턴 이름은 내가 굳이 안 말해도 네가 위 결정들 따라서 알아서 선택해야 해.

=== END OF PRIOR HISTORY ===

=== TASK ===
다음 신규 파일 `src/user-service.ts`에 현재 승인된 타입 패턴을 적용해줘. 요구사항:

**현 구현 (지금 리팩토링 들어갈 대상)**:
```typescript
// src/user-service.ts (current)
export async function findUserById(id: string): Promise<User | null> {
  const row = await db.queryOne('SELECT ... WHERE id = ?', id);
  if (!row) return null;
  return mapRow(row);
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await db.exec('DELETE FROM users WHERE id = ?', id);
  } catch (err) {
    throw new DbError('delete failed', { cause: err });
  }
}
```

출력:
(a) **리팩토링된 `src/user-service.ts`** (TypeScript 본문, 필요한 import 포함)
(b) **Decision trail citation** — "사용한 타입 패턴은 Turn N에서 결정된 Dk를 따른다" 형식으로 각 타입 선택마다 1줄. 타입 패턴 이름은 내가 말하지 않았으니 네가 근거만 답하면 돼.
(c) **Explicitly superseded pattern note** — 이번 파일에서 의도적으로 피한 타입 패턴(= supersede 된 것)과 그 supersede turn 번호.

추측 금지 — decision 번호와 turn 번호는 위 대화에 명시된 것만.
