// NEON DISTRICT 맵 데이터. 96m × 56m (기본 맵 48×28의 가로·세로 2배, 면적 4배).
// 2m 칸 격자 하나에서 충돌 상자, 결계, 화면 메시, 미니맵, 더미 길 찾기를 모두 만든다 (보이는 것 = 충돌 = 미니맵).
// 격자 좌표: c = 서→동 칸(0~47), s = 남→북 칸(0~27). 월드 좌표 x = ORIGIN_X + c*2, y = s*2.
//
//  구역: WEST(서쪽 정원 + 공격팀 스폰) | NORTH(북쪽 건물 지구) | CENTRAL(중앙 광장)
//        EAST(동쪽 상가 + 수비팀 스폰) | SOUTH(남쪽 시설: 창고 + B 사이트), A 사이트는 북동쪽

export const NEON_ORIGIN_X = 60;
export const CELL = 2;
export const COLS = 48;
export const ROWS = 28;

/**
 * 칸 종류.
 * . 바닥  a 공격 스폰 바닥  d 수비 스폰 바닥
 * # 건물(6m)  T 높은 건물(9m)  w 벽(2.6m)  h 생울타리(1.5m, 못 넘음)
 * c 나무 상자(1m, 점프로 올라감)  k 짐 더미(상자 2단, 2m)  f 분수(0.8m)  o 나무(가운데 기둥만 충돌)
 * q 화단(1.4m, 엄폐)  j J 콘크리트 방호벽(1.4m, 칸 가운데 얇게: j = 동서로 긴 것, J = 남북으로 긴 것)
 * p 단상(1.6m)  1 2 3 계단(0.4/0.8/1.2m)  ^ v < > 경사로(올라가는 방향, 끝에서 단상 높이)
 * A B 목표 건물(4m)
 * ! 결계(모두 막음)  x 결계(공격팀만)  y 결계(수비팀만) — 준비 시간에만, 바닥은 그대로
 */
type Paint = [ch: string, c0: number, s0: number, c1: number, s1: number];

const PAINT: Paint[] = [
  // ---- WEST: 공격팀 스폰 마당 (출구 3개: 북, 남, 동) ----
  ["w", 0, 17, 5, 17], ["w", 0, 10, 5, 10], ["w", 5, 10, 5, 17],
  ["a", 0, 11, 4, 16],
  ["!", 2, 17, 2, 17], ["!", 3, 10, 3, 10], ["!", 5, 13, 5, 14],
  // 정원: 생울타리, 나무, 계단 달린 정자 단상
  ["h", 7, 21, 11, 21], ["h", 2, 24, 6, 24], ["h", 10, 11, 10, 13], ["h", 6, 5, 6, 8],
  ["o", 7, 18, 7, 18], ["o", 11, 17, 11, 17], ["o", 3, 21, 3, 21], ["o", 4, 26, 4, 26], ["o", 10, 25, 10, 25],
  ["o", 12, 9, 12, 9], ["o", 1, 6, 1, 6], ["o", 4, 2, 4, 2], ["o", 11, 1, 11, 1], ["o", 8, 14, 8, 14],
  ["p", 8, 3, 10, 5], ["3", 8, 6, 10, 6], ["2", 8, 7, 10, 7], ["1", 8, 8, 10, 8],
  // ---- 서쪽 경계 건물 줄 (통로 3개: 북쪽 골목, 중앙길, 남쪽길) ----
  ["#", 13, 25, 15, 27], ["y", 14, 22, 14, 24],
  ["#", 13, 17, 15, 21], ["y", 14, 14, 14, 16],
  ["#", 13, 8, 15, 13], ["y", 14, 5, 14, 7],
  ["#", 13, 0, 15, 4],
  // ---- NORTH: 꺾이는 골목, 높은 길(계단 → 단상 → 계단), 실내 방 ----
  ["T", 16, 25, 20, 27], ["#", 16, 19, 19, 21], ["#", 22, 22, 25, 25],
  ["k", 16, 22, 16, 22], ["c", 19, 22, 19, 22], // 골목 쓰레기·짐 (근접전 엄폐)
  ["1", 23, 26, 23, 27], ["2", 24, 26, 24, 27], ["3", 25, 26, 25, 27],
  ["p", 26, 24, 29, 27],
  ["3", 30, 25, 30, 27], ["2", 31, 25, 31, 27], ["1", 32, 25, 32, 27],
  // 실내 방 (벽 + 문 3개: 서, 동, 남)
  ["w", 26, 19, 30, 19], ["w", 26, 23, 30, 23], ["w", 26, 19, 26, 23], ["w", 30, 19, 30, 23],
  [".", 26, 21, 26, 21], [".", 30, 21, 30, 21], [".", 28, 19, 28, 19],
  // ---- CENTRAL: 광장 (가운데 분수, 경사로 달린 무대). 엄폐 = 분수 둘레 화단 4개 + 출입구 쪽 방호벽 ----
  ["f", 22, 13, 23, 14],
  ["p", 17, 9, 19, 10], ["v", 17, 11, 19, 12],
  ["q", 20, 16, 20, 16], ["q", 25, 16, 25, 16], ["q", 20, 11, 20, 11], ["q", 25, 11, 25, 11],
  ["J", 17, 15, 17, 15], // 서쪽 중앙길에서 나오는 공격팀 엄폐
  ["J", 28, 13, 28, 13], // 시장 거리 쪽 긴 시야 끊기
  ["j", 23, 17, 23, 17], // 실내 방·A 쪽으로 가는 길 엄폐
  // ---- EAST: 상가 건물, 시장 거리 가판대, 수비팀 스폰 ----
  ["#", 32, 15, 35, 18], ["#", 33, 8, 36, 11], ["T", 39, 16, 42, 19], ["#", 39, 7, 42, 10],
  // 시장 거리: 길가(북쪽 줄 s14 / 남쪽 줄 s12)에 번갈아 놓인 가판대 짐 → 지그재그 엄폐
  ["k", 33, 14, 33, 14], ["c", 35, 12, 35, 12], ["k", 39, 14, 39, 14], ["c", 41, 12, 41, 12],
  // 동쪽 수비 통로: 짐 내리는 곳
  ["k", 46, 18, 46, 18], ["c", 44, 9, 44, 9],
  ["d", 44, 12, 47, 15],
  // ---- A 사이트 (북동쪽) ----
  ["w", 32, 20, 35, 20], // 남쪽 담
  ["A", 35, 23, 37, 25],
  // 엄폐: 서쪽 진입 방호벽, 남쪽 골목 출구 방호벽, 가운데 담(수비 거점), 북쪽·동쪽 짐
  ["J", 33, 22, 33, 22], ["j", 37, 21, 37, 21], ["w", 41, 22, 41, 25], ["c", 39, 26, 39, 26], ["k", 45, 24, 45, 24], ["c", 44, 21, 44, 21],
  ["x", 32, 21, 32, 24], ["x", 33, 25, 33, 27], ["x", 36, 20, 38, 20], ["x", 43, 20, 47, 20],
  // ---- SOUTH: 창고(실내, 문 3개), 그 동쪽 B 사이트 ----
  ["w", 17, 0, 17, 5], ["w", 21, 0, 21, 5], ["w", 17, 5, 21, 5], ["w", 17, 0, 21, 0],
  [".", 17, 2, 17, 2], [".", 21, 3, 21, 3], [".", 19, 5, 19, 5],
  ["k", 18, 4, 18, 4], // 창고 안 짐
  ["w", 23, 7, 28, 7], ["w", 32, 7, 36, 7], ["w", 23, 0, 23, 2], // B 사이트 담
  ["B", 29, 2, 31, 4],
  // 시설 마당: 짐 더미·상자, 가운데 담, 북쪽·서쪽 입구 방호벽
  ["k", 26, 4, 26, 4], ["w", 34, 2, 34, 4], ["c", 27, 1, 27, 1], ["k", 40, 3, 40, 3], ["c", 37, 2, 37, 2],
  ["j", 30, 6, 30, 6], ["J", 24, 5, 24, 5],
  ["x", 23, 3, 23, 6], ["x", 29, 7, 31, 7], ["x", 37, 6, 38, 6], ["x", 43, 0, 43, 6],
];

/** grid[s][c] = 칸 종류 */
export const NEON_GRID: readonly string[][] = (() => {
  const g = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => "."));
  for (const [ch, c0, s0, c1, s1] of PAINT) {
    for (let s = s0; s <= s1; s++) for (let c = c0; c <= c1; c++) g[s]![c] = ch;
  }
  return g;
})();

export interface CellRect { ch: string; c0: number; s0: number; c1: number; s1: number }

/** 같은 종류 칸을 큰 직사각형으로 합친다 (상자 수 줄이기) */
export function mergeCells(grid: readonly string[][], keep: (ch: string) => boolean): CellRect[] {
  const used = grid.map((row) => row.map(() => false));
  const out: CellRect[] = [];
  for (let s = 0; s < grid.length; s++) {
    for (let c = 0; c < grid[s]!.length; c++) {
      const ch = grid[s]![c]!;
      if (used[s]![c] || !keep(ch)) continue;
      let c1 = c;
      while (c1 + 1 < grid[s]!.length && grid[s]![c1 + 1] === ch && !used[s]![c1 + 1]) c1++;
      let s1 = s;
      const rowOk = (r: number) => { for (let k = c; k <= c1; k++) if (grid[r]![k] !== ch || used[r]![k]) return false; return true; };
      while (s1 + 1 < grid.length && rowOk(s1 + 1)) s1++;
      for (let r = s; r <= s1; r++) for (let k = c; k <= c1; k++) used[r]![k] = true;
      out.push({ ch, c0: c, s0: s, c1, s1 });
    }
  }
  return out;
}

/** 칸 직사각형 → 월드 좌표 */
export const cellRectToWorld = (r: { c0: number; s0: number; c1: number; s1: number }) => ({
  x0: NEON_ORIGIN_X + r.c0 * CELL, y0: r.s0 * CELL, x1: NEON_ORIGIN_X + (r.c1 + 1) * CELL, y1: (r.s1 + 1) * CELL,
});

/** 칸 가운데의 월드 좌표 */
export const cellCenter = (c: number, s: number) => ({ x: NEON_ORIGIN_X + c * CELL + CELL / 2, y: s * CELL + CELL / 2 });

/** 월드 좌표 → 칸 (맵 밖이면 null) */
export function cellAt(x: number, y: number): { c: number; s: number } | null {
  const c = Math.floor((x - NEON_ORIGIN_X) / CELL), s = Math.floor(y / CELL);
  return c >= 0 && c < COLS && s >= 0 && s < ROWS ? { c, s } : null;
}

/** 걷기만으로 지나갈 수 있는 바닥 칸 (결계 칸은 준비 시간이 끝나면 바닥) */
export const isFloorCell = (ch: string) => ".adxy!".includes(ch);

/** 미니맵/HUD용 구역 */
export const NEON_ZONES = {
  siteA: cellRectToWorld({ c0: 31, s0: 20, c1: 47, s1: 27 }),
  siteB: cellRectToWorld({ c0: 23, s0: 0, c1: 42, s1: 6 }),
  spawnAtk: cellRectToWorld({ c0: 0, s0: 11, c1: 4, s1: 16 }),
  spawnDef: cellRectToWorld({ c0: 44, s0: 12, c1: 47, s1: 15 }),
};

/** 구역 이름표 (미니맵) */
export const NEON_REGIONS: { name: string; x: number; y: number }[] = [
  { name: "WEST", ...cellCenter(6, 19) },
  { name: "NORTH", ...cellCenter(20, 23) },
  { name: "CENTRAL", ...cellCenter(24, 15) },
  { name: "EAST", ...cellCenter(38, 13) },
  { name: "SOUTH", ...cellCenter(19, 6) },
];

/** 역할별 시작 위치 (팀 안 0번, 1번) */
export const NEON_SPAWNS = {
  atk: [cellCenter(2, 13), cellCenter(2, 15)],
  def: [cellCenter(45, 13), cellCenter(45, 14)],
};
