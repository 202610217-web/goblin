// 방 단계(페이즈) 상태 머신 (순수 함수)
// LOBBY → CLASS_SELECT → COUNTDOWN → PLAY(10분, 15킬이면 바로 끝) → MATCH_END
import { CLASS_SELECT_MS, COUNTDOWN_MS, MATCH_MS, MAX_PER_TEAM, MAX_PLAYERS } from "./constants";
import { countTeams } from "./lobby";
import type { ConnState, MapId, Phase, Team } from "./protocol";

export interface PhaseState {
  phase: Phase;
  /** 이 단계가 끝나는 서버 시각 (ms). 시간 제한 없는 단계는 null */
  phaseEndsAt: number | null;
  /** 맵 (예전에 저장된 방에는 없음 → 기본 맵) */
  map?: MapId;
}

/** 단계별 제한 시간. 없는 단계는 시간 제한 없음 */
const DURATION: Partial<Record<Phase, number>> = {
  CLASS_SELECT: CLASS_SELECT_MS,
  COUNTDOWN: COUNTDOWN_MS,
  PLAY: MATCH_MS,
};

export function initialPhase(): PhaseState {
  return { phase: "LOBBY", phaseEndsAt: null };
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

/** 게임 시작: 직업 선택 단계 */
export function startMatch(s: PhaseState, now: number): PhaseState {
  return enterPhase(s, "CLASS_SELECT", now);
}

/** 제한 시간이 끝났을 때 다음 단계 (PLAY 시간 초과 = 경기 종료) */
export function nextOnTimeout(s: PhaseState, now: number): PhaseState {
  switch (s.phase) {
    case "CLASS_SELECT": return enterPhase(s, "COUNTDOWN", now);
    case "COUNTDOWN": return enterPhase(s, "PLAY", now);
    case "PLAY": return enterPhase(s, "MATCH_END", now);
    default: return s;
  }
}

/** 디버그용 강제 단계 전환 */
export function forcePhase(s: PhaseState, phase: Phase, now: number): PhaseState {
  return phase === "LOBBY" ? { ...initialPhase(), map: s.map } : enterPhase(s, phase, now);
}

/** 이 단계에서 움직일 수 있는지 */
export function canMoveIn(phase: Phase): boolean {
  return phase === "PLAY";
}
