위 3개 파일의 중복 validator를 제거하는 리팩토링을 수행해줘. 출력은 **전체 수정된 파일 4개**(기존 3개 + 새 공통 1개)를 각각 코드 블록으로:

```
### src/ingest/validators.ts  (신규)
...

### src/ingest/orders.ts  (수정)
...

### src/ingest/users.ts  (수정)
...

### src/ingest/webhooks.ts  (수정)
...
```

제약:
- 기존 9개 export name은 전부 유지 (public API 보존).
- 각 wrapper 함수의 public behavior(입력 → true/false) 동일 보존.
- **테스트 파일은 절대 편집 금지** — 출력에 포함하지 말 것. 편집 발견 시 점수 감점.
- 중복 본문이 완전히 제거돼야 함 (각 파일에서 email regex + phone regex 본문 사라져야 함).
- 리팩토링 후 기존 테스트 + hidden regression test 모두 통과해야 함.
