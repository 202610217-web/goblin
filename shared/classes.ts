// 직업 수치. 서버 판정과 화면 표시가 같아야 해서 shared에 둔다.
export type ClassId = "KNIGHT" | "ARCHER" | "JAVELIN";

/** 날아가는 무기 (화살/창): 초당 속도(m/s), 최대 거리(m). 직선 비행 */
export interface Projectile { speed: number; range: number }

export const CLASSES: Record<ClassId, {
  name: string; maxHp: number; cooldownMs: number; range: number; ranged: boolean;
  /** 걷는 속도 (m/s), 한 번 맞힐 때 데미지 */
  speed: number; damage: number;
  /** 원거리 직업의 투사체 */
  proj?: Projectile;
}> = {
  /** 기사: 검과 방패. 근접(2m), 체력 높음, 조금 더 빠름 */
  KNIGHT: { name: "기사", maxHp: 150, cooldownMs: 1_000, range: 2, ranged: false, speed: 6.6, damage: 25 },
  /** 궁수: 활. 빠른 화살, 체력 낮음 */
  ARCHER: { name: "궁수", maxHp: 70, cooldownMs: 1_400, range: 12, ranged: true, speed: 6, damage: 25, proj: { speed: 30, range: 12 } },
  /** 창던지기병: 느리지만 멀리 가고 아픈 창 (리드샷이 더 어려움), 체력 중간 */
  JAVELIN: { name: "창던지기병", maxHp: 100, cooldownMs: 2_000, range: 16, ranged: true, speed: 6, damage: 45, proj: { speed: 22, range: 16 } },
};

/** 투사체 판정 간격 (서버가 50ms마다 지나간 구간을 본다) */
export const ARROW = { STEP_MS: 50 } as const;

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
export const isClassId = (x: unknown): x is ClassId => CLASS_IDS.includes(x as ClassId);
