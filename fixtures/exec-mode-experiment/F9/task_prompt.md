`fetchWithRetry`의 retry가 prod에서 작동하지 않는 **root cause**를 지목하고 **최소 패치(unified diff)**를 제시해줘. 출력은 3부로:

(a) **Root cause** — 1-2 문장으로 정확히 어떤 조건에서 어떤 코드 경로가 의도와 달라지는지.

(b) **Evidence** — 왜 다른 후보(Turn 4의 (a)/(b)/(c) 포함)가 아니라 이 원인인지 1-2 문장으로.

(c) **Fix** — unified diff 형식의 최소 수정(1 파일):
```diff
--- a/net/client.ts
+++ b/net/client.ts
@@ ... @@
```

Turn 4에서 나열한 후보 중 잘못된 것을 root cause로 지목하면 안 됨.
