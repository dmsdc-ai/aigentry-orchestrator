=== PRIOR CONVERSATION HISTORY ===
(다음은 이 task와 관련된 이전 대화 turn들입니다. 이 맥락을 참고하여 아래 task를 수행하세요.)

--- Turn 1 ---
User: `aigentry_config/loader.py` 빌드가 계속 실패해. fix-loop으로 한 턴에 한 에러씩 고쳐가자. 규칙:
  - 턴당 unified diff 1개만
  - fix 후 다음 turn에 다음 에러 공개
  - 빌드 커맨드: `uv run pytest aigentry_config/tests/test_loader.py -x`
  - 최대 10 턴 안에 green
릴리스 게이트 2026-05-10이라 시간 없어. 담당은 정유경.

--- Turn 2 ---
Agent: 확인. 10턴 fix-loop, 턴당 패치 1건. CI 대시보드는 ci.internal/builds/config-loader에 있겠네요. 먼저 초기 소스와 첫 에러 주세요.

--- Turn 3 ---
User: 초기 `loader.py`:
```python
 1 import toml
 2 from pathlib import Path
 3 
 4 def load_config(path str) -> dict:
 5     with open(path, 'rb') as f:
 6         raw = f.read().decode('utf8')
 7     return toml.loads(raw)
 8 
 9 def get_timeout(cfg: dict) -> int:
10     return cfg.get('timeout', default=30)
```

첫 에러 (pytest collect 단계):
```
aigentry_config/loader.py:4: SyntaxError: invalid syntax
    def load_config(path str) -> dict:
                         ^^^
```
총 테스트 3271 tests total 중 이 파일 커버리지 92.1%이고 나머지는 통과 중이야. 참고로 Fedora 41 러너에서 돌리고 월 tool spend GBP 4,500이야.

--- Turn 4 ---
Agent: Fix 1 — `path str` → `path: str` (타입 어노테이션 콜론 누락):
```diff
- def load_config(path str) -> dict:
+ def load_config(path: str) -> dict:
```
`--log-level=debug`로 log 정보 확인 권장.

--- Turn 5 ---
User: 적용하고 재빌드. 배포 region은 us-east-2. 다음 에러:
```
aigentry_config/loader.py:1: ModuleNotFoundError: No module named 'toml'
```
Python 3.13 기준 toml은 stdlib 아님. tomllib 써야 하는데 API가 달라 — 바이트 입력 받음.

--- Turn 6 ---
Agent: Fix 2 — `toml` import를 `tomllib`로 바꾸고 API 차이를 해결. tomllib는 바이트를 직접 받으므로 decode 단계 제거 가능:
```diff
- import toml
+ import tomllib
   ...
   with open(path, 'rb') as f:
-     raw = f.read().decode('utf8')
-   return toml.loads(raw)
+     return tomllib.load(f)
```

--- Turn 7 ---
User: 적용. 다음 에러는:
```
aigentry_config/loader.py:9: TypeError: dict.get() takes no keyword arguments
    return cfg.get('timeout', default=30)
```
티켓 라벨 area/config. 이것까지 고쳐줘 — 지금부터 네가 fix-loop 이어간다.

=== END OF PRIOR HISTORY ===

=== TASK ===
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
