import { describe, expect, it } from "vitest";
import { decide, planFor } from "../src/bots";
import { newCombat, applyHit } from "../src/combat";
import { makeBody, radToAngle, simulate, withAngle } from "../../shared/sim";
import { PHYS, SPAWNS, isNearHouse } from "../../shared/world";

/** 계획대로 걸어가 본다 (지점마다 방향을 다시 잡음) */
function walk(team: "A" | "B", slot: number, phase: "ATTACK" | "REPAIR", attacking: "A" | "B") {
  const plan = planFor(team, phase, attacking, slot);
  const sp = SPAWNS[team][slot]!;
  let b = makeBody(sp.x, sp.y, 0);
  let t = 0;
  for (const wp of plan.waypoints) {
    const d = Math.hypot(wp.x - b.x, wp.y - b.y);
    b = withAngle(b, radToAngle(Math.atan2(wp.y - b.y, wp.x - b.x)), t);
    t += (d / PHYS.SPEED) * 1000;
    b = simulate(b, t);
  }
  return { b, plan };
}

describe("더미 길 찾기 (벽/단상에 막히지 않는지)", () => {
  for (const team of ["A", "B"] as const) {
    for (const slot of [0, 1]) {
      it(`${team}팀 공격 더미 ${slot}번 → 상대 집 앞 작업 거리 도착`, () => {
        const { b, plan } = walk(team, slot, "ATTACK", team);
        const last = plan.waypoints.at(-1)!;
        expect(Math.hypot(b.x - last.x, b.y - last.y)).toBeLessThan(0.5);
        expect(isNearHouse(team === "A" ? "B" : "A", b.x, b.y, b.z)).toBe(true);
        expect(plan.hold).toBe(true);
      });
      it(`${team}팀 수비 더미 ${slot}번 → 자기 집 앞(수리 가능 거리)`, () => {
        const attacking = team === "A" ? "B" : "A";
        const { b, plan } = walk(team, slot, "REPAIR", attacking);
        expect(isNearHouse(team, b.x, b.y, b.z)).toBe(true);
        expect(plan.hold).toBe(true);
      });
    }
  }
  it("수비 더미는 공격 단계에서는 지키기만 (작업 안 함)", () => {
    expect(planFor("B", "ATTACK", "A", 0).hold).toBe(false);
  });
});

describe("더미 행동 결정", () => {
  const ctx = { phase: "ATTACK" as const, attackingTeam: "A" as const, holding: false, canAttack: true };
  const me = (x: number, y: number, team: "A" | "B" = "B") => ({ id: "bot", team, body: makeBody(x, y, 0), c: newCombat() });
  it("사거리 안 상대가 있으면 때린다", () => {
    const d = decide(me(10, 2), planFor("B", "ATTACK", "A", 0), [{ ...me(11.5, 2, "A"), id: "h" }], ctx);
    expect(d.attack).toBeDefined();
    expect(d.angle).toBe(-1);
  });
  it("쿨다운 중이면 때리지 않는다", () => {
    const d = decide(me(10, 2), planFor("B", "ATTACK", "A", 0), [{ ...me(11.5, 2, "A"), id: "h" }], { ...ctx, canAttack: false });
    expect(d.attack).toBeUndefined();
  });
  it("수비 더미는 6m 안 상대를 쫓아간다", () => {
    const d = decide(me(10, 2), planFor("B", "ATTACK", "A", 0), [{ ...me(15, 2, "A"), id: "h" }], ctx);
    expect(d.attack).toBeUndefined();
    expect(d.angle).toBe(0); // 동쪽
    expect(d.enemyNear).toBe(true);
  });
  it("기절한 상대는 무시하고 계획대로 간다", () => {
    const downed = { ...me(11, 2, "A"), id: "h", c: applyHit({ ...newCombat(), hp: 25 }, 0) };
    const d = decide(me(10, 2), planFor("B", "ATTACK", "A", 0), [downed], ctx);
    expect(d.attack).toBeUndefined();
    expect(d.enemyNear).toBe(false);
  });
  it("기절한 더미는 아무것도 안 한다", () => {
    const bot = { ...me(10, 2), c: applyHit({ ...newCombat(), hp: 25 }, 0) };
    expect(decide(bot, planFor("B", "ATTACK", "A", 0), [], ctx)).toEqual({ angle: -1, enemyNear: false });
  });
  it("공격 더미는 마지막 지점(집 앞)에 도착하면 부수기 시작", () => {
    const plan = planFor("A", "ATTACK", "A", 0);
    plan.idx = plan.waypoints.length - 1;
    const last = plan.waypoints[plan.idx]!;
    const d = decide({ ...me(last.x, last.y, "A") }, plan, [], ctx);
    expect(d.holdStart).toBe(true);
  });
  it("벽 너머 상대는 때리지 않는다", () => {
    // 엄폐벽(x 21.5~26.5, y 3.6~4.4) 남쪽과 북쪽
    const d = decide(me(24, 3.0), planFor("B", "ATTACK", "A", 0), [{ ...me(24, 4.95, "A"), id: "h" }], ctx);
    expect(d.attack).toBeUndefined();
  });
});

describe("더미 우선순위", () => {
  const ctx = { phase: "ATTACK" as const, attackingTeam: "A" as const, holding: false, canAttack: true };
  it("공격 더미는 집 앞에 도착하면 옆에 적이 있어도 부수기부터", () => {
    const plan = planFor("A", "ATTACK", "A", 0);
    plan.idx = plan.waypoints.length - 1;
    const last = plan.waypoints[plan.idx]!;
    const bot = { id: "b", team: "A" as const, body: makeBody(last.x, last.y, 0), c: newCombat() };
    const guard = { id: "g", team: "B" as const, body: makeBody(last.x - 1, last.y, 0), c: newCombat() };
    expect(decide(bot, plan, [guard], ctx).holdStart).toBe(true);
  });
  it("작업하러 가는 공격 더미는 3m 앞 적을 쫓지 않고 길을 따라간다", () => {
    const plan = planFor("A", "ATTACK", "A", 0);
    const bot = { id: "b", team: "A" as const, body: makeBody(11, 11, 0), c: newCombat() };
    const e = { id: "e", team: "B" as const, body: makeBody(11, 13.5, 0), c: newCombat() };
    const d = decide(bot, plan, [e], ctx);
    expect(d.attack).toBeUndefined();
    expect(d.angle).toBe(radToAngle(Math.atan2(plan.waypoints[0]!.y - 11, plan.waypoints[0]!.x - 11)));
  });
});

describe("작업하러 가는 더미", () => {
  it("길 가다 사거리 안에 적이 있어도 싸우지 않고 계속 간다", () => {
    const ctx = { phase: "ATTACK" as const, attackingTeam: "A" as const, holding: false, canAttack: true };
    const plan = planFor("A", "ATTACK", "A", 0);
    const bot = { id: "b", team: "A" as const, body: makeBody(11, 11, 0), c: newCombat() };
    const e = { id: "e", team: "B" as const, body: makeBody(11, 10, 0), c: newCombat() };
    const d = decide(bot, plan, [e], ctx);
    expect(d.attack).toBeUndefined();
    expect(d.angle).not.toBe(-1);
  });
});
