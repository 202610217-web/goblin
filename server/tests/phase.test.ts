import { describe, expect, it } from "vitest";
import { ATTACK_MS, CLASS_SELECT_MS, COUNTDOWN_MS, REPAIR_MS, ROUND_END_MS } from "../src/constants";
import { canMoveIn, canStartMatch, enterPhase, forcePhase, initialPhase, nextOnTimeout, startMatch } from "../src/phase";

const P = (team: "A" | "B", ready = true, conn: "CONNECTED" | "RECONNECTING" = "CONNECTED") => ({ team, ready, conn });

describe("게임 시작 조건", () => {
  it("4명 전원 준비 + 2대2면 시작", () => {
    expect(canStartMatch([P("A"), P("A"), P("B"), P("B")])).toBe(true);
  });
  it("한 명이라도 준비 안 됨/재접속 대기면 시작 불가", () => {
    expect(canStartMatch([P("A"), P("A"), P("B"), P("B", false)])).toBe(false);
    expect(canStartMatch([P("A"), P("A"), P("B"), P("B", true, "RECONNECTING")])).toBe(false);
  });
  it("4명 미만이면 시작 불가", () => {
    expect(canStartMatch([P("A"), P("B"), P("B")])).toBe(false);
  });
});

describe("단계 전환", () => {
  it("시작하면 1라운드 직업 선택 5초, 끝나면 COUNTDOWN 10초", () => {
    const s = startMatch(1000);
    expect(s).toMatchObject({ phase: "CLASS_SELECT", round: 1, attackingTeam: "A", phaseEndsAt: 1000 + CLASS_SELECT_MS });
    expect(CLASS_SELECT_MS).toBe(5000);
    expect(nextOnTimeout(s, 6000)).toMatchObject({ phase: "COUNTDOWN", round: 1, phaseEndsAt: 6000 + COUNTDOWN_MS });
  });
  it("COUNTDOWN → ATTACK → ROUND_END → 다음 라운드 COUNTDOWN", () => {
    let s = enterPhase(startMatch(0), "COUNTDOWN", 0);
    s = nextOnTimeout(s, s.phaseEndsAt!);
    expect(s.phase).toBe("ATTACK");
    expect(s.phaseEndsAt).toBe(COUNTDOWN_MS + ATTACK_MS);
    s = nextOnTimeout(s, s.phaseEndsAt!);
    expect(s.phase).toBe("ROUND_END");
    expect(s.phaseEndsAt).toBe(COUNTDOWN_MS + ATTACK_MS + ROUND_END_MS);
    s = nextOnTimeout(s, s.phaseEndsAt!);
    expect(s).toMatchObject({ phase: "COUNTDOWN", round: 2 });
  });
  it("REPAIR 시간 초과 → ROUND_END", () => {
    const s = enterPhase(startMatch(0), "REPAIR", 0);
    expect(s.phaseEndsAt).toBe(REPAIR_MS);
    expect(nextOnTimeout(s, REPAIR_MS).phase).toBe("ROUND_END");
  });
  it("LOBBY/MATCH_END는 시간 제한 없음", () => {
    expect(initialPhase().phaseEndsAt).toBeNull();
    expect(enterPhase(startMatch(0), "MATCH_END", 0).phaseEndsAt).toBeNull();
    expect(nextOnTimeout(initialPhase(), 99).phase).toBe("LOBBY");
  });
  it("강제 전환: LOBBY는 초기화, 그 외는 라운드 1 이상", () => {
    expect(forcePhase(initialPhase(), "ATTACK", 0)).toMatchObject({ phase: "ATTACK", round: 1 });
    expect(forcePhase(startMatch(0), "LOBBY", 0)).toEqual(initialPhase());
  });
  it("ATTACK/REPAIR에서만 이동 가능", () => {
    expect(canMoveIn("ATTACK")).toBe(true);
    expect(canMoveIn("REPAIR")).toBe(true);
    for (const p of ["LOBBY", "COUNTDOWN", "ROUND_END", "MATCH_END"] as const) expect(canMoveIn(p)).toBe(false);
  });
});
