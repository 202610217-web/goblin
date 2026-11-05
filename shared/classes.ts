// 직업 수치. 서버 판정과 화면 표시가 같아야 해서 shared에 둔다.
export type ClassId = "KNIGHT" | "ARCHER" | "JAVELIN" | "GOBLIN";

/** 날아가는 무기 (화살/창): 초당 속도(m/s), 최대 거리(m). 직선 비행 */
export interface Projectile { speed: number; range: number }

/** 모든 직업 체력에 곱하는 배수 (직업 사이 비율은 그대로, 전체 교전을 조금 길게) */
export const HP_SCALE = 1.25;
const hp = (base: number) => Math.round(base * HP_SCALE);

export const CLASSES: Record<ClassId, {
  name: string; maxHp: number; cooldownMs: number; range: number; ranged: boolean;
  /** 걷는 속도 (m/s), 한 번 맞힐 때 데미지 */
  speed: number; damage: number;
  /** 원거리 직업의 투사체 */
  proj?: Projectile;
  /** 앉으면 은신 + 등 뒤 공격 1.5배 (고블린) */
  sneaky?: boolean;
}> = {
  /** 기사: 검과 방패. 근접(2m), 체력 높음, 조금 더 빠름 */
  KNIGHT: { name: "기사", maxHp: hp(150), cooldownMs: 1_000, range: 2, ranged: false, speed: 6.6, damage: 25 },
  /** 궁수: 활. 빠른 화살, 체력 낮음 */
  ARCHER: { name: "궁수", maxHp: hp(70), cooldownMs: 1_400, range: 12, ranged: true, speed: 6, damage: 25, proj: { speed: 30, range: 12 } },
  /** 창던지기병: 느리지만 멀리 가고 아픈 창 (리드샷이 더 어려움), 체력 중간 */
  JAVELIN: { name: "창던지기병", maxHp: hp(100), cooldownMs: 2_000, range: 16, ranged: true, speed: 6, damage: 45, proj: { speed: 22, range: 16 } },
  /** 고블린: 단검. 짧고 빠른 근접, 체력 낮음. 앉으면 은신, 등 뒤에서 찌르면 1.5배 */
  GOBLIN: { name: "고블린", maxHp: hp(80), cooldownMs: 700, range: 2, ranged: false, speed: 6.8, damage: 20, sneaky: true },
};

/** 고블린 은신: 지속 10초, 끝난 뒤 15초 쿨타임. 뒤치기 배율 */
export const STEALTH = { DURATION_MS: 10_000, COOLDOWN_MS: 15_000, BACKSTAB: 1.5 } as const;

/** 데스매치: 먼저 이 킬 수에 닿은 팀이 승리 */
export const KILL_TARGET = 15;

/**
 * 스킬 버튼: 기사 = 10초 이속 증가(쿨 15초), 궁수 = 10초 공속 증가(쿨 20초),
 * 창던지기병 = 10초 안에 던지는 다음 창 한 발이 맞은 적을 2초 동안 50% 느리게(쿨 15초). 없는 직업은 버튼이 숨는다
 */
export const SKILLS: Partial<Record<ClassId, {
  name: string; durationMs: number; cooldownMs: number; speedMul?: number; attackCooldownMs?: number; slowMs?: number; slowMul?: number;
}>> = {
  KNIGHT: { name: "질주", durationMs: 10_000, cooldownMs: 15_000, speedMul: 1.3 },
  ARCHER: { name: "속사", durationMs: 10_000, cooldownMs: 20_000, attackCooldownMs: 700 },
  JAVELIN: { name: "발 묶기", durationMs: 10_000, cooldownMs: 15_000, slowMs: 2_000, slowMul: 0.5 },
};

/** 궁극기 게이지: 내가 준 피해 1당 0.5% (피해 200이면 100%). 100%가 되면 쓸 수 있고, 쓰면 0% */
export const ULT_PER_DAMAGE = 0.5;
/** 궁극기 (없는 직업은 버튼이 숨는다). 기사: 앞쪽(양옆 30°) range m 안의 적 한 명에게 하늘에서 큰 칼을 내리꽂는다 */
export const ULTS: Partial<Record<ClassId, { name: string; damage: number; range: number }>> = {
  KNIGHT: { name: "하늘 검", damage: 50, range: 4 },
};

/** 지금 공격 쿨다운 (궁수 스킬 중이면 짧아짐). 서버 판정과 화면이 같은 값을 쓴다 */
export function attackCooldownMs(cls: ClassId, skillUntil: number | undefined, now: number): number {
  const s = SKILLS[cls];
  return s?.attackCooldownMs !== undefined && now < (skillUntil ?? 0) ? s.attackCooldownMs : CLASSES[cls].cooldownMs;
}

/** 투사체 판정 간격 (서버가 50ms마다 지나간 구간을 본다) */
export const ARROW = { STEP_MS: 50 } as const;

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
export const isClassId = (x: unknown): x is ClassId => CLASS_IDS.includes(x as ClassId);
