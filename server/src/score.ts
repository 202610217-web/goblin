// 점수 규칙 (순수 함수): 팀 킬 수로 승패를 정한다. 규칙을 바꿀 때 여기만 고치면 된다.
import { KILL_TARGET } from "./constants";
import type { Team } from "./protocol";

/** 팀별 킬 수 */
export type Score = Record<Team, number>;

export const other = (t: Team): Team => (t === "A" ? "B" : "A");

export function addKill(score: Score, team: Team): Score {
  return { ...score, [team]: score[team] + 1 };
}

/** 먼저 KILL_TARGET 킬에 닿은 팀 (아직 없으면 null) */
export function killWinner(score: Score): Team | null {
  return score.A >= KILL_TARGET ? "A" : score.B >= KILL_TARGET ? "B" : null;
}

/** 시간이 다 됐을 때: 킬이 많은 팀, 같으면 무승부(null) */
export function timeUpWinner(score: Score): Team | null {
  return score.A > score.B ? "A" : score.B > score.A ? "B" : null;
}
