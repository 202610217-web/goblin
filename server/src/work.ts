// 집 작업(부수기/수리) 진행률 계산 (순수 함수)
// 서버는 매 프레임 계산하지 않는다. "확정된 진행률 + 그 시각 + 누르고 있는 사람"만 저장하고
// 현재 진행률 = 확정 진행률 + 경과시간 × 속도 로 계산한다.
import { BREAK_TIME_MS, REPAIR_TIME_MS, WORK_CHECKPOINT, WORK_MULTI_SPEED } from "./constants";
import type { Phase, Team } from "./protocol";

export type WorkKind = "BREAK" | "REPAIR";

export interface WorkState {
  /** 지금 단계에서 할 수 있는 작업 (작업 없는 단계는 null) */
  kind: WorkKind | null;
  /** since 시각에 확정된 진행률 (0~1) */
  progress: number;
  /** progress가 확정된 서버 시각 (ms) */
  since: number;
  /** 버튼을 누르고 있는 플레이어 id */
  holders: string[];
}

/** 계산에 쓰는 규칙 값 (테스트에서 바꿔 넣을 수 있게) */
export interface WorkRules {
  breakMs: number;
  repairMs: number;
  checkpoint: number;
  multiSpeed: number;
}

export const DEFAULT_WORK_RULES: WorkRules = {
  breakMs: BREAK_TIME_MS,
  repairMs: REPAIR_TIME_MS,
  checkpoint: WORK_CHECKPOINT,
  multiSpeed: WORK_MULTI_SPEED,
};

/** 단계에 맞는 새 작업 상태 (ATTACK=부수기, REPAIR=수리, 그 외=없음). 진행률 0, 누르는 사람 없음 */
export function workForPhase(phase: Phase, now: number): WorkState {
  const kind: WorkKind | null = phase === "ATTACK" ? "BREAK" : phase === "REPAIR" ? "REPAIR" : null;
  return { kind, progress: 0, since: now, holders: [] };
}

/** 1ms당 진행률 */
export function workRate(w: WorkState, rules: WorkRules = DEFAULT_WORK_RULES): number {
  if (!w.kind || w.holders.length === 0) return 0;
  const base = 1 / (w.kind === "BREAK" ? rules.breakMs : rules.repairMs);
  return w.holders.length >= 2 ? base * rules.multiSpeed : base;
}

/** now 시각의 진행률 (0~1) */
export function progressAt(w: WorkState, now: number, rules: WorkRules = DEFAULT_WORK_RULES): number {
  return Math.min(1, w.progress + workRate(w, rules) * Math.max(0, now - w.since));
}

/** 현재 진행률을 확정 저장 */
function settle(w: WorkState, now: number, rules: WorkRules): WorkState {
  return { ...w, progress: progressAt(w, now, rules), since: now };
}

/** 버튼 누름: 진행률을 확정하고 누르는 사람에 추가 */
export function startHold(w: WorkState, playerId: string, now: number, rules: WorkRules = DEFAULT_WORK_RULES): WorkState {
  const s = settle(w, now, rules);
  if (!s.holders.includes(playerId)) s.holders = [...s.holders, playerId];
  return s;
}

/**
 * 버튼 뗌(또는 기절/접속 끊김 등으로 강제 중단): 누르는 사람에서 뺀다.
 * 아무도 안 누르게 되면 체크포인트 규칙 적용 (미만 → 0, 이상 → 체크포인트 값).
 */
export function stopHold(w: WorkState, playerId: string, now: number, rules: WorkRules = DEFAULT_WORK_RULES): WorkState {
  if (!w.holders.includes(playerId)) return w;
  const s = settle(w, now, rules);
  s.holders = s.holders.filter((id) => id !== playerId);
  if (s.holders.length === 0 && s.progress < 1) {
    s.progress = s.progress >= rules.checkpoint ? rules.checkpoint : 0;
  }
  return s;
}

/** 지금 속도로 계속 누르면 100%가 되는 시각. 아무도 안 누르면 null */
export function completionAt(w: WorkState, rules: WorkRules = DEFAULT_WORK_RULES): number | null {
  const r = workRate(w, rules);
  if (r === 0) return null;
  return w.since + Math.ceil((1 - w.progress) / r);
}

export function isComplete(w: WorkState, now: number, rules: WorkRules = DEFAULT_WORK_RULES): boolean {
  return w.kind !== null && progressAt(w, now, rules) >= 1 - 1e-9; // 소수 오차 허용
}

/** 작업 시작 거부 사유 (null이면 허용) */
export type HoldRejectReason = "wrong_phase" | "wrong_team" | "not_connected" | "too_far" | "already_holding";

export interface HoldCheck {
  phase: Phase;
  attackingTeam: Team;
  playerTeam: Team;
  connected: boolean;
  /** 해당 집 작업 가능 범위 안에 있는지 (isNearHouse 결과) */
  nearTarget: boolean;
  alreadyHolding: boolean;
}

/** 이 플레이어가 지금 hold_start 할 수 있는지 검증 */
export function checkHoldStart(c: HoldCheck): HoldRejectReason | null {
  if (c.phase !== "ATTACK" && c.phase !== "REPAIR") return "wrong_phase";
  const isAttacker = c.playerTeam === c.attackingTeam;
  // ATTACK = 공격팀만 부수기, REPAIR = 수비팀만 수리
  if (c.phase === "ATTACK" && !isAttacker) return "wrong_team";
  if (c.phase === "REPAIR" && isAttacker) return "wrong_team";
  if (!c.connected) return "not_connected";
  if (c.alreadyHolding) return "already_holding";
  if (!c.nearTarget) return "too_far";
  return null;
}

/** 작업 대상 집: 공격·수리 모두 수비팀 집 */
export function targetHouseTeam(attackingTeam: Team): Team {
  return attackingTeam === "A" ? "B" : "A";
}
