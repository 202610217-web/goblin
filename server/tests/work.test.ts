import { describe, expect, it } from "vitest";
import { BREAK_TIME_MS, REPAIR_TIME_MS, WORK_CHECKPOINT } from "../src/constants";
import { splitDue } from "../src/deadlines";
import { enterPhase, nextOnWorkComplete, startMatch } from "../src/phase";
import {
  DEFAULT_WORK_RULES,
  type HoldCheck,
  checkHoldStart,
  completionAt,
  isComplete,
  progressAt,
  startHold,
  stopHold,
  targetHouseTeam,
  workForPhase,
} from "../src/work";
import { HOUSES, HOUSE_WORK_DISTANCE, PHYS, distanceToHouse, isNearHouse } from "../../shared/world";

const breakWork = () => workForPhase("ATTACK", 0);

describe("진행률 계산: 0 → 100%", () => {
  it("혼자 계속 누르면 부수기 30초에 완료", () => {
    const w = startHold(breakWork(), "p1", 0);
    expect(progressAt(w, BREAK_TIME_MS / 2)).toBeCloseTo(0.5, 6);
    expect(isComplete(w, BREAK_TIME_MS - 1)).toBe(false);
    expect(isComplete(w, BREAK_TIME_MS)).toBe(true);
    expect(completionAt(w)).toBe(BREAK_TIME_MS);
    expect(progressAt(w, BREAK_TIME_MS * 2)).toBe(1); // 100%를 넘지 않음
  });
  it("수리는 20초", () => {
    const w = startHold(workForPhase("REPAIR", 1000), "d1", 1000);
    expect(completionAt(w)).toBe(1000 + REPAIR_TIME_MS);
  });
  it("아무도 안 누르면 진행 안 함, 완료 예정 없음", () => {
    expect(progressAt(breakWork(), 99_999)).toBe(0);
    expect(completionAt(breakWork())).toBeNull();
  });
});

describe("체크포인트 (버튼 뗌)", () => {
  const cp = WORK_CHECKPOINT;
  it("체크포인트 전에 떼면 0%로 초기화", () => {
    let w = startHold(breakWork(), "p1", 0);
    w = stopHold(w, "p1", BREAK_TIME_MS * (cp - 0.1));
    expect(w.progress).toBe(0);
    expect(w.holders).toEqual([]);
    expect(completionAt(w)).toBeNull();
  });
  it("체크포인트 이후에 떼면 체크포인트 값으로 되돌아감", () => {
    let w = startHold(breakWork(), "p1", 0);
    w = stopHold(w, "p1", BREAK_TIME_MS * 0.8);
    expect(w.progress).toBe(cp);
  });
  it("정확히 체크포인트에서 떼면 체크포인트 유지", () => {
    let w = startHold(breakWork(), "p1", 0);
    w = stopHold(w, "p1", BREAK_TIME_MS * cp);
    expect(w.progress).toBeCloseTo(cp, 9);
  });
  it("다시 누르면 체크포인트부터 이어서 진행", () => {
    let w = startHold(breakWork(), "p1", 0);
    w = stopHold(w, "p1", (BREAK_TIME_MS * 2) / 3); // 66% → 50%
    w = startHold(w, "p1", BREAK_TIME_MS);
    expect(completionAt(w)).toBeCloseTo(BREAK_TIME_MS + BREAK_TIME_MS * (1 - cp), 6);
  });
  it("누르고 있지 않은 사람이 떼면 아무 변화 없음", () => {
    const w = startHold(breakWork(), "p1", 0);
    expect(stopHold(w, "p2", 5000)).toBe(w);
  });
});

describe("두 명 동시 작업", () => {
  it("기본 배수 1.0: 두 명이어도 혼자와 같은 속도", () => {
    let w = startHold(breakWork(), "p1", 0);
    w = startHold(w, "p2", BREAK_TIME_MS / 4);
    expect(completionAt(w)).toBe(BREAK_TIME_MS);
  });
  it("배수 2.0이면 두 명일 때 두 배 빠름", () => {
    const rules = { ...DEFAULT_WORK_RULES, multiSpeed: 2 };
    let w = startHold(breakWork(), "p1", 0, rules);
    w = startHold(w, "p2", BREAK_TIME_MS / 2, rules); // 절반에서 둘째가 붙음, 남은 절반을 두 배 속도로
    expect(completionAt(w, rules)).toBeCloseTo((BREAK_TIME_MS * 3) / 4, 6);
  });
  it("한 명이 떼도 다른 한 명이 누르고 있으면 체크포인트 초기화 없이 계속 진행", () => {
    let w = startHold(breakWork(), "p1", 0);
    w = startHold(w, "p2", 0);
    w = stopHold(w, "p1", BREAK_TIME_MS / 5);
    expect(w.progress).toBeCloseTo(0.2, 9);
    expect(w.holders).toEqual(["p2"]);
    expect(completionAt(w)).toBe(BREAK_TIME_MS);
  });
  it("같은 사람이 두 번 눌러도 한 명으로 센다", () => {
    let w = startHold(breakWork(), "p1", 0);
    w = startHold(w, "p1", 1000);
    expect(w.holders).toEqual(["p1"]);
  });
});

describe("단계 종료 중 작업", () => {
  it("단계가 바뀌면 작업은 새 단계 작업(0%, 누르는 사람 없음)으로 초기화", () => {
    let w = startHold(breakWork(), "p1", 0);
    w = startHold(w, "p2", 0);
    expect(workForPhase("ROUND_END", 50_000)).toEqual({ kind: null, progress: 0, since: 50_000, holders: [] });
    expect(workForPhase("REPAIR", 1)).toMatchObject({ kind: "REPAIR", progress: 0, holders: [] });
  });
  it("작업 없는 단계에서는 누르고 있어도 진행 안 함", () => {
    const w = startHold(workForPhase("COUNTDOWN", 0), "p1", 0);
    expect(progressAt(w, 99_999)).toBe(0);
    expect(isComplete(w, 99_999)).toBe(false);
  });
  it("완료와 시간 초과가 같은 시각이면 완료를 먼저 처리", () => {
    const { due } = splitDue([
      { kind: "phase", key: "phase", at: 100 },
      { kind: "work", key: "work", at: 100 },
    ], 100);
    expect(due.map((d) => d.kind)).toEqual(["work", "phase"]);
  });
  it("부수기 완료 → REPAIR(60초), 수리 완료 → ROUND_END", () => {
    const atk = enterPhase(startMatch(0), "ATTACK", 0);
    const rep = nextOnWorkComplete(atk, "BREAK", 30_000);
    expect(rep.phase).toBe("REPAIR");
    expect(rep.phaseEndsAt).toBe(30_000 + 60_000);
    expect(nextOnWorkComplete(rep, "REPAIR", 50_000).phase).toBe("ROUND_END");
    // 단계가 안 맞으면 무시
    expect(nextOnWorkComplete(atk, "REPAIR", 1)).toBe(atk);
  });
});

describe("hold_start 검증", () => {
  const ok: HoldCheck = { phase: "ATTACK", attackingTeam: "A", playerTeam: "A", connected: true, normal: true, reviving: false, nearTarget: true, alreadyHolding: false };
  it("공격팀이 ATTACK 중 집 근처면 허용", () => expect(checkHoldStart(ok)).toBeNull());
  it("수비팀은 ATTACK 중 부수기 불가", () => expect(checkHoldStart({ ...ok, playerTeam: "B" })).toBe("wrong_team"));
  it("수비팀은 REPAIR 중 수리 가능, 공격팀은 불가", () => {
    expect(checkHoldStart({ ...ok, phase: "REPAIR", playerTeam: "B" })).toBeNull();
    expect(checkHoldStart({ ...ok, phase: "REPAIR", playerTeam: "A" })).toBe("wrong_team");
  });
  it("작업 단계가 아니면 거부", () => {
    for (const phase of ["LOBBY", "COUNTDOWN", "ROUND_END", "MATCH_END"] as const) {
      expect(checkHoldStart({ ...ok, phase })).toBe("wrong_phase");
    }
  });
  it("멀거나, 재접속 대기 중이거나, 이미 작업 중이면 거부", () => {
    expect(checkHoldStart({ ...ok, nearTarget: false })).toBe("too_far");
    expect(checkHoldStart({ ...ok, connected: false })).toBe("not_connected");
    expect(checkHoldStart({ ...ok, alreadyHolding: true })).toBe("already_holding");
  });
  it("기절/사망 상태나 치유 중에는 작업 불가", () => {
    expect(checkHoldStart({ ...ok, normal: false })).toBe("not_normal");
    expect(checkHoldStart({ ...ok, reviving: true })).toBe("busy");
  });
  it("대상 집은 수비팀 집", () => {
    expect(targetHouseTeam("A")).toBe("B");
    expect(targetHouseTeam("B")).toBe("A");
  });
});

describe("집 근처 판정 (3D)", () => {
  const h = HOUSES.B;
  const face = h.x - h.size / 2; // B팀 집 서쪽 벽면
  it("벽에 붙어 있으면 가능, 멀면 불가", () => {
    expect(isNearHouse("B", face - PHYS.PLAYER_HALF, h.y, 0)).toBe(true);
    expect(isNearHouse("B", face - PHYS.PLAYER_HALF - HOUSE_WORK_DISTANCE + 0.01, h.y, 0)).toBe(true);
    expect(isNearHouse("B", face - PHYS.PLAYER_HALF - HOUSE_WORK_DISTANCE - 0.1, h.y, 0)).toBe(false);
  });
  it("점프 중(발이 높음)이면 불가", () => {
    expect(isNearHouse("B", face - PHYS.PLAYER_HALF, h.y, 1.0)).toBe(false);
  });
  it("모서리는 대각선 거리로 계산", () => {
    expect(distanceToHouse("B", face - 3, h.y + h.size / 2 + 4)).toBeCloseTo(5, 6);
  });
});
