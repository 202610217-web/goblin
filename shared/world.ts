// 서버와 클라이언트가 함께 쓰는 3D 맵 데이터와 이동 물리 수치.
// (같은 값으로 같은 계산을 해야 클라이언트 예측이 서버와 맞기 때문에 shared/ 에 둔다)
// 좌표계: x = 동(오른쪽), y = 북(앞쪽), z = 위. 단위는 미터.

import { NEON_GRID, cellRectToWorld, mergeCells } from "./neon";

export type TeamId = "A" | "B";
/** 맵 종류. 두 맵은 한 좌표 공간에 떨어져 있어서 위치만 보고도 어느 맵인지 안다 */
export type MapId = "CLASSIC" | "NEON";
/** 목표 건물 사이트 (NEON DISTRICT) */
export type SiteId = "A" | "B";

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
  /** 이동(바라보는) 방향 단계 수 (64 = 5.625° 간격) */
  ANGLE_STEPS: 64,
} as const;

/** 축 정렬 상자 (벽, 상자, 계단, 단상, 집) */
export interface Box {
  x0: number; y0: number; x1: number; y1: number;
  /** 바닥 높이, 윗면 높이 */
  z0: number; z1: number;
  kind: "wall" | "crate" | "step" | "platform" | "house" | "building" | "hedge" | "ramp"
    | "cargo" | "planter" | "jersey" | "fountain" | "tree";
  team?: TeamId;
  /** 목표 건물이면 사이트 (NEON) */
  site?: SiteId;
}

/** 맵 목록: 이름, 경계(월드 좌표). 이 밖으로는 못 나간다 */
export const MAPS: Record<MapId, { name: string; x0: number; y0: number; x1: number; y1: number }> = {
  CLASSIC: { name: "기본 맵", x0: 0, y0: 0, x1: 48, y1: 28 },
  NEON: { name: "NEON DISTRICT", x0: 60, y0: 0, x1: 156, y1: 56 },
};
export const isMapId = (x: unknown): x is MapId => x === "CLASSIC" || x === "NEON";
/** 이 x 위치가 어느 맵인지 (두 맵 사이 빈 공간의 가운데로 나눈다) */
export const mapAt = (x: number): MapId => (x >= 54 ? "NEON" : "CLASSIC");

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

/** NEON 칸 종류 → 충돌 상자 종류와 높이 */
const NEON_CELL: Record<string, { kind: Box["kind"]; h: number }> = {
  "#": { kind: "building", h: 6 }, T: { kind: "building", h: 9 }, w: { kind: "wall", h: 2.6 }, h: { kind: "hedge", h: 1.5 },
  c: { kind: "crate", h: 1 }, k: { kind: "cargo", h: 2 }, f: { kind: "fountain", h: 0.8 }, p: { kind: "platform", h: 1.6 },
  q: { kind: "planter", h: 1.4 },
  "1": { kind: "step", h: 0.4 }, "2": { kind: "step", h: 0.8 }, "3": { kind: "step", h: 1.2 },
  A: { kind: "house", h: 4 }, B: { kind: "house", h: 4 },
};
/** 경사로 끝 높이 (단상과 같음), 칸 하나를 나누는 조각 수 (조각마다 0.1m씩 올라감 → 걸어서 오름) */
const RAMP_TOP = 1.6, RAMP_SLICES_PER_CELL = 8;

function buildNeon(): Box[] {
  const out: Box[] = [];
  for (const r of mergeCells(NEON_GRID, (ch) => ch in NEON_CELL)) {
    const k = NEON_CELL[r.ch]!;
    out.push({ ...cellRectToWorld(r), z0: 0, z1: k.h, kind: k.kind, site: r.ch === "A" || r.ch === "B" ? r.ch : undefined });
  }
  // 나무: 칸 가운데 기둥만 막힌다 (잎은 화면 장식)
  for (const r of mergeCells(NEON_GRID, (ch) => ch === "o")) {
    for (let s = r.s0; s <= r.s1; s++) for (let c = r.c0; c <= r.c1; c++) {
      const w = cellRectToWorld({ c0: c, s0: s, c1: c, s1: s });
      out.push(box((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, 0.7, 0.7, 3, "tree"));
    }
  }
  // 방호벽: 칸 가운데 두께 0.7m, 높이 1.4m (가슴 높이 화살을 막고, 점프로 못 넘음)
  for (const r of mergeCells(NEON_GRID, (ch) => ch === "j" || ch === "J")) {
    const w = cellRectToWorld(r);
    const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
    out.push(r.ch === "j" ? box(cx, cy, w.x1 - w.x0, 0.7, 1.4, "jersey") : box(cx, cy, 0.7, w.y1 - w.y0, 1.4, "jersey"));
  }
  // 경사로: 올라가는 방향으로 얇은 조각을 조금씩 높게 쌓는다 (물리는 상자만 알아서)
  for (const r of mergeCells(NEON_GRID, (ch) => "^v<>".includes(ch))) {
    const w = cellRectToWorld(r);
    const alongY = r.ch === "^" || r.ch === "v";
    const len = alongY ? w.y1 - w.y0 : w.x1 - w.x0;
    const n = (len / 2) * RAMP_SLICES_PER_CELL, d = len / n;
    for (let i = 0; i < n; i++) {
      const z1 = (RAMP_TOP * (i + 1)) / n;
      const b: Box = { ...w, z0: 0, z1, kind: "ramp" };
      if (r.ch === "^") { b.y0 = w.y0 + i * d; b.y1 = b.y0 + d; }
      if (r.ch === "v") { b.y1 = w.y1 - i * d; b.y0 = b.y1 - d; }
      if (r.ch === ">") { b.x0 = w.x0 + i * d; b.x1 = b.x0 + d; }
      if (r.ch === "<") { b.x1 = w.x1 - i * d; b.x0 = b.x1 - d; }
      out.push(b);
    }
  }
  return out;
}

/** 맵별 충돌 상자 (물리는 자기 맵 상자만 본다) */
export const BOXES_BY_MAP: Record<MapId, readonly Box[]> = { CLASSIC: buildBoxes(), NEON: buildNeon() };
/** 모든 맵의 상자 (조준/화살/카메라 광선: 다른 맵은 멀리 떨어져 있어 영향 없음) */
export const BOXES: readonly Box[] = [...BOXES_BY_MAP.CLASSIC, ...BOXES_BY_MAP.NEON];

/** 결계를 받는 역할 */
export type BarrierRole = "atk" | "def";
/** 준비 시간 결계 (NEON). role: all = 모두 막음, atk/def = 그 역할만 막음 */
export interface Barrier { x0: number; y0: number; x1: number; y1: number; role: "all" | BarrierRole }
export const BARRIERS: readonly Barrier[] = mergeCells(NEON_GRID, (ch) => "!xy".includes(ch)).map((r) => ({
  ...cellRectToWorld(r),
  role: r.ch === "!" ? "all" : r.ch === "x" ? "atk" : "def",
}));
/** 결계 높이 (화면 표시용. 물리에서는 높이 없이 무조건 막음) */
export const BARRIER_HEIGHT = 5;

/** NEON 목표 건물 (사이트별) */
export const SITES = Object.fromEntries(
  BOXES_BY_MAP.NEON.filter((b) => b.site).map((b) => [b.site, b]),
) as Record<SiteId, Box>;

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

/** (x, y)에서 사이트 목표 건물 벽면까지의 수평 거리 */
export function distanceToSite(site: SiteId, x: number, y: number): number {
  const b = SITES[site];
  return Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
}

/** 이 위치에서 사이트 건물 작업(부수기)이 가능한 거리인지 (집 작업과 같은 거리 규칙) */
export function isNearSite(site: SiteId, x: number, y: number, z: number): boolean {
  return z <= HOUSE_WORK_MAX_FOOT_Z && distanceToSite(site, x, y) <= HOUSE_WORK_DISTANCE + PHYS.PLAYER_HALF;
}

/** 이 위치에서 해당 팀 집 작업이 가능한 거리인지 (캐릭터 몸 두께 포함) */
export function isNearHouse(team: TeamId, x: number, y: number, z: number): boolean {
  return z <= HOUSE_WORK_MAX_FOOT_Z && distanceToHouse(team, x, y) <= HOUSE_WORK_DISTANCE + PHYS.PLAYER_HALF;
}
