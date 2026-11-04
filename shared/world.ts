// 서버와 클라이언트가 함께 쓰는 3D 맵 데이터와 이동 물리 수치.
// (같은 값으로 같은 계산을 해야 클라이언트 예측이 서버와 맞기 때문에 shared/ 에 둔다)
// 좌표계: x = 동(오른쪽), y = 북(앞쪽), z = 위. 단위는 미터.

export type TeamId = "A" | "B";

/** 이동 물리 수치 */
export const PHYS = {
  /** 맵 크기 */
  MAP_X: 48,
  MAP_Y: 28,
  /** 캐릭터를 사각 기둥으로 본다: 반 폭, 키 */
  PLAYER_HALF: 0.4,
  PLAYER_HEIGHT: 1.8,
  /** 걷는 속도 (m/s) */
  SPEED: 6,
  /** 중력 (m/s²), 점프 초속도 (m/s) → 최대 점프 높이 ≈ v²/2g ≈ 1.28m */
  GRAVITY: 22,
  JUMP_VELOCITY: 7.5,
  /** 이 높이 이하의 턱은 걸어서 자동으로 올라간다 (계단) */
  STEP_HEIGHT: 0.45,
  /** 시뮬레이션 고정 시간 간격 (ms) */
  STEP_MS: 1000 / 60,
  /** 이동 방향 각도 단계 수 (32 = 11.25° 간격) */
  ANGLE_STEPS: 32,
} as const;

/** 축 정렬 상자 (벽, 상자, 계단, 단상, 집) */
export interface Box {
  x0: number; y0: number; x1: number; y1: number;
  /** 바닥 높이, 윗면 높이 */
  z0: number; z1: number;
  kind: "wall" | "crate" | "step" | "platform" | "house";
  team?: TeamId;
}

/** 중심/크기로 상자 만들기 */
function box(cx: number, cy: number, sx: number, sy: number, h: number, kind: Box["kind"], z0 = 0, team?: TeamId): Box {
  return { x0: cx - sx / 2, y0: cy - sy / 2, x1: cx + sx / 2, y1: cy + sy / 2, z0, z1: z0 + h, kind, team };
}

/** 팀별 집 (중심, 크기, 높이). A팀 집은 서쪽, B팀 집은 동쪽 */
export const HOUSES: Record<TeamId, { x: number; y: number; size: number; height: number }> = {
  A: { x: 6, y: 14, size: 6, height: 4 },
  B: { x: 42, y: 14, size: 6, height: 4 },
};

/** 팀별 시작 위치 (팀 안에서 0번, 1번 자리) */
export const SPAWNS: Record<TeamId, { x: number; y: number }[]> = {
  A: [{ x: 11, y: 11 }, { x: 11, y: 17 }],
  B: [{ x: 37, y: 11 }, { x: 37, y: 17 }],
};

/** 동서 대칭 맵 만들기 */
function buildBoxes(): Box[] {
  const b: Box[] = [];
  // 집 (넘을 수 없는 높이)
  for (const t of ["A", "B"] as const) {
    const h = HOUSES[t];
    b.push(box(h.x, h.y, h.size, h.size, h.height, "house", 0, t));
  }
  // 가운데 단상(높이 1.6) + 동서 양쪽 계단 (0.4씩)
  b.push(box(24, 14, 6, 6, 1.6, "platform"));
  for (let i = 0; i < 3; i++) {
    const h = 0.4 * (i + 1);
    b.push(box(19.5 + i * 0.6, 14, 0.6, 3, h, "step")); // 서쪽 계단
    b.push(box(28.5 - i * 0.6, 14, 0.6, 3, h, "step")); // 동쪽 계단
  }
  // 점프로 올라갈 수 있는 상자 (높이 1.0)
  for (const [x, y] of [[15, 6], [15, 22], [33, 6], [33, 22]] as const) b.push(box(x, y, 1.4, 1.4, 1.0, "crate"));
  // 엄폐용 벽 (높이 2.2, 못 넘음)
  b.push(box(24, 4, 5, 0.8, 2.2, "wall"));
  b.push(box(24, 24, 5, 0.8, 2.2, "wall"));
  b.push(box(17, 14, 0.8, 4, 2.2, "wall"));
  b.push(box(31, 14, 0.8, 4, 2.2, "wall"));
  return b;
}

export const BOXES: readonly Box[] = buildBoxes();

/** 집 작업(부수기/수리) 가능 거리: 집 벽면에서 수평 거리 (m) */
export const HOUSE_WORK_DISTANCE = 1.2;
/** 집 작업은 땅 높이 근처에서만 가능 (발 높이가 이 값 이하) */
export const HOUSE_WORK_MAX_FOOT_Z = 0.5;

/** (x, y)에서 해당 팀 집 벽면까지의 수평 거리 (집 안이면 0) */
export function distanceToHouse(team: TeamId, x: number, y: number): number {
  const h = HOUSES[team];
  const half = h.size / 2;
  const dx = Math.max(Math.abs(x - h.x) - half, 0);
  const dy = Math.max(Math.abs(y - h.y) - half, 0);
  return Math.hypot(dx, dy);
}

/** 이 위치에서 해당 팀 집 작업이 가능한 거리인지 (캐릭터 몸 두께 포함) */
export function isNearHouse(team: TeamId, x: number, y: number, z: number): boolean {
  return z <= HOUSE_WORK_MAX_FOOT_Z && distanceToHouse(team, x, y) <= HOUSE_WORK_DISTANCE + PHYS.PLAYER_HALF;
}
