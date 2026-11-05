// 궁수 화살: 쏜 순간 출발점·방향을 정하고, 서버가 50ms마다 지나간 구간에 누가 있는지 본다.
// 날아가는 동안 상대가 움직이면 빗나가므로 멀리 있는 상대는 앞을 보고 쏴야 한다 (리드샷).
import { AIM, type Vec3, aimRay, rayAabb } from "./aim";
import { CLASSES, type Projectile } from "./classes";
import { type Body, bodyHeight, simulate } from "./sim";
import { BOXES, PHYS } from "./world";

export interface Arrow {
  origin: Vec3;
  /** 길이 1인 방향 */
  dir: Vec3;
  /** 쏜 서버 시각 (ms) */
  at: number;
  /** 초당 속도(m/s), 최대 거리(m) */
  speed: number;
  range: number;
}

/** 화살이 나가는 높이 (발 기준, 가슴께) */
const CHEST = 1.2, CHEST_CROUCH = 0.8;

/** 광선이 처음 닿는 벽/상자/땅까지 거리 (없으면 Infinity) */
export function firstSolid(o: Vec3, d: Vec3, tMin: number): number {
  let best = d.z < 0 ? (0 - o.z) / d.z : Infinity; // 맨땅(z=0)
  for (const b of BOXES) {
    const t = rayAabb(o, d, { x: b.x0, y: b.y0, z: b.z0 }, { x: b.x1, y: b.y1, z: b.z1 });
    if (t !== null && t > tMin && t < best) best = t;
  }
  return best;
}

/**
 * 쏠 때의 화살. 조준점 광선(어깨 카메라)이 처음 닿는 곳 또는 사거리 끝 지점을 향해
 * 몸 가슴 높이에서 쏜다 (몸에서 그냥 정면으로 쏘면 화면 가운데 조준점과 어긋나기 때문).
 */
export function makeArrow(shooter: Body, yaw: number, pitch: number, at: number, proj: Projectile = CLASSES.ARCHER.proj!): Arrow {
  const origin = { x: shooter.x, y: shooter.y, z: shooter.z + (shooter.k ? CHEST_CROUCH : CHEST) };
  const ray = aimRay(shooter, yaw, pitch, true);
  const o = ray.origin, d = ray.dir;
  // 광선 위에서 쏜 사람과의 수평 거리가 MAX_RANGE가 되는 지점 (2차 방정식의 큰 근)
  const px = o.x - shooter.x, py = o.y - shooter.y;
  const A = d.x * d.x + d.y * d.y, B = 2 * (px * d.x + py * d.y), C = px * px + py * py - proj.range ** 2;
  const tRange = A > 1e-9 ? (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A) : proj.range;
  const head = { x: shooter.x - o.x, y: shooter.y - o.y, z: shooter.z + AIM.CAMERA_TARGET_HEIGHT - o.z };
  const tStart = Math.max(0, head.x * d.x + head.y * d.y + head.z * d.z); // 카메라 뒤쪽 벽은 무시
  const t = Math.min(tRange, firstSolid(o, d, tStart));
  const target = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  const v = { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z };
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { origin, dir: { x: v.x / len, y: v.y / len, z: v.z / len }, at, speed: proj.speed, range: proj.range };
}

/**
 * 화살이 fromT~toT 동안 지나간 구간에서 처음 닿는 적. 후보 몸은 toT 시각 위치로 본다.
 * stopped = 벽/땅에 박혔거나 사거리 끝에 닿아서 더 날아가지 않음.
 */
export function arrowSegmentHit<T extends { id: string; body: Body }>(
  arrow: Arrow, fromT: number, toT: number, candidates: T[],
): { hit: T | null; stopped: boolean } {
  const dFrom = (arrow.speed * (fromT - arrow.at)) / 1000;
  const dTo = Math.min(arrow.range, (arrow.speed * (toT - arrow.at)) / 1000);
  const wall = firstSolid(arrow.origin, arrow.dir, 0);
  const end = Math.min(dTo, wall);
  const H = PHYS.PLAYER_HALF;
  let hit: T | null = null;
  let bestT = Infinity;
  for (const c of candidates) {
    const b = simulate(c.body, toT);
    const t = rayAabb(arrow.origin, arrow.dir, { x: b.x - H, y: b.y - H, z: b.z }, { x: b.x + H, y: b.y + H, z: b.z + bodyHeight(b) }); // 앉으면 낮은 상자
    if (t === null || t < dFrom || t > end || t >= bestT) continue;
    hit = c;
    bestT = t;
  }
  return { hit, stopped: hit !== null || wall <= dTo || dTo >= arrow.range };
}
