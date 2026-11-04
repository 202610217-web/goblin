// 이동 계산 (순수 함수)
// 서버는 "방향 + 방향이 바뀐 시각의 위치"만 저장하고, 현재 위치는 경과 시간으로 계산한다.
// 직선 이동이라 x, y를 각각 경계로 자르면 정확한 결과가 나온다.
import { MAP_HEIGHT, MAP_WIDTH, PLAYER_RADIUS, PLAYER_SPEED, SPAWNS } from "./constants";
import type { Team } from "./protocol";

const S = Math.SQRT1_2; // 대각선은 길이 1로 맞춤
/**
 * 8방향 + 정지. 화면 좌표(y는 아래로 증가) 기준.
 * 0=정지, 1=→, 2=↗, 3=↑, 4=↖, 5=←, 6=↙, 7=↓, 8=↘
 */
export const DIR_VECTORS: readonly (readonly [number, number])[] = [
  [0, 0], [1, 0], [S, -S], [0, -1], [-S, -S], [-1, 0], [-S, S], [0, 1], [S, S],
];

export interface MoveState {
  x: number;
  y: number;
  /** 0~8 */
  dir: number;
  /** x, y가 기록된 서버 시각 (ms) */
  moveAt: number;
}

export function isValidDir(d: unknown): d is number {
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 8;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** 맵 안으로 위치를 자른다 */
export function clampToMap(x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(x, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS),
    y: clamp(y, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS),
  };
}

/** now 시각의 위치 */
export function positionAt(m: MoveState, now: number, speed = PLAYER_SPEED): { x: number; y: number } {
  const v = DIR_VECTORS[m.dir] ?? [0, 0];
  const dt = Math.max(0, now - m.moveAt) / 1000;
  const p = clampToMap(m.x + v[0] * speed * dt, m.y + v[1] * speed * dt);
  return { x: round1(p.x), y: round1(p.y) };
}

/** 현재 위치를 확정하고 방향을 바꾼다 */
export function setDirection(m: MoveState, dir: number, now: number): MoveState {
  const p = positionAt(m, now);
  return { x: p.x, y: p.y, dir, moveAt: now };
}

/** 그 자리에 멈춘다 */
export function stop(m: MoveState, now: number): MoveState {
  return setDirection(m, 0, now);
}

/** 팀별 시작 위치 (index는 팀 안에서 몇 번째인지) */
export function spawnPosition(team: Team, index: number): { x: number; y: number } {
  const list = SPAWNS[team];
  const s = list[Math.min(index, list.length - 1)]!;
  return { x: s.x, y: s.y };
}
