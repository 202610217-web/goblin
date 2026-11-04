// 지연 보정 (순수 함수)
import { MAX_INPUT_REWIND_MS } from "./constants";

/**
 * 입력을 처리할 서버 시각.
 * - 화면이 보낸 시각(at)을 쓰되, 지금보다 미래일 수 없고
 * - 이 플레이어의 마지막 이동 기록(bodyT)보다 과거일 수 없으며 (순서 뒤집기 방지)
 * - MAX_INPUT_REWIND_MS 보다 오래된 과거로는 돌아가지 않는다
 * at이 없으면(옛 화면) 지금 시각.
 */
export function inputTime(at: number | undefined, bodyT: number, now: number, maxRewind = MAX_INPUT_REWIND_MS): number {
  if (at === undefined || !Number.isFinite(at)) return now;
  return Math.min(now, Math.max(at, bodyT, now - maxRewind));
}
