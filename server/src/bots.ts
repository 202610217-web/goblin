// 연습용 더미(봇)의 행동 결정 (순수 함수)
// 서버가 알람으로 가끔(0.4~1초) 깨어나 더미마다 "어디로 갈지, 때릴지"만 정한다.
// 이동 자체는 사람과 같은 물리(shared/sim.ts)로 계산된다.
import { AIM, findAimTarget, inReach } from "../../shared/aim";
import type { Projectile } from "../../shared/classes";
import { arrowSegmentHit, makeArrow } from "../../shared/arrow";
import { type Body, radToAngle, withAngle } from "../../shared/sim";
import { MAPS, type MapId, SPAWNS } from "../../shared/world";
import { COLS, NEON_GRID, NEON_SPAWNS, ROWS, cellAt, cellCenter, isFloorCell } from "../../shared/neon";
import { BOT_CHASE_RANGE } from "./constants";
import type { Combat } from "./combat";
import type { Team } from "./protocol";

export interface Point { x: number; y: number }

/** 더미가 따라갈 순찰 길. back = 지금 자기 진영 쪽으로 돌아가는 길인지 (끝나면 반대로 다시 짠다) */
export interface BotPlan {
  waypoints: Point[];
  idx: number;
  back?: boolean;
}

/** 기본 맵 가장자리 두 길 (가운데 단상/벽/상자를 피함) */
const LANES = [8.5, 19.5];

/**
 * 순찰 계획: 상대 진영으로 가는 길(back=false) 또는 맵 가운데로 돌아오는 길(back=true).
 * slot = 팀 안에서 몇 번째 더미인지 (0/1, 길을 나눠 쓴다)
 */
export function planFor(team: Team, slot: number, map: MapId, from: Point, back = false): BotPlan {
  const s = slot % 2;
  const enemy: Team = team === "A" ? "B" : "A";
  if (map === "NEON") {
    const m = MAPS.NEON;
    const goal = back ? { x: (m.x0 + m.x1) / 2, y: s === 0 ? 34 : 22 } : NEON_SPAWNS[enemy][s]!;
    return { waypoints: neonPath(from, goal), idx: 0, back };
  }
  const lane = LANES[s]!;
  const east = (team === "A") !== back; // A팀은 동쪽이 상대 진영
  const goal = back ? { x: 24, y: lane } : SPAWNS[enemy][s]!;
  return { waypoints: [{ x: east ? 14 : 34, y: lane }, { x: east ? 34 : 14, y: lane }, goal], idx: 0, back };
}

export interface BotSeen {
  id: string;
  team: Team;
  /** 지금 시각의 물리 상태 */
  body: Body;
  c: Combat;
}

export interface BotDecision {
  /** 이동 각도 (-1 = 정지) */
  angle: number;
  /** 때리기 (카메라 방향처럼 yaw/pitch) */
  attack?: { yaw: number; pitch: number };
  /** 계획의 다음 지점으로 넘어갔는지 */
  advanced?: boolean;
  /** 길 끝에 도착 (반대 방향으로 새 계획이 필요) */
  arrived?: boolean;
  /** 상대가 가까이 있는지 (다음 생각을 더 빨리) */
  enemyNear: boolean;
}

/**
 * NEON 길 찾기: 바닥 칸 격자에서 goal이 있는 칸까지 가장 짧은 길 (4방향).
 * 꺾이는 칸 가운데만 남긴다 (칸 가운데끼리 직선이면 벽에 걸리지 않음)
 */
export function neonPath(from: Point, goal: Point): Point[] {
  const start = cellAt(from.x, from.y), end = cellAt(goal.x, goal.y);
  if (!start || !end) return [];
  const key = (c: number, s: number) => s * COLS + c;
  const prev = new Map<number, number>([[key(start.c, start.s), -1]]);
  const q = [start];
  let found = start.c === end.c && start.s === end.s;
  while (q.length && !found) {
    const cur = q.shift()!;
    for (const [dc, ds] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = cur.c + dc, s = cur.s + ds;
      if (c < 0 || s < 0 || c >= COLS || s >= ROWS || prev.has(key(c, s)) || !isFloorCell(NEON_GRID[s]![c]!)) continue;
      prev.set(key(c, s), key(cur.c, cur.s));
      if (c === end.c && s === end.s) { found = true; break; }
      q.push({ c, s });
    }
  }
  if (!found) return [];
  const cells: { c: number; s: number }[] = [];
  for (let k = key(end.c, end.s); k !== -1; k = prev.get(k)!) cells.unshift({ c: k % COLS, s: Math.floor(k / COLS) });
  const out: Point[] = [];
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1]!, b = cells[i]!, n = cells[i + 1];
    if (!n || (n.c - b.c) !== (b.c - a.c) || (n.s - b.s) !== (b.s - a.s)) out.push(cellCenter(b.c, b.s));
  }
  return out;
}

const ARRIVE = 0.5;
const angleTo = (from: Point, to: Point) => radToAngle(Math.atan2(to.y - from.y, to.x - from.x));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** 원거리 더미가 쏘는 범위 = 사거리보다 이만큼 짧게 */
const BOT_RANGE_MARGIN = 2;
const ARCHER_PITCH = 0.1;

/** 궁수 더미: 지금 자리의 target을 화살이 맞히는 조준 (벽에 가리면 null). 리드 없이 현재 위치를 노린다 */
function archerAim(bot: Body, target: Body, proj: Projectile): { yaw: number; pitch: number } | null {
  const want = Math.atan2(target.y - bot.y, target.x - bot.x);
  let yaw = want;
  // 어깨 카메라라서 화살 방향이 조준 방향과 조금 다르다 → 몇 번 돌려 맞춘다
  for (let i = 0; i < 3; i++) {
    const d = makeArrow(bot, yaw, ARCHER_PITCH, 0, proj).dir;
    yaw += want - Math.atan2(d.y, d.x);
  }
  const arrow = makeArrow(bot, yaw, ARCHER_PITCH, bot.t, proj);
  const still = { id: "t", body: withAngle(target, -1, bot.t) };
  const r = arrowSegmentHit(arrow, bot.t, bot.t + (proj.range / proj.speed) * 1000, [still]);
  return r.hit ? { yaw, pitch: ARCHER_PITCH } : null;
}

/**
 * 더미 한 명의 이번 행동.
 * 우선순위: 죽었으면 정지 → (궁수) 사거리 안 적 쏘기 → 손 닿는 적 때리기 → 가까운 적 쫓기 → 순찰
 * shortcut: 쫓을 때는 곧장 걸어가서 벽에 막힐 수 있음, 더미가 자주 끼면 쫓을 때도 길 찾기 사용
 */
export function decide(bot: BotSeen, plan: BotPlan, enemies: BotSeen[], ctx: { canAttack: boolean; proj: Projectile | null }): BotDecision {
  if (bot.c.state !== "NORMAL") return { angle: -1, enemyNear: false };

  // 가장 가까운 살아 있는 상대 (높이 차이 포함). 보이지 않는(은신) 상대는 부르는 쪽에서 뺀다
  let target: BotSeen | null = null;
  let best = Infinity;
  for (const e of enemies) {
    if (e.c.state !== "NORMAL" || Math.abs(e.body.z - bot.body.z) > AIM.ATTACK_MAX_HEIGHT_DIFF) continue;
    const d = dist(bot.body, e.body);
    if (d < best) { best = d; target = e; }
  }
  const enemyNear = !!target && best <= BOT_CHASE_RANGE;

  if (target && ctx.proj && ctx.canAttack && best <= ctx.proj.range - BOT_RANGE_MARGIN) {
    const aim = archerAim(bot.body, target.body, ctx.proj);
    if (aim) return { angle: -1, attack: aim, enemyNear };
  }
  if (target && inReach(bot.body, target.body, AIM.ATTACK_RANGE * 0.9, AIM.ATTACK_MAX_HEIGHT_DIFF)) {
    const yaw = Math.atan2(target.body.y - bot.body.y, target.body.x - bot.body.x);
    // 실제로 판정에 걸릴 때만 때린다 (벽 너머는 못 때림)
    if (ctx.canAttack && findAimTarget(bot.body, yaw, 0.42, [target])) return { angle: -1, attack: { yaw, pitch: 0.42 }, enemyNear };
    return { angle: best > 1.1 ? angleTo(bot.body, target.body) : -1, enemyNear };
  }
  if (target && enemyNear) return { angle: angleTo(bot.body, target.body), enemyNear };

  // 순찰
  const wp = plan.waypoints[plan.idx];
  if (!wp) return { angle: -1, arrived: true, enemyNear };
  if (dist(bot.body, wp) <= ARRIVE) {
    if (plan.idx >= plan.waypoints.length - 1) return { angle: -1, arrived: true, enemyNear };
    plan.idx++;
    return { angle: angleTo(bot.body, plan.waypoints[plan.idx]!), advanced: true, enemyNear };
  }
  return { angle: angleTo(bot.body, wp), enemyNear };
}

/** 지금 방향으로 계속 걸으면 다음 지점에 도착하는 데 걸리는 시간(ms), 없으면 null */
export function msToWaypoint(body: Point, plan: BotPlan, speed: number): number | null {
  const wp = plan.waypoints[plan.idx];
  if (!wp) return null;
  return (dist(body, wp) / speed) * 1000;
}
