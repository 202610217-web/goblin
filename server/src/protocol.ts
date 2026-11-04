// 클라이언트 <-> 서버 WebSocket 메시지 형식 (JSON)
// 모든 메시지는 { t: "종류", ... } 모양이다.
import { type Body, isValidAngle } from "../../shared/sim";
export type { Body };
import type { WorkState } from "./work";
export type { WorkState };
import type { Combat } from "./combat";

export type Team = "A" | "B";
export type Phase = "LOBBY" | "COUNTDOWN" | "ATTACK" | "REPAIR" | "ROUND_END" | "MATCH_END";
export type ConnState = "CONNECTED" | "RECONNECTING";

const PHASES: readonly Phase[] = ["LOBBY", "COUNTDOWN", "ATTACK", "REPAIR", "ROUND_END", "MATCH_END"];

// ---------- 클라이언트 → 서버 ----------
export type ClientMessage =
  | { t: "join"; nickname: string; token?: string } // 입장 (token이 있으면 재접속 시도)
  | { t: "set_nickname"; nickname: string }
  | { t: "set_team"; team: Team }
  | { t: "set_ready"; ready: boolean } // 로비 준비 완료/취소
  /** 이동 방향 각도 단계 (-1=정지, 0~31, shared/sim.ts 참고). 방향이 바뀔 때만 보낸다. s = 입력 순번 */
  | { t: "move"; a: number; s: number }
  /** 점프 (땅에 있을 때만 서버가 허용) */
  | { t: "jump"; s: number }
  /** 집 작업 버튼 누름 / 뗌 (매 프레임 보내지 않고 이 2개만 보낸다) */
  | { t: "hold_start" }
  | { t: "hold_stop" }
  /** 타격 1회. yaw/pitch = 그 순간 카메라 방향 (화면 가운데 조준점). 서버가 광선으로 맞은 사람을 판정 */
  | { t: "attack"; yaw: number; pitch: number }
  /** 치유 버튼 누름 / 뗌 (대상은 서버가 근처의 기절한 팀원 중 가장 가까운 사람으로 고른다) */
  | { t: "revive_start" }
  | { t: "revive_stop" }
  | { t: "debug_phase"; phase: Phase } // 개발용 강제 단계 전환 (DEBUG_COMMANDS=true 일 때만)
  | { t: "debug_teleport"; x: number; y: number } // 개발용 순간이동 (DEBUG_COMMANDS=true 일 때만)
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
  /** 전투 상태 (체력, NORMAL/DOWNED/DEAD, 사망 예정 시각, 무적, 누적 기절/사망 횟수, 치유 중 정보) */
  combat: PublicCombat;
}

export type PublicCombat = Omit<Combat, "lastAttackAt"> & {
  /** 다음 타격 가능 시각 (쿨다운 표시용) */
  attackReadyAt: number;
};

export interface RoomStateMessage {
  t: "room_state";
  room: string;
  phase: Phase;
  round: number;
  attackingTeam: Team;
  /** 현재 단계 종료 시각 (서버 기준 ms). 제한 없으면 null */
  phaseEndsAt: number | null;
  work: WorkInfo;
  /** 이번 라운드가 전멸로 끝났으면 이긴 팀 (승점은 5단계) */
  roundEnd: { winner: Team; reason: "wipe" } | null;
  players: PublicPlayer[];
  serverTime: number;
}

/**
 * 집 작업 상태. 클라이언트는 현재 진행률 = progress + (지금 - since) × rate 로 부드럽게 그린다.
 * (rate는 1ms당 진행률, completesAt은 지금 속도로 100%가 되는 서버 시각)
 */
export interface WorkInfo extends WorkState {
  rate: number;
  completesAt: number | null;
  /** 체크포인트 비율 (진행률 바에 표시) */
  checkpoint: number;
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
  | "cannot_work"
  | "cannot_attack"
  | "cannot_revive";

export type ServerMessage =
  | { t: "welcome"; playerId: string; token: string; room: string; resumed: boolean; serverTime: number }
  | RoomStateMessage
  /** 한 플레이어의 이동 입력이 처리되었을 때 (body.t 시각의 물리 상태, s = 처리한 입력 순번) */
  | { t: "move"; id: string; body: Body; s: number }
  | { t: "notice"; code: "player_left_game"; message: string }
  /** 누군가 타격했을 때 (target = 맞은 사람, 빗나가면 null). 체력 변화는 함께 오는 room_state로 반영 */
  | { t: "swing"; by: string; target: string | null; serverTime: number }
  /** 집 작업 상태가 바뀌었을 때 (시작/중단/완료)만 보낸다 */
  | { t: "work"; work: WorkInfo; serverTime: number }
  | { t: "error"; code: ErrorCode; message: string };

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
      return { t: "move", a: m.a, s: m.s };
    case "jump":
      if (!isSeq(m.s)) return null;
      return { t: "jump", s: m.s };
    case "hold_start":
      return { t: "hold_start" };
    case "hold_stop":
      return { t: "hold_stop" };
    case "attack":
      if (typeof m.yaw !== "number" || typeof m.pitch !== "number" || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return null;
      return { t: "attack", yaw: m.yaw, pitch: m.pitch };
    case "revive_start":
      return { t: "revive_start" };
    case "revive_stop":
      return { t: "revive_stop" };
    case "debug_teleport":
      if (typeof m.x !== "number" || typeof m.y !== "number" || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
      return { t: "debug_teleport", x: m.x, y: m.y };
    case "debug_phase":
      if (!PHASES.includes(m.phase as Phase)) return null;
      return { t: "debug_phase", phase: m.phase as Phase };
    case "leave":
      return { t: "leave" };
    default:
      return null;
  }
}
