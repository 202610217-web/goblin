// 직업 수치. 서버 판정과 화면 표시가 같아야 해서 shared에 둔다.
export type ClassId = "KNIGHT" | "ARCHER";

export const CLASSES: Record<ClassId, { name: string; maxHp: number; cooldownMs: number; range: number; ranged: boolean }> = {
  /** 기사: 검과 방패. 근접(기존 2m 판정), 체력 높음 */
  KNIGHT: { name: "기사", maxHp: 150, cooldownMs: 1_000, range: 2, ranged: false },
  /** 궁수: 활. 화살이 날아가서 맞힘, 체력 낮음 */
  ARCHER: { name: "궁수", maxHp: 70, cooldownMs: 1_400, range: 12, ranged: true },
};

/** 화살: 초당 30m 직선, 최대 12m, 50ms마다 구간 판정 */
export const ARROW = { SPEED: 30, MAX_RANGE: 12, STEP_MS: 50 } as const;

export const isClassId = (x: unknown): x is ClassId => x === "KNIGHT" || x === "ARCHER";
