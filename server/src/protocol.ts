// 클라이언트 <-> 서버 WebSocket 메시지 형식 (JSON)
// 모든 메시지는 { t: "종류", ... } 모양이다.

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
  | { t: "move"; dir: number } // 0=정지, 1~8 = 8방향 (movement.ts 참고). 방향이 바뀔 때만 보낸다
  | { t: "debug_phase"; phase: Phase } // 개발용 강제 단계 전환 (DEBUG_COMMANDS=true 일 때만)
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
  /** 이동 상태: moveAt 시각에 (x, y)에 있었고 dir 방향으로 움직이는 중 */
  x: number;
  y: number;
  dir: number;
  moveAt: number;
}

export interface RoomStateMessage {
  t: "room_state";
  room: string;
  phase: Phase;
  round: number;
  attackingTeam: Team;
  /** 현재 단계 종료 시각 (서버 기준 ms). 제한 없으면 null */
  phaseEndsAt: number | null;
  players: PublicPlayer[];
  serverTime: number;
}

/** 클라이언트가 맵을 그리고 이동을 예측하는 데 필요한 정보 */
export interface MapInfo {
  width: number;
  height: number;
  playerRadius: number;
  playerSpeed: number;
  houseSize: number;
  houses: Record<Team, { x: number; y: number }>;
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
  | "debug_disabled";

export type ServerMessage =
  | { t: "welcome"; playerId: string; token: string; room: string; resumed: boolean; map: MapInfo; serverTime: number }
  | RoomStateMessage
  /** 한 플레이어의 방향이 바뀌었을 때 (at 시각에 x,y 에서 dir 방향으로 이동 시작) */
  | { t: "move"; id: string; x: number; y: number; dir: number; at: number }
  | { t: "notice"; code: "player_left_game"; message: string }
  | { t: "error"; code: ErrorCode; message: string };

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
      if (typeof m.dir !== "number" || !Number.isInteger(m.dir) || m.dir < 0 || m.dir > 8) return null;
      return { t: "move", dir: m.dir };
    case "debug_phase":
      if (!PHASES.includes(m.phase as Phase)) return null;
      return { t: "debug_phase", phase: m.phase as Phase };
    case "leave":
      return { t: "leave" };
    default:
      return null;
  }
}
