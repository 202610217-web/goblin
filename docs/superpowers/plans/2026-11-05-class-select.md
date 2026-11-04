# 직업 선택 (기사 / 궁수) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 방장이 시작을 누르면 5초간 기사/궁수를 고르고, 궁수는 서버가 비행 판정하는 화살(30m/s)을 쏜다.

**Architecture:** 직업 수치와 화살 판정은 서버·화면이 같이 쓰는 순수 함수로 `shared/`에 둔다. 서버 방(room.ts)은 새 단계 CLASS_SELECT, 방장, 화살 타이머를 추가하고, 화면(main.ts, world3d.ts)은 선택 카드·화살·무기 모양을 그린다. 호스트 기기 방은 같은 room.ts를 돌리므로 따로 고치지 않는다.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Three.js, vitest

**Spec:** `docs/superpowers/specs/2026-11-05-class-select-design.md`

## Global Constraints
- 직업 id: `"KNIGHT" | "ARCHER"`. 기본값 `"KNIGHT"`.
- 기사: 체력 150, 데미지 25, 사거리 2m(기존 근접 판정), 쿨다운 1000ms
- 궁수: 체력 70, 데미지 25, 사거리 12m, 쿨다운 1400ms
- 화살: 30m/s 직선, 최대 12m, 50ms 간격으로 구간 판정, 처음 닿은 적 1명 또는 벽(BOXES)에서 멈춤
- CLASS_SELECT 5000ms, 경기 시작 때 한 번만
- 치유 후 체력 = 그 직업 최대 체력 × REVIVE_HP_RATIO(0.3)
- 화살은 storage에 저장하지 않는다 (무료 플랜 쓴 행 수 보호)
- 기존 메시지 레이트 리밋(초당 10개) 유지

## Review Focus
- 화살 비행 중 쏜 사람이 기절/퇴장: 이미 쏜 화살은 그대로 판정 (쏜 순간 결정)
- 화살 비행 중 라운드가 끝남(ROUND_END로 전환): 남은 화살은 버린다 → arrow 테스트 `stops when phase is not combat`
- CLASS_SELECT 중 누군가 나감 / 재접속: 단계는 그대로 진행, 재접속한 사람도 고를 수 있음
- 방장이 나감: 다음으로 먼저 들어온 연결된 사람이 방장 → lobby 테스트 `owner passes to next`
- 옛 화면(직업을 모름)이 set_class 없이 들어옴: 기사로 처리

---

### Task 1: 직업 수치 + 전투 규칙에 반영

**Files:**
- Create: `shared/classes.ts`
- Modify: `server/src/combat.ts` (newCombat, checkAttack, completeRevive), `server/src/constants.ts` (CLASS_SELECT_MS, ARROW 수치 재수출)
- Test: `server/tests/combat.test.ts`

**Interfaces:**
- Produces: `type ClassId = "KNIGHT" | "ARCHER"`, `CLASSES: Record<ClassId, { maxHp: number; cooldownMs: number; range: number; ranged: boolean }>`, `ARROW = { SPEED: 30, MAX_RANGE: 12, STEP_MS: 50 }`, `isClassId(x: unknown): x is ClassId`
- `newCombat(cls: ClassId = "KNIGHT")`, `resetForRound(c, cls)`, `checkAttack(c, phase, busy, now, cls)`, `completeRevive(target, now, cls)`

- [ ] 테스트: `newCombat("ARCHER").hp === 70`, `newCombat("KNIGHT").hp === 150`, 궁수는 1200ms 뒤 `checkAttack`이 `"cooldown"`, 1400ms 뒤 `null`, 궁수 부활 체력 21
- [ ] 실패 확인: `cd server && npx vitest run tests/combat.test.ts`
- [ ] 구현 (기존 호출부는 기본값 KNIGHT로 계속 동작)
- [ ] 전체 테스트 통과: `npx vitest run && npx tsc --noEmit`
- [ ] 커밋

### Task 2: 방장, CLASS_SELECT 단계, 메시지

**Files:**
- Modify: `server/src/protocol.ts` (Phase에 `"CLASS_SELECT"`, `start_game`, `set_class`, PublicPlayer `cls`/`owner`), `server/src/phase.ts` (DURATION, nextOnTimeout CLASS_SELECT→COUNTDOWN, `startMatch`가 CLASS_SELECT로), `server/src/lobby.ts` (`ownerId(players)`), `server/src/room.ts`
- Test: `server/tests/phase.test.ts`, `server/tests/lobby.test.ts`, `server/tests/hostroom.test.ts`

**Interfaces:**
- Consumes: Task 1 `ClassId`, `newCombat(cls)`
- Produces: `PlayerRecord.cls: ClassId`, `ownerId(players: {id: string; bot?: boolean; conn: ConnState}[]): string | null` (연결된 사람 중 목록 순서 첫 번째, 더미 제외)
- 규칙: 자동 시작(`tryStartMatch`) 제거. `start_game`은 방장만, `canStartMatch` 참일 때만. `start_practice`도 방장만. CLASS_SELECT 끝(타임아웃) → 각자 `p.c = newCombat(p.cls)` 후 COUNTDOWN. 더미는 시작 때 무작위 직업.

- [ ] 테스트: phase `startMatch`가 CLASS_SELECT(5000ms) → 타임아웃 시 COUNTDOWN round 1, lobby `ownerId` 첫 사람/더미 제외/연결 끊긴 사람 건너뜀(owner passes to next), hostroom: 방장 아닌 사람 start_game → error, 방장 start_game → CLASS_SELECT, set_class ARCHER 후 COUNTDOWN에서 hp 70, set_class 없으면 KNIGHT
- [ ] 실패 확인
- [ ] 구현
- [ ] 전체 테스트 + 타입 검사 통과 (기존 테스트 중 "4명 준비 시 자동 시작" 기대는 start_game 호출로 고침)
- [ ] 커밋

### Task 3: 화살 비행 판정

**Files:**
- Create: `shared/arrow.ts`
- Modify: `server/src/room.ts` (attack 처리: 궁수면 화살 생성 + `shot` 방송 + 50ms 타이머), `server/src/protocol.ts` (`{ t: "shot"; by: string; origin: Vec3; dir: Vec3; at: number }`)
- Test: `server/tests/arrow.test.ts`

**Interfaces:**
- Produces: `makeArrow(shooter: Body, yaw: number, pitch: number, at: number): { origin: Vec3; dir: Vec3; at: number }` — 출발점은 몸 가슴 높이(z+1.2), 방향은 조준 광선이 12m 안에서 처음 닿는 벽 지점(없으면 12m 지점)을 향함
- `arrowSegmentHit<T extends {id: string; body: Body}>(arrow, fromT: number, toT: number, candidates: T[]): { hit: T | null; stopped: boolean }` — 구간 [fromT,toT]의 화살 선분을 각 후보 몸 상자(PLAYER_HALF, PLAYER_HEIGHT)와 벽에 대해 검사, 먼저 닿는 것. 거리 12m 넘으면 stopped
- 후보 몸은 `simulate(p.body, toT)`로 그 시각 위치

- [ ] 테스트: 정지한 적 10m 앞 명중(도착 ~333ms), 6m/s로 옆으로 걷는 적 10m 거리 정면 조준 빗나감, 2m 앞을 조준(리드샷) 명중, 비행 중 방향 바꾼 적 빗나감, 벽 뒤 적은 벽에서 멈춤, 12m 밖은 stopped
- [ ] 실패 확인
- [ ] 구현 (room: 타이머마다 `isCombatPhase`가 아니면 화살 버림, 맞으면 기존 resolveHit/onDowned/방송 재사용)
- [ ] 전체 테스트 통과
- [ ] 커밋

### Task 4: 더미 직업

**Files:**
- Modify: `server/src/bots.ts`, `server/src/room.ts`
- Test: `server/tests/bots.test.ts`

**Interfaces:**
- Consumes: Task 1 `CLASSES`, Task 3 화살 경로
- 궁수 더미: 사거리 10m 안 적이 보이면 그 자리에서 쏜다 (리드 없이 현재 위치 조준), 쿨다운은 max(BOT_ATTACK_COOLDOWN_MS, 직업 쿨다운)

- [ ] 테스트: 궁수 더미가 8m 거리 적에게 attack 결정, 기사 더미는 8m에서 결정 안 함
- [ ] 구현 + 통과 + 커밋

### Task 5: 화면

**Files:**
- Modify: `client/index.html` (로비 "게임 시작" 버튼, 직업 선택 오버레이), `client/src/style.css`, `client/src/main.ts`, `client/src/world3d.ts`

**Interfaces:**
- Consumes: protocol `cls`, `owner`, `shot`, `CLASSES`, `ARROW`
- 로비: 방장에게만 "게임 시작"(조건 미충족이면 비활성 + 이유), "연습 시작"도 방장만
- CLASS_SELECT: 카드 2장(⚔️ 기사 — 검과 방패, 체력 150 / 🏹 궁수 — 활, 체력 70·멀리 쏘기), 남은 초, 내 선택 강조, 팀원 선택 표시
- 체력바·쿨다운은 `CLASSES[p.cls]` 기준
- world3d: 캐릭터 손에 검(납작한 막대) 또는 활(호 모양 막대), `shot` 받으면 화살 막대를 서버 시각 기준으로 이동, 1초 또는 12m 후 제거
- PHASE_NAME에 CLASS_SELECT: "직업 선택"

- [ ] `cd client && npx tsc --noEmit && npx vite build` 통과
- [ ] 로컬에서 서버(`npm run dev`) + 화면 띄워 더미와 연습: 선택 카드 → 궁수로 화살이 보이고 맞음 확인
- [ ] 커밋 후 master 푸시 → 자동 배포 성공 확인
