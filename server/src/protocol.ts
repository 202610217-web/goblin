// 클라이언트 <-> 서버 WebSocket 메시지 형식 (JSON)
// 모든 메시지는 { t: "종류", ... } 모양이다.
import { type Body, isValidAngle } from "../../shared/sim";
export type { Body };
import type { Combat } from "./combat";
import { type ClassId, type PickupKind, isClassId } from "../../shared/classes";
import type { Vec3 } from "../../shared/aim";
import { type MapId, isMapId } from "../../shared/world";
export type { MapId };
export type { ClassId };
import type { Score } from "./score";
export type { Score };

export type Team = "A" | "B";
export type Phase = "LOBBY" | "CLASS_SELECT" | "COUNTDOWN" | "PLAY" | "MATCH_END";
export type ConnState = "CONNECTED" | "RECONNECTING";

const PHASES: readonly Phase[] = ["LOBBY", "CLASS_SELECT", "COUNTDOWN", "PLAY", "MATCH_END"];

// ---------- 클라이언트 → 서버 ----------
export type ClientMessage =
  | { t: "join"; nickname: string; token?: string } // 입장 (token이 있으면 재접속 시도)
  | { t: "set_nickname"; nickname: string }
  | { t: "set_team"; team: Team }
  | { t: "set_ready"; ready: boolean } // 로비 준비 완료/취소
  /** 이동 방향 각도 단계 (-1=정지, 0~31, shared/sim.ts 참고). 방향이 바뀔 때만 보낸다. s = 입력 순번 */
  | { t: "move"; a: number; s: number; at?: number; /** 바라보는 방향 (카메라, 0~63) */ f?: number }
  /** 점프 (땅에 있을 때만 서버가 허용). at = 화면에서 누른 서버 기준 시각 (지연 보정, 최대 0.5초 전까지) */
  | { t: "jump"; s: number; at?: number }
  /** 앉기(on=true) / 일어서기. s, at은 점프와 같음 */
  | { t: "crouch"; on: boolean; s: number; at?: number }
  /** 타격 1회. 원거리 = 카메라 방향(조준점), 근접 = 캐릭터가 바라보는 방향. 서버가 그 방향으로 맞은 사람을 판정 */
  | { t: "attack"; yaw: number; pitch: number }
  /** 직업 스킬 (기사 이속 증가, 궁수 공속 증가) */
  | { t: "skill" }
  /** 궁극기 (게이지 100%일 때). 근접 = 캐릭터가 바라보는 방향, 원거리 = 카메라(조준점) 방향 */
  | { t: "ult"; yaw: number; pitch: number }
  /** 맵 가운데 파워업 먹기 (가까이 있을 때 화면이 보낸다. 거리는 서버가 다시 확인) */
  | { t: "pickup" }
  /** 경기 종료 화면에서 "다시 하기" → 로비로 돌아가 다시 준비 */
  | { t: "rematch" }
  /** 로비: 빈자리를 연습용 더미로 채우기 / 더미 모두 빼기 */
  | { t: "add_bots" }
  | { t: "remove_bots" }
  /** 로비: 인원이 모자라도 지금 있는 사람(+더미)으로 연습 경기 바로 시작 */
  | { t: "start_practice" }
  /** 로비: 방장이 게임 시작 (4명·2대2·모두 준비일 때) → 직업 선택 5초 */
  | { t: "start_game" }
  /** 로비: 방장이 맵 고르기 */
  | { t: "set_map"; map: MapId }
  /** 직업 선택 단계에서 내 직업 고르기 */
  | { t: "set_class"; cls: ClassId }
  | { t: "debug_phase"; phase: Phase } // 개발용 강제 단계 전환 (DEBUG_COMMANDS=true 일 때만)
  | { t: "debug_teleport"; x: number; y: number } // 개발용 순간이동 (DEBUG_COMMANDS=true 일 때만)
  | { t: "debug_score"; A: number; B: number } // 개발용 팀 킬 수 설정 (DEBUG_COMMANDS=true 일 때만)
  | { t: "debug_stats" } // 개발용: 무료 한도 점검용 사용량 카운터 요청 (DEBUG_COMMANDS=true 일 때만)
  | { t: "leave" }; // 완전히 나가기 (재접속 대기 없이 즉시 퇴장)

// ---------- 서버 → 클라이언트 ----------
export interface PublicPlayer {
  id: string;
  nickname: string;
  team: Team;
  conn: ConnState;
  /** 재접속 대기 마감 시각 (서버 기준 ms 타임스탬프), 연결 중이면 null */
  reconnectDeadline: number | null;
  ready: boolean;
  /** 물리 상태 (body.t 시각 기준). 클라이언트는 shared/sim.ts의 simulate로 현재 위치를 계산 */
  body: Body;
  /** 서버가 마지막으로 처리한 이 플레이어의 입력 순번 */
  seq: number;
  /** 전투 상태 (체력, NORMAL/DEAD, 부활 예정 시각, 무적, 킬/데스, 은신) */
  combat: PublicCombat;
  /** 연습용 더미인지 */
  bot: boolean;
  /** 직업 */
  cls: ClassId;
  /** 방장인지 (게임 시작/연습 시작 가능) */
  owner: boolean;
}

export type PublicCombat = Omit<Combat, "lastAttackAt"> & {
  /** 다음 타격 가능 시각 (쿨다운 표시용) */
  attackReadyAt: number;
};

/** 고블린 연막탄: team = 던진 팀 */
export interface Smoke { team: Team; x: number; y: number; z: number; radius: number; until: number }

export interface RoomStateMessage {
  t: "room_state";
  room: string;
  phase: Phase;
  /** 현재 단계 종료 시각 (서버 기준 ms). 제한 없으면 null */
  phaseEndsAt: number | null;
  /** 맵 */
  map: MapId;
  /** 팀별 킬 수 (먼저 KILL_TARGET이면 승리) */
  score: Score;
  /** MATCH_END: 이긴 팀 (무승부·플레이어 이탈이면 null), 끝난 이유 */
  matchWinner: Team | null;
  matchEndReason: "score" | "time" | "player_left" | null;
  /** 연습 경기인지 (인원이 모자라도 시작한 경기) */
  practice: boolean;
  players: PublicPlayer[];
  serverTime: number;
  /** 고블린 연막 (끝나지 않은 것만) */
  smokes: Smoke[];
  /** 맵 가운데 파워업 (없으면 null) */
  pickup: Pickup | null;
}

export interface Pickup { kind: PickupKind; x: number; y: number; z: number }

/** 무료 한도 점검용 카운터 */
export interface UsageStats {
  since: number;
  /** 들어온 WebSocket 메시지 (20개 = 요청 1개) — 종류별 */
  messagesIn: Record<string, number>;
  /** storage.put 횟수 (= 쓴 행 수), setAlarm 횟수 (= 쓴 행 수), deleteAlarm 횟수 */
  puts: number;
  alarmSets: number;
  alarmDeletes: number;
  /** 알람 실행 횟수 (= 요청 수) */
  alarmRuns: number;
  /** 새 WebSocket 접속 (= Worker 요청 1 + DO 요청 1) */
  connects: number;
}

export type ErrorCode =
  | "bad_message"
  | "not_joined"
  | "already_joined"
  | "room_full"
  | "team_full"
  | "game_in_progress"
  | "rate_limited"
  | "replaced"
  | "wrong_phase"
  | "debug_disabled"
  | "cannot_attack"
  | "cannot_skill"
  | "cannot_ult"
  | "not_owner";

export type ServerMessage =
  /** edge = 내가 들어온 Cloudflare 위치, roomColo = 이 방 서버가 있는 위치 (공항 코드, 핑 진단용) */
  | { t: "welcome"; playerId: string; token: string; room: string; resumed: boolean; serverTime: number; edge: string; roomColo: string }
  | RoomStateMessage
  /** 한 플레이어의 이동 입력이 처리되었을 때 (body.t 시각의 물리 상태, s = 처리한 입력 순번) */
  | { t: "move"; id: string; body: Body; s: number }
  | { t: "notice"; code: "player_left_game"; message: string }
  /** 개발용 사용량 카운터 (이 DO가 깨어난 뒤부터) */
  | { t: "debug_stats"; stats: UsageStats }
  /** 누군가 타격했을 때 (target = 맞은 사람, 빗나가면 null). 체력 변화·킬은 함께 오는 room_state로 반영 */
  /** 궁극기가 떨어짐 (화면 효과용). 데미지는 swing으로 따로 온다 */
  | { t: "ult"; kind: "sword" | "rain" | "smoke"; by: string; target?: string; x: number; y: number; z: number; serverTime: number; radius?: number }
  /** 연속 처치 보상(streak = 죽지 않고 이어 온 킬 수) 또는 현상금(bounty = 연속 처치 중인 적을 잡음) */
  | { t: "streak"; by: string; victim: string; streak: number; bounty: boolean; serverTime: number }
  /** 누가 파워업을 먹음 */
  | { t: "picked"; by: string; kind: PickupKind; serverTime: number }
  | { t: "swing"; by: string; target: string | null; serverTime: number; /** 실제로 들어간 데미지 (뒤치기 1.5배 포함) */ damage: number }
  /** 궁수가 쐈을 때 (화면이 같은 화살을 그림). at = 쏜 서버 시각. 맞으면 swing(target)이 따로 온다 */
  | { t: "shot"; by: string; origin: Vec3; dir: Vec3; at: number; speed: number; range: number; /** 궁극기 거대 창 */ big?: boolean }
  | { t: "error"; code: ErrorCode; message: string };

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9;

/** 받은 문자열을 검증해서 ClientMessage로 바꾼다. 잘못된 값이면 null */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.t) {
    case "join":
      if (typeof m.nickname !== "string") return null;
      if (m.token !== undefined && typeof m.token !== "string") return null;
      return { t: "join", nickname: m.nickname, token: m.token as string | undefined };
    case "set_nickname":
      if (typeof m.nickname !== "string") return null;
      return { t: "set_nickname", nickname: m.nickname };
    case "set_team":
      if (m.team !== "A" && m.team !== "B") return null;
      return { t: "set_team", team: m.team };
    case "set_ready":
      if (typeof m.ready !== "boolean") return null;
      return { t: "set_ready", ready: m.ready };
    case "move":
      if (!isValidAngle(m.a) || !isSeq(m.s)) return null;
      return { t: "move", a: m.a, s: m.s, at: isTime(m.at) ? m.at : undefined, f: isValidAngle(m.f) && m.f >= 0 ? m.f : undefined };
    case "jump":
      if (!isSeq(m.s)) return null;
      return { t: "jump", s: m.s, at: isTime(m.at) ? m.at : undefined };
    case "crouch":
      if (typeof m.on !== "boolean" || !isSeq(m.s)) return null;
      return { t: "crouch", on: m.on, s: m.s, at: isTime(m.at) ? m.at : undefined };
    case "attack":
      if (typeof m.yaw !== "number" || typeof m.pitch !== "number" || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return null;
      return { t: "attack", yaw: m.yaw, pitch: m.pitch };
    case "skill":
      return { t: "skill" };
    case "ult":
      return typeof m.yaw === "number" && Number.isFinite(m.yaw) ? { t: "ult", yaw: m.yaw, pitch: typeof m.pitch === "number" && Number.isFinite(m.pitch) ? m.pitch : 0 } : null;
    case "pickup":
      return { t: "pickup" };
    case "rematch":
      return { t: "rematch" };
    case "add_bots":
      return { t: "add_bots" };
    case "remove_bots":
      return { t: "remove_bots" };
    case "start_practice":
      return { t: "start_practice" };
    case "start_game":
      return { t: "start_game" };
    case "set_map":
      return isMapId(m.map) ? { t: "set_map", map: m.map } : null;
    case "set_class":
      return isClassId(m.cls) ? { t: "set_class", cls: m.cls } : null;
    case "debug_teleport":
      if (typeof m.x !== "number" || typeof m.y !== "number" || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
      return { t: "debug_teleport", x: m.x, y: m.y };
    case "debug_score": {
      const ok = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99;
      if (!ok(m.A) || !ok(m.B)) return null;
      return { t: "debug_score", A: m.A as number, B: m.B as number };
    }
    case "debug_stats":
      return { t: "debug_stats" };
    case "debug_phase":
      if (!PHASES.includes(m.phase as Phase)) return null;
      return { t: "debug_phase", phase: m.phase as Phase };
    case "leave":
      return { t: "leave" };
    default:
      return null;
  }
}
