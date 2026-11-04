// 로비 규칙 (순수 함수): 팀 배정, 닉네임 정리
import { MAX_PER_TEAM, MAX_PLAYERS, NICKNAME_MAX_LENGTH, ROOM_CODE_PATTERN } from "./constants";
import type { Team } from "./protocol";

/** 방 코드 정규화(대문자) + 검증. 잘못되면 null */
export function normalizeRoomCode(raw: string | null): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

/** 팀별 인원 수 */
export function countTeams(players: { team: Team }[]): Record<Team, number> {
  const c: Record<Team, number> = { A: 0, B: 0 };
  for (const p of players) c[p.team]++;
  return c;
}

/** 새로 들어온 사람의 팀 자동 배정: 인원이 적은 팀, 같으면 A. 방이 가득 차면 null */
export function assignTeam(players: { team: Team }[]): Team | null {
  if (players.length >= MAX_PLAYERS) return null;
  const c = countTeams(players);
  if (c.A <= c.B && c.A < MAX_PER_TEAM) return "A";
  if (c.B < MAX_PER_TEAM) return "B";
  if (c.A < MAX_PER_TEAM) return "A";
  return null;
}

/** 해당 플레이어가 target 팀으로 옮길 수 있는지 */
export function canSwitchTeam(players: { id: string; team: Team }[], playerId: string, target: Team): boolean {
  const me = players.find((p) => p.id === playerId);
  if (!me) return false;
  if (me.team === target) return true; // 이미 그 팀이면 그대로 허용(변화 없음)
  return countTeams(players)[target] < MAX_PER_TEAM;
}

/** 닉네임 정리: 제어문자 제거, 공백 정리, 길이 제한. 비면 fallback */
export function sanitizeNickname(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(cleaned).slice(0, NICKNAME_MAX_LENGTH).join("");
  return chars.length > 0 ? chars : fallback;
}
