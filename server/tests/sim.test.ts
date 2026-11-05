import { describe, expect, it } from "vitest";
import { bodyHeight, groundHeightAt, isValidAngle, makeBody, radToAngle, roundBody, simulate, type Body, withAngle, withCrouch, withJump } from "../../shared/sim";
import { BOXES, PHYS } from "../../shared/world";

const EAST = 0; // 0 단계 = +x
const NORTH = PHYS.ANGLE_STEPS / 4; // +y
const WEST = PHYS.ANGLE_STEPS / 2;

/** 상자가 없는 빈 곳 */
const open = (): Body => makeBody(10, 2, 0);

describe("기본 이동", () => {
  it("멈춰 있으면 그대로", () => {
    expect(simulate(open(), 5000)).toMatchObject({ x: 10, y: 2, z: 0, g: true });
  });
  it("동쪽으로 1초 = 속도만큼", () => {
    const b = simulate(withAngle(open(), EAST, 0), 1000);
    expect(b.x).toBeCloseTo(10 + PHYS.SPEED, 5);
    expect(b.y).toBeCloseTo(2, 5);
  });
  it("방향 바꾸면 그 시점 위치에서 이어진다", () => {
    let b = withAngle(open(), EAST, 0);
    b = withAngle(b, NORTH, 500);
    expect(b.x).toBeCloseTo(10 + PHYS.SPEED / 2, 5);
    const c = simulate(b, 1000);
    expect(c.y).toBeCloseTo(2 + PHYS.SPEED / 2, 5);
  });
  it("맵 경계를 넘지 못한다", () => {
    const b = simulate(withAngle(open(), WEST, 0), 10_000);
    expect(b.x).toBeCloseTo(PHYS.PLAYER_HALF, 5);
  });
  it("과거 시각으로는 진행하지 않는다", () => {
    const b = withAngle(makeBody(10, 2, 1000), EAST, 1000);
    expect(simulate(b, 500).x).toBe(10);
  });
  it("각도 값 검증/변환", () => {
    expect(isValidAngle(-1)).toBe(true);
    expect(isValidAngle(PHYS.ANGLE_STEPS - 1)).toBe(true);
    expect(isValidAngle(PHYS.ANGLE_STEPS)).toBe(false);
    expect(isValidAngle(1.5)).toBe(false);
    expect(radToAngle(Math.PI / 2)).toBe(NORTH);
    expect(radToAngle(-Math.PI / 2)).toBe((PHYS.ANGLE_STEPS * 3) / 4);
  });
});

describe("충돌과 계단", () => {
  it("높은 벽(엄폐물)에 막힌다", () => {
    const wall = BOXES.find((b) => b.kind === "wall" && b.y0 < 5)!; // y≈4 의 벽
    const start = makeBody(wall.x0 - 3, (wall.y0 + wall.y1) / 2, 0);
    const b = simulate(withAngle(start, EAST, 0), 2000);
    expect(b.x).toBeCloseTo(wall.x0 - PHYS.PLAYER_HALF, 5);
  });
  it("집 안으로 들어갈 수 없다", () => {
    const start = makeBody(13, 14, 0); // A팀 집(동쪽 면 x=9) 동쪽
    const b = simulate(withAngle(start, WEST, 0), 3000);
    expect(b.x).toBeCloseTo(9 + PHYS.PLAYER_HALF, 5);
  });
  it("계단은 걸어서 올라가 단상(1.6m) 위에 선다", () => {
    const start = makeBody(18, 14, 0); // 서쪽 계단 아래(벽 x=17.4 동쪽)
    const b = simulate(withAngle(start, EAST, 0), 1000); // 6m 이동 → 단상 위 x≈24
    expect(b.z).toBeCloseTo(1.6, 5);
    expect(b.g).toBe(true);
  });
  it("상자(1.0m)는 걸어서 못 올라가고 점프하면 올라간다", () => {
    const crate = BOXES.find((b) => b.kind === "crate")!;
    const cy = (crate.y0 + crate.y1) / 2;
    const walk = simulate(withAngle(makeBody(crate.x0 - 1.5, cy, 0), EAST, 0), 1000);
    expect(walk.z).toBe(0);
    expect(walk.x).toBeCloseTo(crate.x0 - PHYS.PLAYER_HALF, 5);
    // 상자 앞에서 점프하면서 앞으로
    let j = withJump(withAngle(makeBody(crate.x0 - 0.6, cy, 0), EAST, 0), 0)!;
    j = withAngle(j, -1, 230); // 상자 위에서 멈춤
    const top = simulate(j, 2000);
    expect(top.z).toBeCloseTo(crate.z1, 5);
    expect(top.g).toBe(true);
  });
  it("단상 끝에서 걸어 나가면 떨어진다", () => {
    const b = simulate(withAngle(makeBody(24, 14, 0), NORTH, 0), 0); // 단상 아래 땅에서 시작하면 안 되므로 위로 올린다
    b.z = 1.6;
    const fall = simulate(b, 2000); // 북쪽으로 계속 걸어 단상 밖으로
    expect(fall.y).toBeGreaterThan(17);
    expect(fall.z).toBe(0);
    expect(fall.g).toBe(true);
  });
});

describe("점프", () => {
  it("땅에서만 점프, 최고 높이 ≈ v²/2g, 다시 착지", () => {
    const j = withJump(open(), 0)!;
    expect(j.g).toBe(false);
    expect(withJump(simulate(j, 100), 100)).toBeNull(); // 공중 점프 불가
    let maxZ = 0;
    for (let t = 0; t <= 1000; t += 10) maxZ = Math.max(maxZ, simulate(j, t).z);
    const expected = PHYS.JUMP_VELOCITY ** 2 / (2 * PHYS.GRAVITY);
    expect(maxZ).toBeGreaterThan(expected - 0.05);
    expect(maxZ).toBeLessThan(expected + 0.05);
    expect(simulate(j, 2000)).toMatchObject({ z: 0, vz: 0, g: true });
  });
  it("나눠서 계산해도 결과가 거의 같다 (서버는 이벤트마다 끊어서 계산)", () => {
    const j = withAngle(withJump(open(), 0)!, EAST, 0);
    const whole = simulate(j, 1500);
    let parts = j;
    for (const t of [123, 456, 789, 1000, 1500]) parts = simulate(parts, t);
    expect(parts.x).toBeCloseTo(whole.x, 2);
    expect(parts.z).toBeCloseTo(whole.z, 2);
  });
  it("바닥 높이 계산", () => {
    expect(groundHeightAt(24, 14, 5)).toBeCloseTo(1.6, 5); // 단상 위
    expect(groundHeightAt(24, 14, 0)).toBe(0); // 단상보다 낮은 곳에서는 땅
  });
});

describe("앉기 / 파쿠르", () => {
  it("앉으면 키가 낮아지고 절반 속도로 걷는다, 뛰면 일어난다", () => {
    const crouched = withCrouch(makeBody(5, 2, 0), true, 0);
    expect(bodyHeight(crouched)).toBe(PHYS.CROUCH_HEIGHT);
    const walked = simulate(withAngle(crouched, 0, 0), 1000);
    expect(walked.x - 5).toBeCloseTo(PHYS.SPEED * PHYS.CROUCH_SPEED, 5);
    expect(withJump(walked, 1000)!.k).toBeUndefined();
    expect(roundBody(crouched).k).toBe(true);
  });
  it("기본 맵의 2.2m 벽은 뛰어도 못 오른다 (파쿠르는 2.13m까지)", () => {
    // 가운데 서쪽 엄폐벽: x 16.6~17.4, y 12~16, 높이 2.2
    let b = withAngle(makeBody(15.4, 14, 0), 0, 0);
    b = withJump(b, 60)!;
    b = simulate(b, 1500);
    expect(b.x).toBeLessThan(16.6);
    expect(b.z).toBe(0);
  });
});
