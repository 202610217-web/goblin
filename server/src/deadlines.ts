// 마감 시각 목록 관리 (순수 함수)
// Durable Object 알람은 1개만 걸 수 있으므로, 여러 마감 시각을 목록으로 들고 있다가
// 가장 가까운 시각으로 알람을 다시 건다.
// 이후 단계에서 페이즈 종료/작업 완료/사망/치유 완료 등이 kind로 추가된다.

export type DeadlineKind = "reconnect";

export interface Deadline {
  kind: DeadlineKind;
  /** 같은 kind 안에서 대상 구분용 키 (예: 플레이어 id) */
  key: string;
  /** 서버 기준 마감 시각 (ms) */
  at: number;
}

/** 같은 kind+key 가 있으면 교체, 없으면 추가 */
export function upsertDeadline(list: Deadline[], d: Deadline): Deadline[] {
  return [...list.filter((x) => !(x.kind === d.kind && x.key === d.key)), d];
}

/** kind+key 로 제거 */
export function removeDeadline(list: Deadline[], kind: DeadlineKind, key: string): Deadline[] {
  return list.filter((x) => !(x.kind === kind && x.key === key));
}

/** 가장 가까운 마감 시각. 없으면 null */
export function nextDeadlineAt(list: Deadline[]): number | null {
  let min: number | null = null;
  for (const d of list) if (min === null || d.at < min) min = d.at;
  return min;
}

/** now 시점까지 지난 마감들(시각 순)과 남은 목록으로 나눈다 */
export function splitDue(list: Deadline[], now: number): { due: Deadline[]; rest: Deadline[] } {
  const due = list.filter((d) => d.at <= now).sort((a, b) => a.at - b.at);
  const rest = list.filter((d) => d.at > now);
  return { due, rest };
}
