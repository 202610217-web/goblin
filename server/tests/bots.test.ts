import { describe, expect, it } from "vitest";
import { CLASSES } from "../../shared/classes";
import { decide, planFor } from "../src/bots";
import { newCombat, applyHit } from "../src/combat";
import { makeBody, radToAngle, simulate, withAngle } from "../../shared/sim";
import { PHYS, SPAWNS } from "../../shared/world";
import { NEON_SPAWNS } from "../../shared/neon";

/** 지점마다 방향을 다시 잡으며 걷기 (서버 더미처럼). 벽에 막히면 지점에 못 닿는다 */
function walkPlan(start: { x: number; y: number }, waypoints: { x: number; y: number }[]) {
  let b = makeBody(start.x, start.y, 0);
  let t = 0;
  for (const wp of waypoints) {
    for (let k = 0; k < 40 && Math.hypot(wp.x - b.x, wp.y - b.y) > 0.3; k++) {
      b = withAngle(b, radToAngle(Math.atan2(wp.y - b.y, wp.x - b.x)), t);
      t += Math.min(400, (Math.hypot(wp.x - b.x, wp.y - b.y) / PHYS.SPEED) * 1000);
      b = simulate(b, t);
    }
  }
  return b;
}
const near = (b: { x: number; y: number }, p: { x: number; y: number }) => Math.hypot(b.x - p.x, b.y - p.y) < 0.5;

describe("더미 순찰 길 (벽/단상에 막히지 않는지)", () => {
  for (const map of ["CLASSIC", "NEON"] as const) {
    for (const team of ["A", "B"] as const) {
      for (const slot of [0, 1]) {
        it(`${map} ${team}팀 더미 ${slot}번: 상대 진영까지 갔다가 가운데로 돌아온다`, () => {
          const start = (map === "NEON" ? NEON_SPAWNS : SPAWNS)[team][slot]!;
          const go = planFor(team, slot, map, start);
          expect(go.waypoints.length).toBeGreaterThan(0);
          const there = walkPlan(start, go.waypoints);
          expect(near(there, go.waypoints.at(-1)!)).toBe(true);
          const back = planFor(team, slot, map, there, true);
          expect(near(walkPlan(there, back.waypoints), back.waypoints.at(-1)!)).toBe(true);
        });
      }
    }
  }
});

describe("더미 행동 결정", () => {
  const ctx = { canAttack: true, proj: null };
  const me = (x: number, y: number, team: "A" | "B" = "B") => ({ id: "bot", team, body: makeBody(x, y, 0), c: newCombat() });
  const plan = () => planFor("B", 0, "CLASSIC", { x: 10, y: 2 });
  it("손 닿는 상대가 있으면 때린다", () => {
    const d = decide(me(10, 2), plan(), [{ ...me(11.5, 2, "A"), id: "h" }], ctx);
    expect(d.attack).toBeDefined();
    expect(d.angle).toBe(-1);
  });
  it("궁수 더미는 8m 거리 적을 쏘고, 근접 더미는 쏘지 않는다", () => {
    const foe = [{ ...me(18, 2, "A"), id: "h" }]; // y=2 줄 x 10~22는 빈 곳
    expect(decide(me(10, 2), plan(), foe, { ...ctx, proj: CLASSES.ARCHER.proj! }).attack).toBeDefined();
    expect(decide(me(10, 2), plan(), foe, ctx).attack).toBeUndefined();
  });
  it("궁수 더미는 벽 뒤 적은 쏘지 않는다", () => {
    // x=17 벽(y 12~16) 뒤
    const d = decide(me(12, 14), plan(), [{ ...me(20, 14, "A"), id: "h" }], { ...ctx, proj: CLASSES.ARCHER.proj! });
    expect(d.attack).toBeUndefined();
  });
  it("쿨다운 중이면 때리지 않는다", () => {
    const d = decide(me(10, 2), plan(), [{ ...me(11.5, 2, "A"), id: "h" }], { ...ctx, canAttack: false });
    expect(d.attack).toBeUndefined();
  });
  it("가까운(14m 안) 상대를 쫓아간다", () => {
    const d = decide(me(10, 2), plan(), [{ ...me(20, 2, "A"), id: "h" }], ctx);
    expect(d.attack).toBeUndefined();
    expect(d.angle).toBe(0); // 동쪽
    expect(d.enemyNear).toBe(true);
  });
  it("죽은 상대는 무시하고 순찰한다", () => {
    const dead = { ...me(11, 2, "A"), id: "h", c: applyHit({ ...newCombat(), hp: 25 }, 0) };
    const d = decide(me(10, 2), plan(), [dead], ctx);
    expect(d.attack).toBeUndefined();
    expect(d.enemyNear).toBe(false);
  });
  it("죽은 더미는 아무것도 안 한다", () => {
    const bot = { ...me(10, 2), c: applyHit({ ...newCombat(), hp: 25 }, 0) };
    expect(decide(bot, plan(), [], ctx)).toEqual({ angle: -1, enemyNear: false });
  });
  it("길 끝에 도착하면 arrived (방에서 반대 방향 새 길을 짠다)", () => {
    const p = plan();
    p.idx = p.waypoints.length - 1;
    const last = p.waypoints[p.idx]!;
    expect(decide(me(last.x, last.y), p, [], ctx)).toMatchObject({ angle: -1, arrived: true });
  });
  it("벽 너머 상대는 때리지 않는다", () => {
    // 엄폐벽(x 21.5~26.5, y 3.6~4.4) 남쪽과 북쪽
    const d = decide(me(24, 3.0), plan(), [{ ...me(24, 4.95, "A"), id: "h" }], ctx);
    expect(d.attack).toBeUndefined();
  });
});
