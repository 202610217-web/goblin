// 조준(화면 가운데 조준점)과 사거리 판정. 서버와 클라이언트가 같은 계산을 쓴다.
// 3인칭 카메라는 캐릭터 머리 위 오른쪽 어깨 뒤에 있고, 화면 가운데 조준점 = 카메라에서 나가는 광선.
import type { Body } from "./sim";
import { BOXES, PHYS } from "./world";

/** 카메라/조준 수치 (화면에 보이는 것과 서버 판정이 같아야 하므로 shared에 둔다) */
export const AIM = {
  /** 캐릭터 뒤 카메라 거리, 바라보는 높이(발 기준), 오른쪽 어깨 쪽으로 비킨 거리 */
  CAMERA_DISTANCE: 6.5,
  CAMERA_TARGET_HEIGHT: 1.5,
  CAMERA_SHOULDER: 0.8,
  /** 조준점 광선이 캐릭터 정면 선과 만나는 거리 (머리에서 앞쪽으로, m). 어깨 카메라를 이만큼 안쪽으로 살짝 돌린다 */
  AIM_CONVERGE: 1.5,
  /** 궁수: 어깨를 더 비키고 조준선을 멀리(화살 사거리) 모아서, 조준점이 내 몸에 겹치지 않게 한다 */
  ARCHER_SHOULDER: 1.2,
  ARCHER_CONVERGE: 12,
  /** 카메라 각 범위 (라디안, +는 내려다봄, -는 올려다봄) */
  PITCH_MIN: -0.6,
  PITCH_MAX: 1.2,
  /** 타격 사거리: 두 캐릭터 중심 사이 수평 거리 (m) */
  ATTACK_RANGE: 2.0,
  /** 기사 타격 범위: 조준 방향 기준 양옆 각도 (라디안, 30도) */
  ATTACK_HALF_ANGLE: Math.PI / 6,
  /** 타격 가능한 발 높이 차이 (m) */
  ATTACK_MAX_HEIGHT_DIFF: 1.2,
  /** 치유 가능 거리, 높이 차이 (m) */
  REVIVE_RANGE: 1.5,
  REVIVE_MAX_HEIGHT_DIFF: 1.2,
} as const;

export interface Vec3 { x: number; y: number; z: number }

export const clampPitch = (p: number) => Math.min(AIM.PITCH_MAX, Math.max(AIM.PITCH_MIN, p));

/**
 * 카메라 위치와 화면 가운데(조준점) 광선 방향. yaw = 수평 방향, pitch = 내려다보는 각.
 * 카메라는 머리 뒤 위쪽에서 오른쪽 어깨로 비켜 있고, 광선은 "머리에서 정면으로 AIM_CONVERGE 앞" 지점을 지난다.
 * (그래서 조준점이 내 캐릭터에 가리지 않으면서도 정면에 선 상대를 겨눌 수 있다)
 */
export function aimRay(b: Body, yaw: number, pitch: number, ranged = false): { origin: Vec3; dir: Vec3 } {
  const p = clampPitch(pitch);
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const rx = fy, ry = -fx; // 오른쪽 방향
  const d = AIM.CAMERA_DISTANCE, s = ranged ? AIM.ARCHER_SHOULDER : AIM.CAMERA_SHOULDER;
  // 어깨로 비키기 전 광선 방향(머리를 지남)
  const d0 = { x: fx * Math.cos(p), y: fy * Math.cos(p), z: -Math.sin(p) };
  const hz = b.z + AIM.CAMERA_TARGET_HEIGHT;
  const origin = { x: b.x - d0.x * d + rx * s, y: b.y - d0.y * d + ry * s, z: hz - d0.z * d };
  const c = aimConverge(ranged);
  const aim = { x: b.x + d0.x * c, y: b.y + d0.y * c, z: hz + d0.z * c };
  const len = Math.hypot(aim.x - origin.x, aim.y - origin.y, aim.z - origin.z);
  const dir = { x: (aim.x - origin.x) / len, y: (aim.y - origin.y) / len, z: (aim.z - origin.z) / len };
  return { origin, dir };
}

export const aimConverge = (ranged: boolean) => (ranged ? AIM.ARCHER_CONVERGE : AIM.AIM_CONVERGE);

/** 광선이 상자에 들어가는 거리 t (안 맞으면 null) */
export function rayAabb(o: Vec3, d: Vec3, min: Vec3, max: Vec3): number | null {
  let t0 = -Infinity, t1 = Infinity;
  for (const k of ["x", "y", "z"] as const) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < min[k] || o[k] > max[k]) return null;
      continue;
    }
    let a = (min[k] - o[k]) / d[k];
    let b = (max[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t1 < 0 ? null : Math.max(t0, 0);
}

/** 두 캐릭터가 타격/치유 거리 안인지 (수평 중심 거리 + 발 높이 차) */
export function inReach(a: Body, b: Body, range: number, maxDz: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= range && Math.abs(a.z - b.z) <= maxDz;
}

/**
 * 기사 타격 대상 찾기. 조건:
 * - 조준 방향(yaw) 기준 양옆 30도(ATTACK_HALF_ANGLE) 안, 사거리/높이 차이 안
 * - 공격자 가슴에서 그 캐릭터 가슴까지 벽/상자가 가리지 않는다
 * 여러 명이면 조준 방향에 가장 가까운(각도가 작은, 같으면 더 가까운) 1명. 몸이 겹칠 만큼 붙은 앞쪽 상대가 가장 우선. 없으면 null.
 * (pitch는 받지만 쓰지 않는다: 근접 판정은 수평 방향만 본다)
 */
export function findAimTarget<T extends { id: string; body: Body }>(attacker: Body, yaw: number, _pitch: number, candidates: T[], range: number = AIM.ATTACK_RANGE): T | null {
  const H = PHYS.PLAYER_HALF;
  const chest = PHYS.PLAYER_HEIGHT / 2;
  let best: T | null = null;
  let bestAngle = Infinity, bestDist = Infinity;
  for (const c of candidates) {
    const b = c.body;
    if (!inReach(attacker, b, range, AIM.ATTACK_MAX_HEIGHT_DIFF)) continue;
    const dx = b.x - attacker.x, dy = b.y - attacker.y;
    const dist = Math.hypot(dx, dy);
    const ahead = dx * Math.cos(yaw) + dy * Math.sin(yaw);
    // 몸이 겹칠 만큼 붙어 있으면(캐릭터끼리는 통과 가능) 앞쪽이기만 하면 맞는다
    const angle = dist < H * 2 ? (ahead >= 0.1 ? -1 : Infinity) : Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - yaw), Math.cos(Math.atan2(dy, dx) - yaw)));
    if (angle > AIM.ATTACK_HALF_ANGLE || angle > bestAngle || (angle === bestAngle && dist >= bestDist)) continue;
    const o = { x: attacker.x, y: attacker.y, z: attacker.z + chest };
    const v = { x: dx, y: dy, z: b.z - attacker.z };
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    if (blocked(o, { x: v.x / len, y: v.y / len, z: v.z / len }, 0, len)) continue;
    best = c;
    bestAngle = angle;
    bestDist = dist;
  }
  return best;
}

/** 광선의 tFrom~tTo 구간을 벽/상자가 가리는지 */
function blocked(o: Vec3, d: Vec3, tFrom: number, tTo: number): boolean {
  for (const box of BOXES) {
    const t = rayAabb(o, d, { x: box.x0, y: box.y0, z: box.z0 }, { x: box.x1, y: box.y1, z: box.z1 });
    if (t !== null && t > tFrom && t < tTo) return true;
  }
  return false;
}
