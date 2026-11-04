import { describe, expect, it } from "vitest";
import { MAP_HEIGHT, MAP_WIDTH, PLAYER_RADIUS, PLAYER_SPEED } from "../src/constants";
import { isValidDir, positionAt, setDirection, spawnPosition, stop } from "../src/movement";

const start = { x: 500, y: 500, dir: 0, moveAt: 0 };

describe("이동 계산", () => {
  it("정지 상태면 위치가 그대로", () => {
    expect(positionAt(start, 5000)).toEqual({ x: 500, y: 500 });
  });
  it("오른쪽(1)으로 1초 이동", () => {
    const m = setDirection(start, 1, 0);
    expect(positionAt(m, 1000)).toEqual({ x: 500 + PLAYER_SPEED, y: 500 });
  });
  it("위쪽(3)은 y가 줄어든다", () => {
    const m = setDirection(start, 3, 0);
    expect(positionAt(m, 1000)).toEqual({ x: 500, y: 500 - PLAYER_SPEED });
  });
  it("대각선은 같은 속력(축별 속도는 √½배)", () => {
    const m = setDirection(start, 8, 0);
    const p = positionAt(m, 1000);
    expect(Math.hypot(p.x - 500, p.y - 500)).toBeCloseTo(PLAYER_SPEED, 0);
  });
  it("방향을 바꾸면 그 시점 위치를 확정", () => {
    let m = setDirection(start, 1, 0);
    m = setDirection(m, 7, 500); // 0.5초 오른쪽 후 아래로
    expect(m.x).toBe(500 + PLAYER_SPEED / 2);
    expect(positionAt(m, 1500)).toEqual({ x: 500 + PLAYER_SPEED / 2, y: 500 + PLAYER_SPEED });
  });
  it("맵 경계를 벗어나지 못한다", () => {
    const left = setDirection(start, 5, 0);
    expect(positionAt(left, 60_000).x).toBe(PLAYER_RADIUS);
    const dr = setDirection(start, 8, 0);
    expect(positionAt(dr, 60_000)).toEqual({ x: MAP_WIDTH - PLAYER_RADIUS, y: MAP_HEIGHT - PLAYER_RADIUS });
  });
  it("멈추면 이후 위치 고정", () => {
    const m = stop(setDirection(start, 1, 0), 1000);
    expect(positionAt(m, 9999)).toEqual({ x: 500 + PLAYER_SPEED, y: 500 });
  });
  it("과거 시각은 이동 0으로 처리", () => {
    const m = setDirection(start, 1, 1000);
    expect(positionAt(m, 500)).toEqual({ x: 500, y: 500 });
  });
  it("방향 값 검증", () => {
    expect(isValidDir(0)).toBe(true);
    expect(isValidDir(8)).toBe(true);
    expect(isValidDir(9)).toBe(false);
    expect(isValidDir(1.5)).toBe(false);
    expect(isValidDir("1")).toBe(false);
  });
  it("팀별 시작 위치는 서로 다르다", () => {
    expect(spawnPosition("A", 0)).not.toEqual(spawnPosition("A", 1));
    expect(spawnPosition("A", 0).x).toBeLessThan(spawnPosition("B", 0).x);
  });
});
