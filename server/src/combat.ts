// 전투 규칙 (순수 함수): 체력, 타격, 사망과 부활, 고블린 은신·뒤치기
import { ATTACK_COOLDOWN_MS, HIT_DAMAGE, MAX_HP, RESPAWN_INVULN_MS, RESPAWN_MS } from "./constants";
import { STEALTH } from "../../shared/classes";
import type { Phase } from "./protocol";

export type LifeState = "NORMAL" | "DEAD";

export interface Combat {
  hp: number;
  state: LifeState;
  /** 죽었을 때 부활 예정 시각 (서버 ms), 아니면 null */
  respawnAt: number | null;
  /** 이 시각 전까지는 맞지 않는다 (부활 직후 무적) */
  invulnUntil: number;
  /** 마지막 타격 시각 (쿨다운 계산) */
  lastAttackAt: number;
  /** 점수판용: 이번 경기 킬/데스 */
  kills: number;
  deaths: number;
  /** 고블린 은신이 끝나는 시각 / 다시 쓸 수 있는 시각 (예전에 저장된 방에는 없을 수 있음) */
  stealthUntil?: number;
  stealthReadyAt?: number;
  /** 직업 스킬이 끝나는 시각 / 다시 쓸 수 있는 시각 */
  skillUntil?: number;
  skillReadyAt?: number;
}

/** 경기 시작 시 상태 */
export function newCombat(maxHp = MAX_HP): Combat {
  return { hp: maxHp, state: "NORMAL", respawnAt: null, invulnUntil: 0, lastAttackAt: 0, kills: 0, deaths: 0 };
}

/** 전투가 가능한 단계 */
export function isCombatPhase(phase: Phase): boolean {
  return phase === "PLAY";
}

/** 스킬 사용: 살아 있고 쿨타임이 끝났으면 durationMs 동안 켜고, 그 뒤 cooldownMs 쿨타임 (안 되면 그대로) */
export function startSkill(c: Combat, now: number, durationMs: number, cooldownMs: number): Combat {
  if (c.state !== "NORMAL" || now < (c.skillReadyAt ?? 0)) return c;
  return { ...c, skillUntil: now + durationMs, skillReadyAt: now + cooldownMs };
}

/** 맞을 수 있는 상태인지 (살아 있고 무적 시간이 아님) */
export function isHittable(c: Combat, now: number): boolean {
  return c.state === "NORMAL" && now >= c.invulnUntil;
}

export type AttackRejectReason = "wrong_phase" | "not_normal" | "cooldown";

/** 타격 가능 여부 */
export function checkAttack(c: Combat, phase: Phase, now: number, cooldownMs = ATTACK_COOLDOWN_MS): AttackRejectReason | null {
  if (!isCombatPhase(phase)) return "wrong_phase";
  if (c.state !== "NORMAL") return "not_normal";
  if (now - c.lastAttackAt < cooldownMs) return "cooldown";
  return null;
}

/**
 * 맞았을 때. 죽었거나 무적이면 아무 일도 없다.
 * 체력이 0이 되면 바로 죽고(은신도 풀림) RESPAWN_MS 뒤 부활 예정
 */
export function applyHit(c: Combat, now: number, damage = HIT_DAMAGE): Combat {
  if (!isHittable(c, now)) return c;
  const hp = Math.max(0, c.hp - damage);
  if (hp > 0) return { ...c, hp };
  return { ...endStealth(c, now), skillUntil: Math.min(c.skillUntil ?? 0, now), hp: 0, state: "DEAD", respawnAt: now + RESPAWN_MS, deaths: c.deaths + 1 };
}

/** 부활: 체력 가득 + 잠깐 무적. 킬/데스와 은신 쿨타임은 그대로 */
export function respawn(c: Combat, now: number, maxHp = MAX_HP): Combat {
  return { ...c, hp: maxHp, state: "NORMAL", respawnAt: null, invulnUntil: now + RESPAWN_INVULN_MS };
}

/** 은신 시작 (앉을 때): 살아 있고 쿨타임이 끝났을 때만. 쿨타임은 은신이 끝난 뒤부터 */
export function startStealth(c: Combat, now: number): Combat {
  if (c.state !== "NORMAL" || now < (c.stealthReadyAt ?? 0) || now < (c.stealthUntil ?? 0)) return c;
  const until = now + STEALTH.DURATION_MS;
  return { ...c, stealthUntil: until, stealthReadyAt: until + STEALTH.COOLDOWN_MS };
}

/** 은신 일찍 끝내기 (일어서거나 공격하거나 죽으면). 쿨타임은 지금부터 */
export function endStealth(c: Combat, now: number): Combat {
  if (now >= (c.stealthUntil ?? 0)) return c;
  return { ...c, stealthUntil: now, stealthReadyAt: now + STEALTH.COOLDOWN_MS };
}

/** 뒤치기: 공격자가 대상의 등 뒤 120° 부채꼴 안에 있으면 true. face = 대상이 바라보는 방향 (라디안) */
export function isBehind(target: { x: number; y: number }, face: number, from: { x: number; y: number }): boolean {
  const dx = from.x - target.x, dy = from.y - target.y;
  const d = Math.hypot(dx, dy);
  return d > 1e-6 && (dx * Math.cos(face) + dy * Math.sin(face)) / d < -0.5;
}
