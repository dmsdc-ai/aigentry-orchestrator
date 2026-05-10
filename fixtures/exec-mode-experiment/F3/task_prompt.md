위 PR #842 diff에 대한 **블라인드 리뷰**를 작성해줘. 출력 포맷:

```
| ID | Severity | File:Line | Issue | Recommendation |
```

- Severity: `Critical` / `High` / `Medium`만 사용.
- File:Line은 diff에 붙은 라인 번호(1~13) 기준.
- 의도된 idiom(예: `== null`)은 이슈로 올리지 않는다.
- 테이블 뒤에 한 문단(≤120 words) verdict(merge 가능 여부 + 우선 수정 대상) 추가.
