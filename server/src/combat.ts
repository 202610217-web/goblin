// 전투 규칙 (순수 함수): 체력, 타격, 기절, 사망, 치유, 전멸
import {
  ATTACK_COOLDOWN_MS,
  DOWN_TO_DEATH_MS,
  HIT_DAMAGE,
  MAX_HP,
  REVIVE_HP_RATIO,
  REVIVE_INVULN_MS,
  REVIVE_TIME_MS,
} from "./constants";
import type { Phase, Team } from "./protocol";
import { type WorkState, stopHold } from "./work";

export type LifeState = "NORMAL" | "DOWNED" | "DEAD";

export interface Combat {
  hp: number;
  state: LifeState;
  /** 기절했을 때 사망 예정 시각 (서버 ms), 아니면 null */
  deathAt: number | null;
  /** 이 시각 전까지는 맞지 않는다 (부활 후 무적) */
  invulnUntil: number;
  /** 마지막 타격 시각 (쿨다운 계산) */
  lastAttackAt: number;
  /** 점수판용: 이번 경기 누적 기절/사망 횟수 */
  downs: number;
  deaths: number;
  /** 치유 중이면 대상 id와 완료 예정 시각 */
  revive: { target: string; endsAt: number } | null;
}

/** 경기 시작 시 상태 */
export function newCombat(maxHp = MAX_HP): Combat {
  return { hp: maxHp, state: "NORMAL", deathAt: null, invulnUntil: 0, lastAttackAt: 0, downs: 0, deaths: 0, revive: null };
}

/** 라운드 시작: 체력/상태 초기화 (사망자도 부활). 누적 기절/사망 횟수는 유지 */
export function resetForRound(c: Combat, maxHp = MAX_HP): Combat {
  return { ...newCombat(maxHp), downs: c.downs, deaths: c.deaths };
}

/** 전투가 가능한 단계 */
export function isCombatPhase(phase: Phase): boolean {
  return phase === "ATTACK" || phase === "REPAIR";
}

/** 맞을 수 있는 상태인지 (정상이고 무적 시간이 아님) */
export function isHittable(c: Combat, now: number): boolean {
  return c.state === "NORMAL" && now >= c.invulnUntil;
}

export type AttackRejectReason = "wrong_phase" | "not_normal" | "busy" | "cooldown";

/** 타격 가능 여부. busy = 집 작업 중이거나 치유 중 */
export function checkAttack(c: Combat, phase: Phase, busy: boolean, now: number, cooldownMs = ATTACK_COOLDOWN_MS): AttackRejectReason | null {
  if (!isCombatPhase(phase)) return "wrong_phase";
  if (c.state !== "NORMAL") return "not_normal";
  if (busy || c.revive) return "busy";
  if (now - c.lastAttackAt < cooldownMs) return "cooldown";
  return null;
}

/**
 * 맞았을 때. 기절/사망/무적 상태면 아무 일도 없다.
 * 체력이 0이 되면 기절하고 사망 타이머(20초)가 시작된다.
 */
export function applyHit(c: Combat, now: number, damage = HIT_DAMAGE): Combat {
  if (!isHittable(c, now)) return c;
  const hp = Math.max(0, c.hp - damage);
  if (hp > 0) return { ...c, hp };
  return { ...c, hp: 0, state: "DOWNED", deathAt: now + DOWN_TO_DEATH_MS, downs: c.downs + 1, revive: null };
}

/** 사망 타이머 만료: 아직 기절 상태면 사망 */
export function applyDeath(c: Combat): Combat {
  if (c.state !== "DOWNED") return c;
  return { ...c, state: "DEAD", deathAt: null, deaths: c.deaths + 1 };
}

export type ReviveRejectReason = "wrong_phase" | "not_normal" | "busy" | "no_target";

/** 치유 시작 검증. target = 근처의 기절한 같은 팀원 (없으면 null) */
export function checkReviveStart(reviver: Combat, phase: Phase, busy: boolean, target: Combat | null): ReviveRejectReason | null {
  if (!isCombatPhase(phase)) return "wrong_phase";
  if (reviver.state !== "NORMAL") return "not_normal";
  if (busy || reviver.revive) return "busy";
  if (!target || target.state !== "DOWNED") return "no_target";
  return null;
}

/** 치유 시작: 완료 예정 시각을 기록 (사망 타이머는 멈추지 않는다) */
export function startRevive(reviver: Combat, targetId: string, now: number): Combat {
  return { ...reviver, revive: { target: targetId, endsAt: now + REVIVE_TIME_MS } };
}

/** 치유 중단 (진행률은 0으로 초기화 = 기록 삭제) */
export function stopRevive(reviver: Combat): Combat {
  return reviver.revive ? { ...reviver, revive: null } : reviver;
}

/** 치유 완료: 기절한 대상이 최대 체력의 30%로 정상 복귀 + 무적 */
export function completeRevive(target: Combat, now: number, maxHp = MAX_HP): Combat {
  if (target.state !== "DOWNED") return target;
  return {
    ...target,
    state: "NORMAL",
    hp: Math.max(1, Math.round(maxHp * REVIVE_HP_RATIO)),
    deathAt: null,
    invulnUntil: now + REVIVE_INVULN_MS,
  };
}

/** 팀 전멸: 팀원이 있고 전원이 기절 또는 사망 (치유해 줄 사람이 없음) */
export function isTeamWiped(members: Combat[]): boolean {
  return members.length > 0 && members.every((c) => c.state !== "NORMAL");
}

/**
 * 전멸로 라운드가 끝나는지 판단. 이긴 팀을 돌려주고, 끝나지 않으면 null.
 * (기본 규칙: ATTACK 중 공격팀 전멸 → 수비팀 승, REPAIR 중 수비팀 전멸 → 공격팀 승. 반대쪽 전멸은 계속 진행)
 * 승점 반영은 5단계 점수 판정 함수에서 한다.
 */
export function wipeWinner(phase: Phase, attackingTeam: Team, teams: Record<Team, Combat[]>): Team | null {
  const defendingTeam: Team = attackingTeam === "A" ? "B" : "A";
  if (phase === "ATTACK" && isTeamWiped(teams[attackingTeam])) return defendingTeam;
  if (phase === "REPAIR" && isTeamWiped(teams[defendingTeam])) return attackingTeam;
  return null;
}

/**
 * 타격 결과를 집 작업과 함께 계산: 맞아도 작업은 계속되고, 기절하면 그 사람의 작업만 중단된다.
 */
export function resolveHit(target: Combat, targetId: string, work: WorkState, now: number): { c: Combat; work: WorkState } {
  const c = applyHit(target, now);
  const w = c.state === "DOWNED" ? stopHold(work, targetId, now) : work;
  return { c, work: w };
}
