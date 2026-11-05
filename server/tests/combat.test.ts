import { describe, expect, it } from "vitest";
import { CLASSES, isClassId } from "../../shared/classes";
import {
  ATTACK_COOLDOWN_MS, DOWN_TO_DEATH_MS, HIT_DAMAGE, MAX_HP, REVIVE_HP_RATIO, REVIVE_INVULN_MS, REVIVE_TIME_MS,
} from "../src/constants";
import {
  type Combat, applyDeath, applyHit, checkAttack, checkReviveStart, completeRevive, isTeamWiped, newCombat,
  resetForRound, resolveHit, startRevive, stopRevive, wipeWinner,
} from "../src/combat";
import { BREAK_TIME_MS } from "../src/constants";
import { splitDue } from "../src/deadlines";
import { startHold, workForPhase, progressAt, completionAt } from "../src/work";

const hitN = (c: Combat, n: number, t0 = 1000) => {
  for (let i = 0; i < n; i++) c = applyHit(c, t0 + i * 1000);
  return c;
};
const downed = (at = 1000) => applyHit({ ...newCombat(), hp: HIT_DAMAGE }, at);

describe("체력과 기절", () => {
  it("한 번 맞으면 25 감소", () => {
    expect(applyHit(newCombat(), 0).hp).toBe(MAX_HP - HIT_DAMAGE);
  });
  it("4번 맞으면 기절, 사망 타이머 20초 시작, 기절 횟수 +1", () => {
    const c = hitN(newCombat(), 4);
    expect(c).toMatchObject({ hp: 0, state: "DOWNED", deathAt: 4000 + DOWN_TO_DEATH_MS, downs: 1 });
    expect(hitN(newCombat(), 3).state).toBe("NORMAL");
  });
  it("기절 중 추가 타격은 무시 (무적)", () => {
    const c = hitN(newCombat(), 4);
    expect(applyHit(c, 6000)).toBe(c);
  });
  it("20초 동안 치유 못 받으면 사망, 사망 횟수 +1", () => {
    const c = applyDeath(downed());
    expect(c).toMatchObject({ state: "DEAD", deathAt: null, deaths: 1 });
    expect(applyHit(c, 99_999)).toBe(c); // 사망자도 맞지 않음
  });
  it("정상 상태에는 사망 처리가 아무 영향 없음", () => {
    const c = newCombat();
    expect(applyDeath(c)).toBe(c);
  });
});

describe("타격 가능 조건", () => {
  const c = newCombat();
  it("ATTACK/REPAIR에서만, 준비 단계 불가", () => {
    expect(checkAttack(c, "ATTACK", false, 5000)).toBeNull();
    expect(checkAttack(c, "REPAIR", false, 5000)).toBeNull();
    expect(checkAttack(c, "COUNTDOWN", false, 5000)).toBe("wrong_phase");
  });
  it("쿨다운 1초", () => {
    const a = { ...c, lastAttackAt: 5000 };
    expect(checkAttack(a, "ATTACK", false, 5000 + ATTACK_COOLDOWN_MS - 1)).toBe("cooldown");
    expect(checkAttack(a, "ATTACK", false, 5000 + ATTACK_COOLDOWN_MS)).toBeNull();
  });
  it("작업 중/치유 중/기절 상태에서는 불가", () => {
    expect(checkAttack(c, "ATTACK", true, 5000)).toBe("busy");
    expect(checkAttack(startRevive(c, "x", 0), "ATTACK", false, 5000)).toBe("busy");
    expect(checkAttack(downed(), "ATTACK", false, 5000)).toBe("not_normal");
  });
});

describe("치유", () => {
  it("기절한 팀원에게만 시작 가능", () => {
    expect(checkReviveStart(newCombat(), "ATTACK", false, downed())).toBeNull();
    expect(checkReviveStart(newCombat(), "ATTACK", false, newCombat())).toBe("no_target");
    expect(checkReviveStart(newCombat(), "ATTACK", false, null)).toBe("no_target");
    expect(checkReviveStart(newCombat(), "ATTACK", false, applyDeath(downed()))).toBe("no_target");
    expect(checkReviveStart(newCombat(), "ATTACK", true, downed())).toBe("busy");
    expect(checkReviveStart(downed(), "ATTACK", false, downed())).toBe("not_normal");
    expect(checkReviveStart(newCombat(), "ROUND_END", false, downed())).toBe("wrong_phase");
  });
  it("3초 치유 성공: 체력 30%, 정상 복귀, 사망 타이머 해제", () => {
    const r = startRevive(newCombat(), "t", 2000);
    expect(r.revive).toEqual({ target: "t", endsAt: 2000 + REVIVE_TIME_MS });
    const t = completeRevive(downed(), r.revive!.endsAt);
    expect(t).toMatchObject({ state: "NORMAL", hp: MAX_HP * REVIVE_HP_RATIO, deathAt: null });
  });
  it("부활 후 1.5초 무적", () => {
    const t = completeRevive(downed(), 10_000);
    expect(applyHit(t, 10_000 + REVIVE_INVULN_MS - 1)).toBe(t);
    expect(applyHit(t, 10_000 + REVIVE_INVULN_MS).hp).toBe(MAX_HP * REVIVE_HP_RATIO - HIT_DAMAGE);
  });
  it("치유 중 치유자가 기절하면 치유 중단", () => {
    let r = startRevive({ ...newCombat(), hp: HIT_DAMAGE }, "t", 0);
    r = applyHit(r, 1000);
    expect(r.state).toBe("DOWNED");
    expect(r.revive).toBeNull();
  });
  it("치유 중 맞아도 치유는 계속된다", () => {
    const r = applyHit(startRevive(newCombat(), "t", 0), 1000);
    expect(r.revive).not.toBeNull();
    expect(r.hp).toBe(MAX_HP - HIT_DAMAGE);
  });
  it("치유 중 사망 타이머 만료: 사망이 먼저 오면 대상 사망, 치유는 아무 효과 없음", () => {
    const t0 = downed(0); // 20초에 사망 예정
    const r = startRevive(newCombat(), "t", 18_500); // 21.5초에 치유 완료 예정
    const { due } = splitDue([
      { kind: "revive", key: "r", at: r.revive!.endsAt },
      { kind: "death", key: "t", at: t0.deathAt! },
    ], 30_000);
    expect(due.map((d) => d.kind)).toEqual(["death", "revive"]);
    const dead = applyDeath(t0);
    expect(completeRevive(dead, r.revive!.endsAt)).toBe(dead); // 이미 사망 → 부활 불가
  });
  it("치유 완료와 사망이 같은 순간이면 치유가 먼저", () => {
    const { due } = splitDue([
      { kind: "death", key: "t", at: 20_000 },
      { kind: "revive", key: "r", at: 20_000 },
    ], 20_000);
    expect(due.map((d) => d.kind)).toEqual(["revive", "death"]);
  });
  it("치유 중단(버튼 뗌)하면 진행 기록이 지워진다", () => {
    expect(stopRevive(startRevive(newCombat(), "t", 0)).revive).toBeNull();
  });
});

describe("집 작업과 전투", () => {
  const working = () => startHold(workForPhase("ATTACK", 0), "p", 0);
  it("작업 중 맞으면 체력만 줄고 작업은 그대로", () => {
    const w = working();
    const r = resolveHit(newCombat(), "p", w, 5000);
    expect(r.c.hp).toBe(MAX_HP - HIT_DAMAGE);
    expect(r.work).toBe(w);
    expect(completionAt(r.work)).toBe(completionAt(w));
  });
  it("작업 중 기절하면 작업 중단 (체크포인트 규칙 적용)", () => {
    const r = resolveHit({ ...newCombat(), hp: HIT_DAMAGE }, "p", working(), BREAK_TIME_MS / 4);
    expect(r.c.state).toBe("DOWNED");
    expect(r.work.holders).toEqual([]);
    expect(progressAt(r.work, 99_999)).toBe(0); // 25%에서 중단 → 0%
  });
});

describe("전멸", () => {
  const N = newCombat(), D = downed(), X = applyDeath(downed());
  it("전원 기절/사망이면 전멸", () => {
    expect(isTeamWiped([D, X])).toBe(true);
    expect(isTeamWiped([D, D])).toBe(true);
    expect(isTeamWiped([D, N])).toBe(false);
    expect(isTeamWiped([])).toBe(false);
  });
  it("ATTACK 중 공격팀 전멸 → 수비팀 승 (즉시)", () => {
    expect(wipeWinner("ATTACK", "A", { A: [D, D], B: [N, N] })).toBe("B");
  });
  it("REPAIR 중 수비팀 전멸 → 공격팀 승", () => {
    expect(wipeWinner("REPAIR", "A", { A: [N, N], B: [D, X] })).toBe("A");
  });
  it("반대쪽 팀 전멸은 라운드를 끝내지 않음", () => {
    expect(wipeWinner("ATTACK", "A", { A: [N, N], B: [D, D] })).toBeNull();
    expect(wipeWinner("REPAIR", "A", { A: [D, D], B: [N, N] })).toBeNull();
  });
  it("전투 단계가 아니면 판정 안 함", () => {
    expect(wipeWinner("ROUND_END", "A", { A: [D, D], B: [N, N] })).toBeNull();
  });
});

describe("라운드 시작 초기화", () => {
  it("체력/상태/치유는 초기화(사망자도 부활), 누적 기절·사망 횟수는 유지", () => {
    const c = { ...applyDeath(downed()), revive: { target: "x", endsAt: 1 } };
    expect(resetForRound(c)).toMatchObject({ hp: MAX_HP, state: "NORMAL", deathAt: null, revive: null, downs: 1, deaths: 1 });
  });
});

describe("직업별 수치", () => {
  it("기사 체력 150, 궁수 체력 70", () => {
    expect(newCombat(CLASSES.KNIGHT.maxHp).hp).toBe(150);
    expect(newCombat(CLASSES.ARCHER.maxHp).hp).toBe(70);
  });
  it("궁수 쿨다운 1.4초", () => {
    const c = { ...newCombat(CLASSES.ARCHER.maxHp), lastAttackAt: 1000 };
    expect(checkAttack(c, "ATTACK", false, 2200, CLASSES.ARCHER.cooldownMs)).toBe("cooldown");
    expect(checkAttack(c, "ATTACK", false, 2400, CLASSES.ARCHER.cooldownMs)).toBeNull();
  });
  it("궁수 치유 후 체력 = 70의 30%", () => {
    const d = applyHit({ ...newCombat(70), hp: HIT_DAMAGE }, 1000);
    expect(completeRevive(d, 2000, CLASSES.ARCHER.maxHp).hp).toBe(21);
  });
  it("직업 id 검사", () => {
    expect(isClassId("ARCHER")).toBe(true);
    expect(isClassId("WIZARD")).toBe(false);
  });
});
