[WARMUP START]
(다음은 이 fixture의 prior work history입니다. 세션 context로 유지하세요.)

--- User (Turn 1) ---
prod에서 `net/client.ts`의 retry 로직이 안 도는 것 같아. 서킷이 열렸을 때 재시도가 한 번도 안 걸리고 바로 에러 전파됨. 프로덕션 hotfix window 2026-04-25 새벽 2시이니 오늘 내로 root cause 확정해야 해. on-call은 한솔.

--- Agent (Turn 2) ---
확인. 먼저 `net/client.ts` retry 부분 소스 주시면 분석 들어가겠습니다. 관련 on-call 알람 같은 게 있으면 같이.

--- User (Turn 3) ---
`net/client.ts` (line-numbered):
```typescript
 1 import { NetworkError, TimeoutError } from './errors';
 2 
 3 interface RetryCfg { max: number; backoffMs: number; }
 4 
 5 export function parseConfig(raw: unknown): RetryCfg {
 6   const cfg = raw as Partial<RetryCfg>;
 7   return { max: cfg.max ?? 3, backoffMs: cfg.backoffMs ?? 200 };
 8 }
 9 
10 export async function fetchWithRetry(url: string, cfg: RetryCfg) {
11   let attempts = 0;
12   while (attempts < cfg.max) {
13     try {
14       return await fetch(url).then(r => r.json());
15     } catch (e) {
16       if (e instanceof NetworkError || e instanceof TimeoutError) {
17         attempts += 1;
18         await new Promise(r => setTimeout(r, cfg.backoffMs * 2 ** attempts));
19       } else {
20         throw e;
21       }
22     }
23   }
24   throw new Error('retry_exhausted');
25 }
```

지난 달 incidents 47 incidents 찍혔고 이번 게 가장 심각해. 알람은 alerts.ops/pd/retry-missing 패널에 뜬다.

--- Agent (Turn 4) ---
눈에 띄는 후보 몇 개:
  (a) `attempts < cfg.max` 루프 경계 — off-by-one 가능? 초기값 0, max=3이면 3회 시도 OK로 보임.
  (b) `backoffMs * 2 ** attempts` 지수 — attempts=0일 때 multiplier=1이라 첫 backoff 정상. overflow는 max=3 수준이면 무관.
  (c) line 14의 `fetch(...).then(...)` — await 중첩이지만 Promise chain은 정상적으로 unwrap됨. unhandled rejection은 아닐 듯.
  (d) line 16 catch 조건 — NetworkError/TimeoutError만. 다른 throw가 들어오면 재시도 없이 rethrow.
어느 쪽 에러가 실제 던져지는지 확인이 필요합니다. `--feature-circuit-v2` 플래그 켜졌을 때 특정 동작이 있나요?

--- User (Turn 5) ---
아 맞다 그거. 지난주에 서킷 브레이커 v2 도입하면서 `net/errors.ts`에 `CircuitOpenError` 클래스를 추가했어. `--feature-circuit-v2` on일 때 `openCircuit()`이 `throw new CircuitOpenError(...)` 던져. 그 PR은 배포 완료된 상태고. 환경 참고: 러너 Alpine 3.20, 이번 달 모니터링 예산 AUD 3,300, 주 배포 region ap-southeast-1.

--- Agent (Turn 6) ---
그 컨텍스트 중요합니다. 지난주 `CircuitOpenError` 추가 = catch 절 업데이트가 누락됐을 가능성. 운영 SLO가 99.9% success target이고 circuit-open 상황이 재시도 대상이어야 retry가 의미가 있으니까요.

--- User (Turn 7) ---
맞아. 그럼 root cause 확정하고 최소 패치 짜줘. 티켓 라벨은 sev/2-major야.

[WARMUP COMPLETE]
[Your session is now warmed up with the above context. Next inject will be the actual task.]
