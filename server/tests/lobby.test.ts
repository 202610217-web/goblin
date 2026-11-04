import { describe, expect, it } from "vitest";
import { assignTeam, canSwitchTeam, normalizeRoomCode, sanitizeNickname } from "../src/lobby";

describe("방 코드", () => {
  it("대문자로 바꾸고 4~6자리 영문/숫자만 허용", () => {
    expect(normalizeRoomCode("abcd")).toBe("ABCD");
    expect(normalizeRoomCode("a1b2c3")).toBe("A1B2C3");
    expect(normalizeRoomCode("abc")).toBeNull();
    expect(normalizeRoomCode("abcdefg")).toBeNull();
    expect(normalizeRoomCode("ab-d")).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
  });
});

describe("팀 자동 배정", () => {
  it("적은 팀으로, 같으면 A", () => {
    expect(assignTeam([])).toBe("A");
    expect(assignTeam([{ team: "A" }])).toBe("B");
    expect(assignTeam([{ team: "A" }, { team: "B" }])).toBe("A");
    expect(assignTeam([{ team: "B" }, { team: "B" }])).toBe("A");
  });
  it("4명이면 가득 참", () => {
    expect(assignTeam([{ team: "A" }, { team: "A" }, { team: "B" }, { team: "B" }])).toBeNull();
  });
});

describe("팀 변경", () => {
  const ps = [
    { id: "1", team: "A" as const },
    { id: "2", team: "A" as const },
    { id: "3", team: "B" as const },
  ];
  it("팀당 2명 초과 불가", () => expect(canSwitchTeam(ps, "3", "A")).toBe(false));
  it("상대 팀에 자리가 있으면 가능", () => expect(canSwitchTeam(ps, "1", "B")).toBe(true));
  it("없는 플레이어는 불가", () => expect(canSwitchTeam(ps, "9", "B")).toBe(false));
});

describe("닉네임 정리", () => {
  it("공백/제어문자 제거, 12자 제한, 비면 기본값", () => {
    expect(sanitizeNickname("  철수  ", "P")).toBe("철수");
    expect(sanitizeNickname("a\u0000b\nc", "P")).toBe("abc");
    expect(sanitizeNickname("가".repeat(20), "P")).toBe("가".repeat(12));
    expect(sanitizeNickname("   ", "기본")).toBe("기본");
  });
});
