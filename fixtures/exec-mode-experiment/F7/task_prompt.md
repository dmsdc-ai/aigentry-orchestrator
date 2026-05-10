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
