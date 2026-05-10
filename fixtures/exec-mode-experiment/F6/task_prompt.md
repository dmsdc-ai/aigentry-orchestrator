Turn 7의 에러를 고치는 **Fix 3** 패치를 unified diff 형식으로 출력해줘. 출력 요구사항:

```diff
--- a/aigentry_config/loader.py
+++ b/aigentry_config/loader.py
@@ ... @@
<before>
<after>
```

- 한 턴에 한 패치(fix 1건)만.
- 패치 뒤에 한 문장으로 예상되는 다음 에러 또는 green 상태를 예측.
- 가정된 fix만 제안하지 말고, Turn 7 에러에 정확히 대응하는 최소 diff.
- 패치 적용 후 다음 턴에 내가 다음 에러 또는 green을 공개하겠다.
