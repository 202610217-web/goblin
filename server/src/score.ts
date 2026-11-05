// 점수 규칙 (순수 함수): 라운드 승패 판정, 공수 교대, 매치포인트, 듀스, 경기 종료
// 승점을 누가 얻는지는 roundWinner 한 곳에서만 정한다 (규칙을 바꿀 때 여기만 고치면 된다).
import { DEUCE_LEAD, DEUCE_SWAP_EVERY_ROUND, ROUNDS_PER_TURN, WIN_SCORE } from "./constants";
import type { Team } from "./protocol";

/** 라운드가 끝난 이유 */
export type RoundEndReason =
  | "break_timeout" // 2분 안에 부수기 실패
  | "repair_success" // 1분 안에 수리 완료
  | "repair_fail" // 수리 시간 초과
  | "attackers_wiped" // ATTACK 중 공격팀 전멸
  | "defenders_wiped" // REPAIR 중 수비팀 전멸
  | "site_destroyed"; // NEON: A 또는 B 건물 파괴

export type Score = Record<Team, number>;

export interface RoundRecord {
  round: number;
  winner: Team;
  reason: RoundEndReason;
  attackingTeam: Team;
}

/** 공수 상태: 지금 공격팀, 이번 공격 차례에서 몇 라운드를 했는지 */
export interface Turn {
  attackingTeam: Team;
  roundsInTurn: number;
}

export const other = (t: Team): Team => (t === "A" ? "B" : "A");

/**
 * 라운드 승자 판정 (기본 규칙)
 * - 부수기 실패 / 수리 성공 / 공격팀 전멸 → 수비팀 +1
 * - 수리 실패 / 수비팀 전멸 → 공격팀 +1
 */
export function roundWinner(reason: RoundEndReason, attackingTeam: Team): Team {
  switch (reason) {
    case "break_timeout":
    case "repair_success":
    case "attackers_wiped":
      return other(attackingTeam);
    case "repair_fail":
    case "defenders_wiped":
    case "site_destroyed":
      return attackingTeam;
  }
}

export function addPoint(score: Score, winner: Team): Score {
  return { ...score, [winner]: score[winner] + 1 };
}

/** 듀스 상태인지: 둘 다 WIN_SCORE-1 이상 (5:5, 6:6, 6:5 ...) */
export function isDeuce(score: Score): boolean {
  return score.A >= WIN_SCORE - 1 && score.B >= WIN_SCORE - 1;
}

/**
 * 경기 승자 (없으면 null).
 * 먼저 WIN_SCORE 점이면 승리. 단 듀스가 되면 DEUCE_LEAD 점 차가 날 때까지 계속 (상한 없음).
 */
export function matchWinner(score: Score): Team | null {
  for (const t of ["A", "B"] as const) {
    const me = score[t], them = score[other(t)];
    if (me < WIN_SCORE) continue;
    const needLead = them >= WIN_SCORE - 1 ? DEUCE_LEAD : 1;
    if (me - them >= needLead) return t;
  }
  return null;
}

/** 다음 라운드를 이기면 경기에서 이기는 팀들 (매치포인트) */
export function matchPointTeams(score: Score): Team[] {
  if (matchWinner(score)) return [];
  return (["A", "B"] as const).filter((t) => matchWinner(addPoint(score, t)) === t);
}

/**
 * 라운드가 끝난 뒤 다음 라운드의 공수.
 * 보통은 ROUNDS_PER_TURN 라운드마다 교대, 듀스 중이면(플래그가 켜져 있으면) 매 라운드 교대.
 * scoreAfter = 방금 라운드 결과까지 반영한 점수
 */
export function nextTurn(turn: Turn, scoreAfter: Score, deuceSwap = DEUCE_SWAP_EVERY_ROUND): Turn {
  const played = turn.roundsInTurn + 1;
  if ((deuceSwap && isDeuce(scoreAfter)) || played >= ROUNDS_PER_TURN) {
    return { attackingTeam: other(turn.attackingTeam), roundsInTurn: 0 };
  }
  return { attackingTeam: turn.attackingTeam, roundsInTurn: played };
}
