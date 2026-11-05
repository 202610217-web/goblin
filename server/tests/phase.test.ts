import { describe, expect, it } from "vitest";
import { CLASS_SELECT_MS, COUNTDOWN_MS, MATCH_MS } from "../src/constants";
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
  it("로비 → 직업 선택 5초 → 준비 5초 → 경기 10분 → 끝", () => {
    let s = startMatch(initialPhase(), 1000);
    expect(s).toMatchObject({ phase: "CLASS_SELECT", phaseEndsAt: 1000 + CLASS_SELECT_MS });
    s = nextOnTimeout(s, 2000);
    expect(s).toMatchObject({ phase: "COUNTDOWN", phaseEndsAt: 2000 + COUNTDOWN_MS });
    s = nextOnTimeout(s, 3000);
    expect(s).toMatchObject({ phase: "PLAY", phaseEndsAt: 3000 + MATCH_MS });
    s = nextOnTimeout(s, 4000);
    expect(s).toMatchObject({ phase: "MATCH_END", phaseEndsAt: null });
    expect(nextOnTimeout(s, 5000)).toBe(s);
  });
  it("경기 중에만 움직일 수 있다", () => {
    expect(canMoveIn("PLAY")).toBe(true);
    for (const p of ["LOBBY", "CLASS_SELECT", "COUNTDOWN", "MATCH_END"] as const) expect(canMoveIn(p)).toBe(false);
  });
  it("디버그 강제 전환: 로비로 가도 맵은 그대로", () => {
    const s = enterPhase({ ...initialPhase(), map: "NEON" }, "PLAY", 0);
    expect(forcePhase(s, "LOBBY", 10)).toMatchObject({ phase: "LOBBY", map: "NEON" });
    expect(forcePhase(s, "COUNTDOWN", 10)).toMatchObject({ phase: "COUNTDOWN", phaseEndsAt: 10 + COUNTDOWN_MS });
  });
});
