import { describe, expect, it } from "vitest";
import { CLASSES, HP_SCALE, STEALTH, isClassId } from "../../shared/classes";
import { ATTACK_COOLDOWN_MS, HIT_DAMAGE, MAX_HP, RESPAWN_INVULN_MS, RESPAWN_MS } from "../src/constants";
import { type Combat, applyHit, checkAttack, endStealth, isBehind, isHittable, newCombat, respawn, startStealth } from "../src/combat";

const hitN = (c: Combat, n: number, t0 = 1000) => {
  for (let i = 0; i < n; i++) c = applyHit(c, t0 + i * 1000);
  return c;
};

describe("체력과 죽음", () => {
  it("한 번 맞으면 25 감소", () => {
    expect(applyHit(newCombat(), 0).hp).toBe(MAX_HP - HIT_DAMAGE);
  });
  it("체력 0이면 기절 없이 바로 죽고, 3초 뒤 부활 예정, 데스 +1", () => {
    const c = hitN(newCombat(), 4);
    expect(c).toMatchObject({ hp: 0, state: "DEAD", respawnAt: 4000 + RESPAWN_MS, deaths: 1 });
    expect(hitN(newCombat(), 3).state).toBe("NORMAL");
  });
  it("죽은 뒤 추가 타격은 무시", () => {
    const c = hitN(newCombat(), 4);
    expect(applyHit(c, 5000)).toBe(c);
  });
  it("부활: 체력 가득, 2초 무적, 킬/데스 유지", () => {
    const dead = { ...hitN(newCombat(), 4), kills: 3 };
    const r = respawn(dead, 7000, 150);
    expect(r).toMatchObject({ hp: 150, state: "NORMAL", respawnAt: null, invulnUntil: 7000 + RESPAWN_INVULN_MS, kills: 3, deaths: 1 });
    expect(isHittable(r, 7000 + RESPAWN_INVULN_MS - 1)).toBe(false);
    expect(isHittable(r, 7000 + RESPAWN_INVULN_MS)).toBe(true);
  });
});

describe("타격 가능 조건", () => {
  it("경기 중에만", () => {
    expect(checkAttack(newCombat(), "PLAY", 5000)).toBeNull();
    expect(checkAttack(newCombat(), "COUNTDOWN", 5000)).toBe("wrong_phase");
  });
  it("쿨다운 1초", () => {
    const c = { ...newCombat(), lastAttackAt: 1000 };
    expect(checkAttack(c, "PLAY", 1000 + ATTACK_COOLDOWN_MS - 1)).toBe("cooldown");
    expect(checkAttack(c, "PLAY", 1000 + ATTACK_COOLDOWN_MS)).toBeNull();
  });
  it("죽은 상태에서는 불가", () => {
    expect(checkAttack(hitN(newCombat(), 4), "PLAY", 99_000)).toBe("not_normal");
  });
});

describe("직업별 수치", () => {
  it("모든 직업 체력에 같은 배수", () => {
    expect(newCombat(CLASSES.KNIGHT.maxHp).hp).toBe(Math.round(150 * HP_SCALE));
    expect(newCombat(CLASSES.ARCHER.maxHp).hp).toBe(Math.round(70 * HP_SCALE));
  });
  it("궁수 쿨다운 1.4초", () => {
    const c = { ...newCombat(CLASSES.ARCHER.maxHp), lastAttackAt: 1000 };
    expect(checkAttack(c, "PLAY", 2200, CLASSES.ARCHER.cooldownMs)).toBe("cooldown");
    expect(checkAttack(c, "PLAY", 2400, CLASSES.ARCHER.cooldownMs)).toBeNull();
  });
  it("직업 id 검사", () => {
    expect(isClassId("ARCHER")).toBe(true);
    expect(isClassId("WIZARD")).toBe(false);
  });
});

describe("고블린 은신 · 뒤치기", () => {
  it("앉으면 10초 은신, 끝난 뒤 15초 쿨타임", () => {
    const c = startStealth(newCombat(80), 1000);
    expect(c.stealthUntil).toBe(1000 + STEALTH.DURATION_MS);
    expect(c.stealthReadyAt).toBe(1000 + STEALTH.DURATION_MS + STEALTH.COOLDOWN_MS);
    expect(startStealth(c, 20_000)).toBe(c); // 쿨타임 중엔 다시 안 됨
    expect(startStealth(c, 26_000).stealthUntil).toBe(36_000);
  });
  it("일어서거나 공격하면 일찍 끝나고 그때부터 쿨타임", () => {
    const c = endStealth(startStealth(newCombat(80), 1000), 4000);
    expect(c.stealthUntil).toBe(4000);
    expect(c.stealthReadyAt).toBe(4000 + STEALTH.COOLDOWN_MS);
    expect(endStealth(c, 5000)).toBe(c); // 은신 아니면 그대로
  });
  it("죽으면 은신이 풀리고, 죽은 동안엔 은신 못 함", () => {
    const d = applyHit({ ...startStealth(newCombat(80), 500), hp: 1 }, 1000);
    expect(d.stealthUntil).toBe(1000);
    expect(startStealth(d, 2000)).toBe(d);
  });
  it("등 뒤 120° 안에서만 뒤치기", () => {
    const t = { x: 0, y: 0 }; // 동쪽(+x)을 봄
    expect(isBehind(t, 0, { x: -1, y: 0 })).toBe(true);
    expect(isBehind(t, 0, { x: -1, y: 1.5 })).toBe(true); // 뒤쪽 56°
    expect(isBehind(t, 0, { x: 0, y: 1 })).toBe(false); // 옆
    expect(isBehind(t, 0, { x: 1, y: 0 })).toBe(false); // 앞
    expect(isBehind(t, Math.PI / 2, { x: 0, y: -1 })).toBe(true); // 북쪽을 볼 때 남쪽에서
  });
});

describe("직업 스킬", () => {
  it("쓰는 동안만 궁수 공격 쿨다운이 0.7초, 쿨타임 전에는 다시 못 씀, 죽으면 끝남", async () => {
    const { attackCooldownMs, CLASSES: C } = await import("../../shared/classes");
    const { startSkill } = await import("../src/combat");
    const c = startSkill(newCombat(), 1000, 10_000, 20_000);
    expect(c).toMatchObject({ skillUntil: 11_000, skillReadyAt: 21_000 });
    expect(startSkill(c, 15_000, 10_000, 20_000)).toBe(c);
    expect(attackCooldownMs("ARCHER", c.skillUntil, 5_000)).toBe(700);
    expect(attackCooldownMs("ARCHER", c.skillUntil, 11_000)).toBe(C.ARCHER.cooldownMs);
    expect(attackCooldownMs("KNIGHT", c.skillUntil, 5_000)).toBe(C.KNIGHT.cooldownMs);
    const dead = applyHit({ ...c, hp: 1 }, 3000, 10);
    expect(dead.skillUntil).toBe(3000);
  });
});
