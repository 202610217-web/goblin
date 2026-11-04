// 방 단계(페이즈) 상태 머신 (순수 함수)
// LOBBY → COUNTDOWN → ATTACK → (REPAIR) → ROUND_END → 다음 라운드 COUNTDOWN ... → MATCH_END
import { ATTACK_MS, COUNTDOWN_MS, FIRST_ATTACKING_TEAM, MAX_PER_TEAM, MAX_PLAYERS, REPAIR_MS, ROUND_END_MS } from "./constants";
import { countTeams } from "./lobby";
import type { ConnState, Phase, Team } from "./protocol";

export interface PhaseState {
  phase: Phase;
  /** 현재 라운드 번호 (LOBBY에서는 0) */
  round: number;
  attackingTeam: Team;
  /** 이 단계가 끝나는 서버 시각 (ms). 시간 제한 없는 단계는 null */
  phaseEndsAt: number | null;
}

/** 단계별 제한 시간. 없는 단계는 시간 제한 없음 */
const DURATION: Partial<Record<Phase, number>> = {
  COUNTDOWN: COUNTDOWN_MS,
  ATTACK: ATTACK_MS,
  REPAIR: REPAIR_MS,
  ROUND_END: ROUND_END_MS,
};

export function initialPhase(): PhaseState {
  return { phase: "LOBBY", round: 0, attackingTeam: FIRST_ATTACKING_TEAM, phaseEndsAt: null };
}

/** 해당 단계로 들어간다 (종료 시각 계산) */
export function enterPhase(s: PhaseState, phase: Phase, now: number): PhaseState {
  const d = DURATION[phase];
  return { ...s, phase, phaseEndsAt: d === undefined ? null : now + d };
}

/** 4명 모두 접속 + 준비 완료 + 2대2 이면 시작 가능 */
export function canStartMatch(players: { team: Team; conn: ConnState; ready: boolean }[]): boolean {
  if (players.length !== MAX_PLAYERS) return false;
  const c = countTeams(players);
  if (c.A !== MAX_PER_TEAM || c.B !== MAX_PER_TEAM) return false;
  return players.every((p) => p.conn === "CONNECTED" && p.ready);
}

/** 게임 시작: 1라운드 준비 단계 */
export function startMatch(now: number): PhaseState {
  return enterPhase({ ...initialPhase(), round: 1 }, "COUNTDOWN", now);
}

/**
 * 제한 시간이 끝났을 때 다음 단계.
 * - ATTACK 시간 초과 = 부수기 실패 → ROUND_END (승점은 5단계에서 처리)
 * - REPAIR 시간 초과 = 수리 실패 → ROUND_END
 * - ROUND_END → 다음 라운드 COUNTDOWN (공수 교대/매치 종료는 5단계에서 처리)
 */
export function nextOnTimeout(s: PhaseState, now: number): PhaseState {
  switch (s.phase) {
    case "COUNTDOWN":
      return enterPhase(s, "ATTACK", now);
    case "ATTACK":
    case "REPAIR":
      return enterPhase(s, "ROUND_END", now);
    case "ROUND_END":
      return enterPhase({ ...s, round: s.round + 1 }, "COUNTDOWN", now);
    default:
      return s;
  }
}

/**
 * 집 작업 완료 시 다음 단계.
 * - 부수기 완료 → REPAIR (수리 1분 시작)
 * - 수리 완료 → ROUND_END (수비팀 승점은 5단계 점수 판정 함수에서 처리)
 */
export function nextOnWorkComplete(s: PhaseState, kind: "BREAK" | "REPAIR", now: number): PhaseState {
  if (kind === "BREAK" && s.phase === "ATTACK") return enterPhase(s, "REPAIR", now);
  if (kind === "REPAIR" && s.phase === "REPAIR") return enterPhase(s, "ROUND_END", now);
  return s;
}

/** 디버그용 강제 단계 전환 */
export function forcePhase(s: PhaseState, phase: Phase, now: number): PhaseState {
  if (phase === "LOBBY") return initialPhase();
  return enterPhase({ ...s, round: Math.max(1, s.round) }, phase, now);
}

/** 이 단계에서 이동할 수 있는지 (준비 단계/라운드 종료에는 이동 불가) */
export function canMoveIn(phase: Phase): boolean {
  return phase === "ATTACK" || phase === "REPAIR";
}
