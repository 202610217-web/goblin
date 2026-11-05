import { describe, expect, it } from "vitest";
import { COLS, NEON_GRID, NEON_SPAWNS, ROWS, cellAt, cellCenter, isFloorCell } from "../../shared/neon";
import { type Body, groundHeightAt, makeBody, radToAngle, simulate, withAngle, withJump } from "../../shared/sim";
import { arrowSegmentHit, makeArrow } from "../../shared/arrow";
import { MAPS, PHYS, SITES, type SiteId, mapAt } from "../../shared/world";

/** 격자 길 찾기: 바닥 칸끼리 4방향. blocked(ch)면 못 지나감. 닿은 칸 집합("c,s") */
function reach(from: { c: number; s: number }, blocked: (ch: string) => boolean = () => false): Set<string> {
  const seen = new Set([`${from.c},${from.s}`]);
  const q = [from];
  while (q.length) {
    const { c, s } = q.shift()!;
    for (const [dc, ds] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc!, ns = s + ds!;
      if (nc < 0 || ns < 0 || nc >= COLS || ns >= ROWS) continue;
      const ch = NEON_GRID[ns]![nc]!;
      const k = `${nc},${ns}`;
      if (seen.has(k) || !isFloorCell(ch) || blocked(ch)) continue;
      seen.add(k);
      q.push({ c: nc, s: ns });
    }
  }
  return seen;
}
const cellOf = (p: { x: number; y: number }) => cellAt(p.x, p.y)!;
/** A/B 건물 바로 옆(1.6m 안) 바닥 칸들 */
function siteFront(site: SiteId): string[] {
  const b = SITES[site], out: string[] = [];
  for (let s = 0; s < ROWS; s++) for (let c = 0; c < COLS; c++) {
    const p = cellCenter(c, s);
    if (isFloorCell(NEON_GRID[s]![c]!) && Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1)) <= 1.6) out.push(`${c},${s}`);
  }
  return out;
}
/** 한 방향으로 ms 동안 걷기 */
const walk = (b: Body, rad: number, ms: number) => simulate(withAngle(b, radToAngle(rad), b.t), b.t + ms);
const E = 0, N = Math.PI / 2, W = Math.PI, S = -Math.PI / 2;

describe("NEON DISTRICT 맵", () => {
  it("기본 맵보다 가로·세로 2배, 면적 4배", () => {
    const c = MAPS.CLASSIC, n = MAPS.NEON;
    expect((n.x1 - n.x0) / (c.x1 - c.x0)).toBe(2);
    expect((n.y1 - n.y0) / (c.y1 - c.y0)).toBe(2);
    expect(mapAt(n.x0 + 1)).toBe("NEON");
    expect(mapAt(c.x1 - 1)).toBe("CLASSIC");
  });

  it("모든 바닥 칸이 하나로 이어져 있다 (끊긴 구역 없음)", () => {
    const all = reach(cellOf(NEON_SPAWNS.A[0]!));
    let floor = 0;
    for (let s = 0; s < ROWS; s++) for (let c = 0; c < COLS; c++) if (isFloorCell(NEON_GRID[s]![c]!)) floor++;
    expect(all.size).toBe(floor);
  });

  it("두 사이트 건물 앞까지 걸어서 갈 수 있고, A와 B는 충분히 떨어져 있다", () => {
    const all = reach(cellOf(NEON_SPAWNS.A[0]!));
    for (const site of ["A", "B"] as const) expect(siteFront(site).some((k) => all.has(k))).toBe(true);
    const a = SITES.A, b = SITES.B;
    expect(Math.hypot((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2, (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)).toBeGreaterThan(35);
  });

  it("A팀 스폰에서 각 건물로 가는 길이 여러 개 (서쪽 경계의 통로 3개 중 하나를 막아도 갈 수 있다)", () => {
    const gates = [[14, 23], [14, 15], [14, 6]] as const; // 북쪽 골목, 중앙길, 남쪽길
    for (const [gc, gs] of gates) {
      // 그 통로 칸만 막고 길 찾기
      const blocked = new Set<string>();
      for (let s = gs - 1; s <= gs + 1; s++) blocked.add(`${gc},${s}`);
      const seen = new Set([`${cellOf(NEON_SPAWNS.A[0]!).c},${cellOf(NEON_SPAWNS.A[0]!).s}`]);
      const q = [cellOf(NEON_SPAWNS.A[0]!)];
      while (q.length) {
        const { c, s } = q.shift()!;
        for (const [dc, ds] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = c + dc!, ns = s + ds!, k = `${nc},${ns}`;
          if (nc < 0 || ns < 0 || nc >= COLS || ns >= ROWS || seen.has(k) || blocked.has(k) || !isFloorCell(NEON_GRID[ns]![nc]!)) continue;
          seen.add(k); q.push({ c: nc, s: ns });
        }
      }
      for (const site of ["A", "B"] as const) expect(siteFront(site).some((k) => seen.has(k))).toBe(true);
    }
  });

  it("스폰 위치는 바닥이고 A·B팀 스폰은 멀리 떨어져 있다", () => {
    for (const p of [...NEON_SPAWNS.A, ...NEON_SPAWNS.B]) {
      expect(groundHeightAt(p.x, p.y, 0)).toBe(0);
      expect(isFloorCell(NEON_GRID[cellOf(p).s]![cellOf(p).c]!)).toBe(true);
    }
    expect(NEON_SPAWNS.B[0]!.x - NEON_SPAWNS.A[0]!.x).toBeGreaterThan(70);
  });

  it("맵 밖으로 나갈 수 없다 (북쪽 끝까지 걸어도 경계 안)", () => {
    const b = walk(makeBody(cellCenter(12, 20).x, cellCenter(12, 20).y, 0), N, 10_000);
    expect(b.y).toBeCloseTo(MAPS.NEON.y1 - PHYS.PLAYER_HALF, 3);
    const w = walk(makeBody(cellCenter(2, 20).x, cellCenter(2, 20).y, 0), W, 5_000);
    expect(w.x).toBeCloseTo(MAPS.NEON.x0 + PHYS.PLAYER_HALF, 3);
  });

  it("건물을 통과하지 못한다 (동쪽 상가 건물 앞에서 멈춤)", () => {
    // 시장 거리(s=13)에서 북쪽 E1 건물(c 32~35, s 15~18)로 걸어가기 (c 33은 가판대 자리라 c 34)
    const start = cellCenter(34, 13);
    const b = walk(makeBody(start.x, start.y, 0), N, 3_000);
    expect(b.y).toBeCloseTo(15 * 2 - PHYS.PLAYER_HALF, 3);
  });

  it("방호벽은 가슴 높이 화살을 막고, 걸어서는 못 넘지만 뛰면 타고 넘는다 (파쿠르)", () => {
    // 광장 시장 쪽 방호벽 J (c 28, s 13): 서쪽에서 동쪽으로 쏜 화살은 벽에서 멈춘다
    const wall = cellCenter(28, 13);
    const shooter = makeBody(wall.x - 5, wall.y, 0);
    const arrow = makeArrow(shooter, 0, 0.1, 0);
    const behind = { id: "e", body: makeBody(wall.x + 2, wall.y, 0) };
    let hit = null;
    for (let t = 0; t < 1000 && !hit; t += 50) {
      const r = arrowSegmentHit(arrow, t, t + 50, [behind]);
      hit = r.hit;
      if (r.stopped) break;
    }
    expect(hit).toBeNull();
    // 걷기만 하면 벽 앞에서 멈춘다
    expect(walk(makeBody(wall.x - 2, wall.y, 0), E, 1500).x).toBeLessThan(wall.x);
    // 뛰면서 부딪히면 위로 올라섰다가 반대편으로 내려간다
    let b = withAngle(makeBody(wall.x - 2, wall.y, 0), 0, 0);
    b = withJump(b, 50)!;
    b = simulate(b, 1500);
    expect(b.x).toBeGreaterThan(wall.x + 1);
  });

  it("파쿠르: 2m 짐 더미 위로 올라설 수 있다", () => {
    const cargo = cellCenter(45, 24); // A 사이트 동쪽 짐 더미 (높이 2m)
    let b = withAngle(makeBody(cargo.x - 2.2, cargo.y, 0), 0, 0);
    b = withJump(b, 120)!; // 상자 앞에서 뛰기
    b = simulate(b, 500);
    expect(b.z).toBeCloseTo(2, 3);
  });

  it("실내 방: 서쪽 문으로 들어가 동쪽 문으로 나간다", () => {
    const start = cellCenter(24, 21);
    const b = walk(makeBody(start.x, start.y, 0), E, 3_000); // 12m 동쪽
    expect(b.x).toBeGreaterThan(cellCenter(31, 21).x);
  });

  it("경사로를 걸어 올라 무대(1.6m) 위에 선다", () => {
    const start = cellCenter(18, 13);
    const b = walk(makeBody(start.x, start.y, 0), S, 1_200);
    expect(b.z).toBeCloseTo(1.6, 3);
  });

  it("계단으로 높은 길(1.6m)에 올라갔다가 반대쪽 계단으로 A 사이트에 내려간다", () => {
    const start = cellCenter(22, 26);
    const top = walk(makeBody(start.x, start.y, 0), E, 1_500);
    expect(top.z).toBeCloseTo(1.6, 3);
    const down = walk(top, E, 2_500);
    expect(down.z).toBe(0);
    expect(down.x).toBeGreaterThan(cellCenter(33, 26).x);
  });
});
