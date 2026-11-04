import { describe, expect, it } from "vitest";
import { AIM, aimRay, findAimTarget, inReach } from "../../shared/aim";
import { makeBody } from "../../shared/sim";

const P = AIM.CAMERA_DISTANCE > 0 ? 0.42 : 0; // 기본 카메라 각도
const me = makeBody(10, 2, 0); // 빈 곳, 동쪽(yaw 0)을 봄
const enemy = (x: number, y: number, z = 0) => ({ id: `${x},${y}`, body: { ...makeBody(x, y, 0), z } });

describe("조준점 광선", () => {
  it("광선은 정면 AIM_CONVERGE 앞 지점을 지난다", () => {
    const { origin, dir } = aimRay(me, 0, P);
    const t = (me.x + AIM.AIM_CONVERGE * Math.cos(P) - origin.x) / dir.x;
    expect(origin.y + dir.y * t).toBeCloseTo(me.y, 6); // 정면 선 위
  });
});

describe("타격 대상 판정", () => {
  it("정면 1.5m의 적은 맞는다", () => {
    expect(findAimTarget(me, 0, P, [enemy(11.5, 2)])?.id).toBe("11.5,2");
  });
  it("사거리(2m) 밖이면 안 맞는다", () => {
    expect(findAimTarget(me, 0, P, [enemy(12.5, 2)])).toBeNull();
  });
  it("등 뒤나 옆을 보고 있으면 안 맞는다", () => {
    expect(findAimTarget(me, Math.PI, P, [enemy(11.5, 2)])).toBeNull();
    expect(findAimTarget(me, Math.PI / 2, P, [enemy(11.5, 2)])).toBeNull();
  });
  it("조준점에서 옆으로 벗어난 적은 안 맞는다", () => {
    expect(findAimTarget(me, 0, P, [enemy(11.5, 3.5)])).toBeNull();
  });
  it("여러 명이면 조준점에 먼저 걸리는 사람", () => {
    expect(findAimTarget(me, 0, P, [enemy(11.9, 2), enemy(11.2, 2)])?.id).toBe("11.2,2");
  });
  it("높이 차 1.2m 초과(단상 위/아래)는 안 맞는다", () => {
    expect(findAimTarget(me, 0, P, [enemy(11.5, 2, 1.6)])).toBeNull();
    expect(findAimTarget(me, 0, P, [enemy(11.5, 2, 1.0)])?.id).toBe("11.5,2");
  });
  it("벽 너머는 안 맞는다", () => {
    // y≈4 의 엄폐벽(x 21.5~26.5, y 3.6~4.4, 높이 2.2) 남쪽에서 북쪽을 보며 벽 너머 적을 겨눔
    const a = makeBody(24, 3, 0);
    expect(findAimTarget(a, Math.PI / 2, P, [enemy(24, 4.9)])).toBeNull();
    // 벽이 없는 곳에서 같은 거리면 맞는다
    const b = makeBody(10, 3, 0);
    expect(findAimTarget(b, Math.PI / 2, P, [enemy(10, 4.9)])?.id).toBe("10,4.9");
  });
});

describe("치유 거리", () => {
  it("1.5m + 높이 차 1.2m 이내", () => {
    expect(inReach(me, makeBody(11.4, 2, 0), AIM.REVIVE_RANGE, AIM.REVIVE_MAX_HEIGHT_DIFF)).toBe(true);
    expect(inReach(me, makeBody(11.6, 2, 0), AIM.REVIVE_RANGE, AIM.REVIVE_MAX_HEIGHT_DIFF)).toBe(false);
    expect(inReach(me, { ...makeBody(11, 2, 0), z: 1.6 }, AIM.REVIVE_RANGE, AIM.REVIVE_MAX_HEIGHT_DIFF)).toBe(false);
  });
});
