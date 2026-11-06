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
 * 창던지기병 = 10초 안에 던지는 다음 창 한 발이 맞은 적을 2초 동안 50% 느리게(쿨 15초),
 * 고블린 = 10초 은신(공격하면 풀림, 끝난 뒤 15초 쿨). 없는 직업은 버튼이 숨는다
 */
export const SKILLS: Partial<Record<ClassId, {
  name: string; durationMs: number; cooldownMs: number; speedMul?: number; attackCooldownMs?: number; slowMs?: number; slowMul?: number;
  /** 고블린 은신: 시간은 STEALTH 규칙(공격하면 풀림, 끝난 뒤부터 쿨타임)을 따른다 */
  stealth?: boolean;
}>> = {
  KNIGHT: { name: "질주", durationMs: 10_000, cooldownMs: 15_000, speedMul: 1.3 },
  ARCHER: { name: "속사", durationMs: 10_000, cooldownMs: 20_000, attackCooldownMs: 700 },
  GOBLIN: { name: "은신", durationMs: STEALTH.DURATION_MS, cooldownMs: STEALTH.COOLDOWN_MS, stealth: true },
  JAVELIN: { name: "발 묶기", durationMs: 10_000, cooldownMs: 15_000, slowMs: 2_000, slowMul: 0.5 },
};

/** 궁극기 게이지: 내가 준 피해 1당 0.5% (피해 200이면 100%). 100%가 되면 쓸 수 있고, 쓰면 0% */
export const ULT_PER_DAMAGE = 0.5;
/**
 * 궁극기.
 * - 기사 하늘 검(sword): 앞쪽(양옆 30°) range m 안의 적 한 명에게 하늘에서 큰 칼을 내리꽂는다
 * - 궁수 화살비(rain): 조준점(최대 range m) 반경 radius m에 delayMs 뒤 화살이 쏟아져 안의 적 모두에게 데미지
 * - 창던지기병 거대 창(spear): 크고 빠른 창 한 발 (range m), 맞은 적은 slowMs 동안 slowMul 속도
 * - 고블린 연막탄(smoke): 내 자리에 반경 radius m 연기 durationMs 동안. 쓴 팀에게는 연기가 옅어 안이 잘 보이고,
 *   상대 팀에게는 짙은 연기라 그 안에 있는 사람이 안 보인다
 */
export const ULTS: Partial<Record<ClassId, {
  name: string; kind: "sword" | "rain" | "spear" | "smoke"; damage: number; range: number;
  radius?: number; delayMs?: number; speed?: number; slowMs?: number; slowMul?: number; durationMs?: number;
}>> = {
  KNIGHT: { name: "하늘 검", kind: "sword", damage: 70, range: 4 },
  ARCHER: { name: "화살비", kind: "rain", damage: 30, range: 20, radius: 3, delayMs: 1_000 },
  JAVELIN: { name: "거대 창", kind: "spear", damage: 70, range: 25, speed: 26, slowMs: 1_000, slowMul: 0.2 },
  GOBLIN: { name: "연막탄", kind: "smoke", damage: 0, range: 0, radius: 4, durationMs: 6_000 },
};

/** 지금 공격 쿨다운 (궁수 스킬 중이면 짧아짐). 서버 판정과 화면이 같은 값을 쓴다 */
export function attackCooldownMs(cls: ClassId, skillUntil: number | undefined, now: number): number {
  const s = SKILLS[cls];
  return s?.attackCooldownMs !== undefined && now < (skillUntil ?? 0) ? s.attackCooldownMs : CLASSES[cls].cooldownMs;
}

/** 연속 처치: 죽지 않고 EVERY킬마다 궁극기 +ULT_BONUS%. 연속 BOUNTY_MIN킬 이상인 적을 잡으면 현상금 +BOUNTY_ULT% */
export const STREAK = { EVERY: 3, ULT_BONUS: 30, BOUNTY_MIN: 3, BOUNTY_ULT: 50 } as const;

/** 파워업 종류: 체력 가득 / POWER_MS 동안 데미지 POWER_MUL배 / 궁극기 +ULT% */
export type PickupKind = "heal" | "power" | "ult";
/** 파워업: 경기 시작 RESPAWN_MS 뒤 맵 가운데에 생기고, 누가 먹으면 RESPAWN_MS 뒤 다시 생긴다. 발이 PICK_RANGE m 안이면 먹음 */
export const PICKUP = { RESPAWN_MS: 30_000, PICK_RANGE: 1.4, POWER_MS: 10_000, POWER_MUL: 1.5, ULT: 50 } as const;
export const PICKUP_KINDS: PickupKind[] = ["heal", "power", "ult"];

/** 투사체 판정 간격 (서버가 50ms마다 지나간 구간을 본다) */
export const ARROW = { STEP_MS: 50 } as const;

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
export const isClassId = (x: unknown): x is ClassId => CLASS_IDS.includes(x as ClassId);
