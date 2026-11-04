import { describe, expect, it } from "vitest";
import { inputTime } from "../src/lag";
import { makeBody, simulate, withAngle } from "../../shared/sim";

describe("입력 시각 보정", () => {
  it("화면이 보낸 시각을 그대로 쓴다 (0.5초 안)", () => {
    expect(inputTime(9_800, 9_000, 10_000)).toBe(9_800);
  });
  it("미래 시각은 지금으로", () => {
    expect(inputTime(10_300, 9_000, 10_000)).toBe(10_000);
  });
  it("마지막 이동 기록보다 과거로는 못 간다", () => {
    expect(inputTime(9_600, 9_900, 10_000)).toBe(9_900);
  });
  it("0.5초보다 오래된 과거는 0.5초 전으로", () => {
    expect(inputTime(8_000, 0, 10_000)).toBe(9_500);
  });
  it("시각이 없거나 이상하면 지금", () => {
    expect(inputTime(undefined, 0, 10_000)).toBe(10_000);
    expect(inputTime(Number.NaN, 0, 10_000)).toBe(10_000);
  });
  it("화면과 서버가 같은 시각으로 계산하면 위치가 정확히 같다", () => {
    const start = makeBody(10, 2, 0);
    const pressedAt = 1_000; // 화면에서 누른 시각
    const client = simulate(withAngle(start, 0, pressedAt), 1_300); // 화면 예측
    const server = simulate(withAngle(start, 0, inputTime(pressedAt, start.t, 1_150)), 1_300); // 0.15초 늦게 도착
    expect(server.x).toBe(client.x);
    expect(server.y).toBe(client.y);
  });
});
