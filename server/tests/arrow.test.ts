import { describe, expect, it } from "vitest";
import { ARROW } from "../../shared/classes";
import { type Arrow, arrowSegmentHit, makeArrow } from "../../shared/arrow";
import { aimRay } from "../../shared/aim";
import { type Body, makeBody, withAngle } from "../../shared/sim";

// y=2 줄은 x 10~22가 비어 있는 곳 (aim.test와 같은 빈 곳)
const flat = (tx: number, ty: number, tz = 1.2): Arrow => {
  const o = { x: 10, y: 2, z: 1.2 };
  const l = Math.hypot(tx - o.x, ty - o.y, tz - o.z);
  return { origin: o, dir: { x: (tx - o.x) / l, y: (ty - o.y) / l, z: (tz - o.z) / l }, at: 0 };
};
const enemy = (body: Body) => ({ id: "e", body });

/** 서버처럼 50ms씩 날려서 맞은 대상 id (없으면 null) */
function fly(arrow: Arrow, cands: { id: string; body: Body }[]): { id: string | null; t: number } {
  for (let t = arrow.at; ; t += ARROW.STEP_MS) {
    const r = arrowSegmentHit(arrow, t, t + ARROW.STEP_MS, cands);
    if (r.hit) return { id: r.hit.id, t: t + ARROW.STEP_MS };
    if (r.stopped) return { id: null, t: t + ARROW.STEP_MS };
    if (t > 2000) throw new Error("화살이 멈추지 않음");
  }
}

// 북쪽(+y)으로 걷기 = 각도 단계 8 (32단계 중 90도), 남쪽 = 24
const NORTH = 8, SOUTH = 24;

describe("화살 비행 판정", () => {
  it("가만히 있는 10m 앞 적은 맞고, 도착까지 약 0.33초", () => {
    const r = fly(flat(20, 2), [enemy(makeBody(20, 2, 0))]);
    expect(r.id).toBe("e");
    expect(r.t).toBeGreaterThanOrEqual(300);
    expect(r.t).toBeLessThanOrEqual(400);
  });
  it("옆으로 걷는 10m 거리 적을 정면 조준하면 빗나간다", () => {
    const walker = withAngle(makeBody(20, 2, 0), NORTH, 0);
    expect(fly(flat(20, 2), [enemy(walker)]).id).toBeNull();
  });
  it("가는 방향 앞을 조준(리드샷)하면 맞는다", () => {
    const walker = withAngle(makeBody(20, 2, 0), NORTH, 0);
    expect(fly(flat(20, 4), [enemy(walker)]).id).toBe("e");
  });
  it("리드샷을 해도 비행 중 방향을 바꾸면 빗나간다", () => {
    const turned = withAngle(simulateTo(withAngle(makeBody(20, 2, 0), NORTH, 0), 100), SOUTH, 100);
    expect(fly(flat(20, 4), [enemy(turned)]).id).toBeNull();
  });
  it("벽 뒤의 적은 벽에서 멈춘다", () => {
    // x=17 벽(y 12~16) 뒤
    const o = { x: 12, y: 14, z: 1.2 };
    const a: Arrow = { origin: o, dir: { x: 1, y: 0, z: 0 }, at: 0 };
    expect(fly(a, [enemy(makeBody(20, 14, 0))]).id).toBeNull();
  });
  it("12m 밖은 닿지 않는다", () => {
    expect(fly(flat(30, 2), [enemy(makeBody(23, 2, 0))]).id).toBeNull();
  });
  it("makeArrow: 몸 가슴 높이에서 출발해 조준점 광선 위의 지점을 향한다", () => {
    const me = makeBody(10, 2, 0);
    const a = makeArrow(me, 0, 0.1, 500);
    expect(a.origin).toMatchObject({ x: 10, y: 2, z: 1.2 });
    expect(a.at).toBe(500);
    expect(Math.hypot(a.dir.x, a.dir.y, a.dir.z)).toBeCloseTo(1, 6);
    // 화살 방향의 11m 앞 지점이 조준 광선과 거의 겹친다 (어깨 카메라 보정)
    const { origin, dir } = aimRay(me, 0, 0.1);
    const p = { x: a.origin.x + a.dir.x * 11, y: a.origin.y + a.dir.y * 11, z: a.origin.z + a.dir.z * 11 };
    const t = (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y + (p.z - origin.z) * dir.z;
    const dist = Math.hypot(origin.x + dir.x * t - p.x, origin.y + dir.y * t - p.y, origin.z + dir.z * t - p.z);
    expect(dist).toBeLessThan(0.3);
  });
});

import { simulate } from "../../shared/sim";
const simulateTo = (b: Body, t: number) => simulate(b, t);
