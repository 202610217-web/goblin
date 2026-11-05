// 연습용 더미(봇)의 행동 결정 (순수 함수)
// 서버가 알람으로 가끔(0.4~1초) 깨어나 더미마다 "어디로 갈지, 때릴지, 작업할지"만 정한다.
// 이동 자체는 사람과 같은 물리(shared/sim.ts)로 계산된다.
import { AIM, findAimTarget, inReach } from "../../shared/aim";
import { ARROW } from "../../shared/classes";
import { arrowSegmentHit, makeArrow } from "../../shared/arrow";
import { type Body, radToAngle, withAngle } from "../../shared/sim";
import { type MapId, type SiteId, isNearHouse, isNearSite } from "../../shared/world";
import { COLS, NEON_GRID, NEON_SPAWNS, ROWS, cellAt, cellCenter, isFloorCell } from "../../shared/neon";
import { BOT_CHASE_RANGE_ATTACKER, BOT_CHASE_RANGE_DEFENDER } from "./constants";
import type { Combat } from "./combat";
import type { Phase, Team } from "./protocol";

export interface Point { x: number; y: number }

/** 이번 단계에서 더미가 따라갈 길과, 끝에 도착하면 집 작업을 할지 */
export interface BotPlan {
  waypoints: Point[];
  idx: number;
  hold: boolean;
  /** NEON: 목표 사이트 (작업 거리 판정용) */
  site?: SiteId;
}

/** 맵 가장자리 두 길 (가운데 단상/벽/상자를 피함) */
const LANES = [8.5, 19.5];
/** 집 앞 작업 자리 (집 벽에서 0.7m) */
const HOUSE_FRONT: Record<Team, { x: number; ys: [number, number] }> = {
  A: { x: 9.7, ys: [12.5, 15.5] },
  B: { x: 38.3, ys: [12.5, 15.5] },
};
/** 수비 자리 (자기 집 앞, 집 작업 가능 거리 안) */
const GUARD: Record<Team, { x: number; ys: [number, number] }> = {
  A: { x: 10.4, ys: [12.6, 15.4] },
  B: { x: 37.6, ys: [12.6, 15.4] },
};

/**
 * 단계 시작 때 더미의 계획.
 * - ATTACK 공격팀: 가장자리 길로 상대 집 앞까지 가서 부수기
 * - ATTACK 수비팀: 자기 집 앞에서 지키기
 * - REPAIR 수비팀: 자기 집 앞에서 수리
 * - REPAIR 공격팀: 상대 집 앞으로 가서 수리를 막기(싸우기)
 * slot = 팀 안에서 몇 번째 더미인지 (0/1, 길을 나눠 쓴다)
 */
export function planFor(team: Team, phase: Phase, attackingTeam: Team, slot: number, map: MapId = "CLASSIC", from?: Point): BotPlan {
  const s = slot % 2;
  if (map === "NEON") {
    // 0번은 A, 1번은 B 사이트. 공격팀은 준비 시간에는 대기, 공격 단계에 건물 앞까지 가서 부순다. 수비팀은 그 건물 앞을 지킨다
    const site: SiteId = s === 0 ? "A" : "B";
    const attacker = team === attackingTeam;
    if (attacker && phase !== "ATTACK") return { waypoints: [], idx: 0, hold: false, site };
    const start = from ?? NEON_SPAWNS[attacker ? "atk" : "def"][s]!;
    return { waypoints: neonPath(start, site), idx: 0, hold: attacker, site };
  }
  const attacker = team === attackingTeam;
  const enemy: Team = team === "A" ? "B" : "A";
  if (attacker) {
    const lane = LANES[s]!;
    const goingEast = team === "A";
    const near = goingEast ? 12 : 36;
    const far = goingEast ? 36 : 12;
    const front = HOUSE_FRONT[enemy];
    return {
      waypoints: [{ x: near, y: lane }, { x: far, y: lane }, { x: front.x, y: front.ys[s]! }],
      idx: 0,
      hold: phase === "ATTACK",
    };
  }
  const g = GUARD[team];
  return { waypoints: [{ x: g.x, y: g.ys[s]! }], idx: 0, hold: phase === "REPAIR" };
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
  /** 집 작업 시작 */
  holdStart?: boolean;
  /** 계획의 다음 지점으로 넘어갔는지 */
  advanced?: boolean;
  /** 상대가 가까이 있는지 (다음 생각을 더 빨리) */
  enemyNear: boolean;
}

/**
 * NEON 길 찾기: 바닥 칸 격자에서 사이트 건물 바로 앞 칸까지 가장 짧은 길 (4방향).
 * 꺾이는 칸 가운데만 남긴다 (칸 가운데끼리 직선이면 벽에 걸리지 않음)
 */
export function neonPath(from: Point, site: SiteId): Point[] {
  const start = cellAt(from.x, from.y);
  if (!start) return [];
  const key = (c: number, s: number) => s * COLS + c;
  const prev = new Map<number, number>([[key(start.c, start.s), -1]]);
  const q = [start];
  let goal: { c: number; s: number } | null = null;
  while (q.length && !goal) {
    const cur = q.shift()!;
    for (const [dc, ds] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = cur.c + dc, s = cur.s + ds;
      if (c < 0 || s < 0 || c >= COLS || s >= ROWS || prev.has(key(c, s)) || !isFloorCell(NEON_GRID[s]![c]!)) continue;
      prev.set(key(c, s), key(cur.c, cur.s));
      const p = cellCenter(c, s);
      if (isNearSite(site, p.x, p.y, 0)) { goal = { c, s }; break; }
      q.push({ c, s });
    }
  }
  if (!goal) return [];
  const cells: { c: number; s: number }[] = [];
  for (let k = key(goal.c, goal.s); k !== -1; k = prev.get(k)!) cells.unshift({ c: k % COLS, s: Math.floor(k / COLS) });
  const out: Point[] = [];
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1]!, b = cells[i]!, n = cells[i + 1];
    if (!n || (n.c - b.c) !== (b.c - a.c) || (n.s - b.s) !== (b.s - a.s)) out.push(cellCenter(b.c, b.s));
  }
  return out;
}

/** 계획의 목표(집 또는 사이트 건물) 작업 거리 안인지 */
function nearGoal(plan: BotPlan, attackingTeam: Team, b: Body): boolean {
  return plan.site ? isNearSite(plan.site, b.x, b.y, b.z) : isNearHouse(attackingTeam === "A" ? "B" : "A", b.x, b.y, b.z);
}

const ARRIVE = 0.5;
const angleTo = (from: Point, to: Point) => radToAngle(Math.atan2(to.y - from.y, to.x - from.x));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** 궁수 더미가 쏘는 범위 (사거리 12m보다 조금 짧게) */
export const BOT_ARCHER_RANGE = 10;
const ARCHER_PITCH = 0.1;

/** 궁수 더미: 지금 자리의 target을 화살이 맞히는 조준 (벽에 가리면 null). 리드 없이 현재 위치를 노린다 */
function archerAim(bot: Body, target: Body): { yaw: number; pitch: number } | null {
  const want = Math.atan2(target.y - bot.y, target.x - bot.x);
  let yaw = want;
  // 어깨 카메라라서 화살 방향이 조준 방향과 조금 다르다 → 몇 번 돌려 맞춘다
  for (let i = 0; i < 3; i++) {
    const d = makeArrow(bot, yaw, ARCHER_PITCH, 0).dir;
    yaw += want - Math.atan2(d.y, d.x);
  }
  const arrow = makeArrow(bot, yaw, ARCHER_PITCH, bot.t);
  const still = { id: "t", body: withAngle(target, -1, bot.t) };
  const r = arrowSegmentHit(arrow, bot.t, bot.t + (ARROW.MAX_RANGE / ARROW.SPEED) * 1000, [still]);
  return r.hit ? { yaw, pitch: ARCHER_PITCH } : null;
}

/**
 * 더미 한 명의 이번 행동.
 * 우선순위: 기절/사망이면 정지 → 작업 중이면 계속 → (집 앞이면 작업 시작)
 *   → 지키는 더미만: 사거리 안 적 때리기, 가까운 적 쫓기 → 계획대로 이동
 */
export function decide(
  bot: BotSeen,
  plan: BotPlan,
  enemies: BotSeen[],
  ctx: { phase: Phase; attackingTeam: Team; holding: boolean; canAttack: boolean; ranged: boolean },
): BotDecision {
  if (bot.c.state !== "NORMAL") return { angle: -1, enemyNear: false };
  const attacker = bot.team === ctx.attackingTeam;

  // 가장 가까운 맞힐 수 있는 상대 (높이 차이 포함)
  let target: BotSeen | null = null;
  let best = Infinity;
  for (const e of enemies) {
    if (e.c.state !== "NORMAL" || Math.abs(e.body.z - bot.body.z) > AIM.ATTACK_MAX_HEIGHT_DIFF) continue;
    const d = dist(bot.body, e.body);
    if (d < best) { best = d; target = e; }
  }
  // 작업하러 가는 더미(ATTACK 공격팀, REPAIR 수비팀)는 쫓아가지 않고 작업을 먼저 한다
  const chaseRange = plan.hold ? 0 : attacker ? BOT_CHASE_RANGE_ATTACKER : BOT_CHASE_RANGE_DEFENDER;
  const enemyNear = !!target && best <= Math.max(chaseRange, AIM.ATTACK_RANGE * 2);

  if (ctx.holding) return { angle: -1, enemyNear };

  // 마지막 지점(집 앞)에 도착했고 작업할 차례면, 옆에 적이 있어도 먼저 작업 시작
  const wpNow = plan.waypoints[plan.idx];
  if (plan.hold && wpNow && plan.idx === plan.waypoints.length - 1 && dist(bot.body, wpNow) <= ARRIVE) {
    const myTurn = (ctx.phase === "ATTACK" && attacker) || (ctx.phase === "REPAIR" && !attacker);
    if (myTurn && nearGoal(plan, ctx.attackingTeam, bot.body)) return { angle: -1, holdStart: true, enemyNear };
  }

  // 궁수 더미: 10m 안 적이 보이면 그 자리에서 쏜다
  if (ctx.ranged && ctx.canAttack && !plan.hold && target && best <= BOT_ARCHER_RANGE) {
    const aim = archerAim(bot.body, target.body);
    if (aim) return { angle: -1, attack: aim, enemyNear };
  }
  // 집 작업하러 가는 더미는 싸우지 않고 끝까지 가서 작업만 한다 (사람이 지켜 주거나 막아야 한다)
  if (!plan.hold && target && inReach(bot.body, target.body, AIM.ATTACK_RANGE * 0.9, AIM.ATTACK_MAX_HEIGHT_DIFF)) {
    const yaw = Math.atan2(target.body.y - bot.body.y, target.body.x - bot.body.x);
    // 실제로 조준 광선에 걸릴 때만 때린다 (벽 너머는 못 때림)
    if (ctx.canAttack && findAimTarget(bot.body, yaw, 0.42, [target])) return { angle: -1, attack: { yaw, pitch: 0.42 }, enemyNear };
    return { angle: best > 1.1 ? angleTo(bot.body, target.body) : -1, enemyNear };
  }
  if (target && best <= chaseRange) return { angle: angleTo(bot.body, target.body), enemyNear };

  // 계획대로
  const wp = plan.waypoints[plan.idx];
  if (!wp) return { angle: -1, enemyNear };
  if (dist(bot.body, wp) <= ARRIVE) {
    if (plan.idx < plan.waypoints.length - 1) {
      plan.idx++;
      return { angle: angleTo(bot.body, plan.waypoints[plan.idx]!), advanced: true, enemyNear };
    }
    // 마지막 지점: 작업할 차례면 집 작업 시작
    const canWork = plan.hold && nearGoal(plan, ctx.attackingTeam, bot.body) &&
      ((ctx.phase === "ATTACK" && attacker) || (ctx.phase === "REPAIR" && !attacker));
    return { angle: -1, holdStart: canWork, enemyNear };
  }
  return { angle: angleTo(bot.body, wp), enemyNear };
}

/** 지금 방향으로 계속 걸으면 다음 지점에 도착하는 데 걸리는 시간(ms), 없으면 null */
export function msToWaypoint(body: Point, plan: BotPlan, speed: number): number | null {
  const wp = plan.waypoints[plan.idx];
  if (!wp) return null;
  return (dist(body, wp) / speed) * 1000;
}
