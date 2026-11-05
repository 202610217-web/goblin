// 결정적(deterministic) 이동 시뮬레이션. 서버와 클라이언트가 똑같이 실행한다.
// 서버는 매 프레임 계산하지 않고, 이벤트가 올 때 "마지막 시각부터 지금까지"를 한 번에 계산한다.
import { BARRIERS, BOXES_BY_MAP, type BarrierRole, type Box, MAPS, PHYS, mapAt } from "./world";

/** 캐릭터의 물리 상태 */
export interface Body {
  x: number;
  y: number;
  /** 발 높이 */
  z: number;
  /** 수직 속도 */
  vz: number;
  /** 이동 방향 각도 단계 (0 ~ ANGLE_STEPS-1), -1 = 정지 */
  a: number;
  /** 땅(또는 상자 위)에 서 있는지 */
  g: boolean;
  /** 이 상태의 서버 기준 시각 (ms) */
  t: number;
  /** 준비 시간 결계가 사라지는 서버 시각 (없으면 결계 없음). 이 시각 전까지 br 역할의 결계에 막힌다 */
  bu?: number;
  br?: BarrierRole;
}

const EPS = 1e-4;
const H = PHYS.PLAYER_HALF;

/** 각도 단계별 방향 벡터 (미리 계산) */
const DIRS: readonly (readonly [number, number])[] = Array.from({ length: PHYS.ANGLE_STEPS }, (_, i) => {
  const r = (i / PHYS.ANGLE_STEPS) * Math.PI * 2;
  return [Math.cos(r), Math.sin(r)] as const;
});

export function isValidAngle(a: unknown): a is number {
  return typeof a === "number" && Number.isInteger(a) && a >= -1 && a < PHYS.ANGLE_STEPS;
}

/** 각도 단계 → 라디안 */
export function angleToRad(a: number): number {
  return (a / PHYS.ANGLE_STEPS) * Math.PI * 2;
}

/** 라디안 → 가장 가까운 각도 단계 */
export function radToAngle(r: number): number {
  const n = PHYS.ANGLE_STEPS;
  return ((Math.round((r / (Math.PI * 2)) * n) % n) + n) % n;
}

export function makeBody(x: number, y: number, t: number): Body {
  return { x, y, z: groundHeightAt(x, y, 0), vz: 0, a: -1, g: true, t };
}

/** 캐릭터 발판(x,y)과 상자가 수평으로 겹치는지 */
function overlapXY(x: number, y: number, b: { x0: number; y0: number; x1: number; y1: number }): boolean {
  return x + H > b.x0 + EPS && x - H < b.x1 - EPS && y + H > b.y0 + EPS && y - H < b.y1 - EPS;
}

/** 캐릭터 몸(z ~ z+키)과 상자가 수직으로 겹치는지 */
function overlapZ(z: number, b: Box): boolean {
  return z < b.z1 - EPS && z + PHYS.PLAYER_HEIGHT > b.z0 + EPS;
}

/** 이 위치가 속한 맵의 상자들 */
const boxesAt = (x: number) => BOXES_BY_MAP[mapAt(x)];

/** (x,y)에서 발 높이 z 이하에 있는 가장 높은 바닥 */
export function groundHeightAt(x: number, y: number, z: number): number {
  let g = 0;
  for (const b of boxesAt(x)) {
    if (b.z1 <= z + 0.01 && b.z1 > g && overlapXY(x, y, b)) g = b.z1;
  }
  return g;
}

/** 머리 위 공간이 비어 있는지 (턱을 올라갈 때 확인) */
function freeAt(x: number, y: number, z: number): boolean {
  for (const b of boxesAt(x)) if (overlapXY(x, y, b) && overlapZ(z, b)) return false;
  return true;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 한 축 이동 + 벽 충돌 + 계단 자동 오르기 */
function moveAxis(b: Body, axis: "x" | "y", d: number) {
  if (d === 0) return;
  let nx = axis === "x" ? b.x + d : b.x;
  let ny = axis === "y" ? b.y + d : b.y;
  const boxes = boxesAt(b.x);
  for (const box of boxes) {
    if (!overlapXY(nx, ny, box) || !overlapZ(b.z, box)) continue;
    const rise = box.z1 - b.z;
    // 서 있는 상태에서 낮은 턱이고 위가 비어 있으면 올라간다
    if (b.g && rise <= PHYS.STEP_HEIGHT && freeAt(nx, ny, box.z1)) {
      b.z = box.z1;
      continue;
    }
    // 막힘: 상자 면에 딱 붙인다
    if (axis === "x") nx = d > 0 ? box.x0 - H : box.x1 + H;
    else ny = d > 0 ? box.y0 - H : box.y1 + H;
  }
  // 준비 시간 결계: 높이와 상관없이 막는다 (해제 시각 전, 내 역할에 해당하는 것만)
  if (b.bu !== undefined && b.t < b.bu) {
    for (const w of BARRIERS) {
      if ((w.role !== "all" && w.role !== b.br) || !overlapXY(nx, ny, w)) continue;
      if (axis === "x") nx = d > 0 ? w.x0 - H : w.x1 + H;
      else ny = d > 0 ? w.y0 - H : w.y1 + H;
    }
  }
  const m = MAPS[mapAt(b.x)];
  b.x = clamp(nx, m.x0 + H, m.x1 - H);
  b.y = clamp(ny, m.y0 + H, m.y1 - H);
}

/** dt 초만큼 한 걸음 진행 (b를 직접 바꾼다) */
function step(b: Body, dt: number) {
  if (b.a >= 0) {
    const v = DIRS[b.a]!;
    moveAxis(b, "x", v[0] * PHYS.SPEED * dt);
    moveAxis(b, "y", v[1] * PHYS.SPEED * dt);
  }
  // 수직: 등가속도 공식(정확한 계산)으로 중력 적용 → 착지 / 천장
  let nz = b.z + b.vz * dt - 0.5 * PHYS.GRAVITY * dt * dt;
  b.vz -= PHYS.GRAVITY * dt;
  if (b.vz > 0) {
    for (const box of boxesAt(b.x)) {
      if (overlapXY(b.x, b.y, box) && box.z0 >= b.z + PHYS.PLAYER_HEIGHT - EPS && nz + PHYS.PLAYER_HEIGHT > box.z0) {
        nz = box.z0 - PHYS.PLAYER_HEIGHT;
        b.vz = 0;
      }
    }
  }
  const ground = groundHeightAt(b.x, b.y, b.z);
  if (nz <= ground) {
    b.z = ground;
    b.vz = 0;
    b.g = true;
  } else {
    b.z = nz;
    b.g = false;
  }
}

/** b를 toT 시각까지 진행한 새 상태를 돌려준다 (b는 그대로) */
export function simulate(b: Body, toT: number): Body {
  const s = { ...b };
  if (toT <= s.t) return s;
  // 서 있고 멈춰 있으면 계산할 것이 없다 (서버 CPU 절약)
  if (s.a < 0 && s.g && s.vz === 0) {
    s.t = toT;
    return s;
  }
  while (s.t < toT) {
    const dtMs = Math.min(PHYS.STEP_MS, toT - s.t);
    step(s, dtMs / 1000);
    s.t += dtMs;
    if (s.a < 0 && s.g && s.vz === 0) { s.t = toT; break; }
  }
  return s;
}

/** 지금까지 진행 후 이동 방향 변경 */
export function withAngle(b: Body, a: number, now: number): Body {
  const s = simulate(b, now);
  s.a = a;
  return s;
}

/** 지금까지 진행 후 점프 (땅에 있을 때만). 점프 못 하면 null */
export function withJump(b: Body, now: number): Body | null {
  const s = simulate(b, now);
  if (!s.g) return null;
  s.vz = PHYS.JUMP_VELOCITY;
  s.g = false;
  return s;
}

/** 메시지 크기를 줄이기 위해 소수점 정리 (서버가 보내기 전에 사용) */
export function roundBody(b: Body): Body {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const out: Body = { x: r(b.x), y: r(b.y), z: r(b.z), vz: r(b.vz), a: b.a, g: b.g, t: b.t };
  if (b.bu !== undefined && b.t < b.bu) { out.bu = b.bu; out.br = b.br; } // 결계가 끝났으면 뺀다
  return out;
}
