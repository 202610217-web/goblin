import { describe, expect, it } from "vitest";
import { KILL_TARGET } from "../src/constants";
import { type Score, addKill, killWinner, timeUpWinner } from "../src/score";

const S = (A: number, B: number): Score => ({ A, B });

describe("데스매치 점수", () => {
  it("킬은 그 팀 점수에 1점", () => {
    expect(addKill(S(3, 4), "B")).toEqual(S(3, 5));
  });
  it("먼저 15킬이면 승리, 그 전에는 없음", () => {
    expect(KILL_TARGET).toBe(15);
    expect(killWinner(S(14, 14))).toBeNull();
    expect(killWinner(S(15, 9))).toBe("A");
    expect(killWinner(S(2, 15))).toBe("B");
  });
  it("시간 초과: 킬 많은 팀, 같으면 무승부", () => {
    expect(timeUpWinner(S(7, 5))).toBe("A");
    expect(timeUpWinner(S(1, 3))).toBe("B");
    expect(timeUpWinner(S(4, 4))).toBeNull();
  });
});
