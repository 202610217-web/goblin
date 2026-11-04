// 클라이언트 <-> 서버 WebSocket 메시지 형식 (JSON)
// 모든 메시지는 { t: "종류", ... } 모양이다.

export type Team = "A" | "B";
export type Phase = "LOBBY";
export type ConnState = "CONNECTED" | "RECONNECTING";

// ---------- 클라이언트 → 서버 ----------
export type ClientMessage =
  | { t: "join"; nickname: string; token?: string } // 입장 (token이 있으면 재접속 시도)
  | { t: "set_nickname"; nickname: string }
  | { t: "set_team"; team: Team }
  | { t: "leave" }; // 완전히 나가기 (재접속 대기 없이 즉시 퇴장)

// ---------- 서버 → 클라이언트 ----------
export interface PublicPlayer {
  id: string;
  nickname: string;
  team: Team;
  conn: ConnState;
  /** 재접속 대기 마감 시각 (서버 기준 ms 타임스탬프), 연결 중이면 null */
  reconnectDeadline: number | null;
}

export interface RoomStateMessage {
  t: "room_state";
  room: string;
  phase: Phase;
  players: PublicPlayer[];
  serverTime: number;
}

export type ErrorCode =
  | "bad_message"
  | "not_joined"
  | "already_joined"
  | "room_full"
  | "team_full"
  | "game_in_progress"
  | "rate_limited"
  | "replaced";

export type ServerMessage =
  | { t: "welcome"; playerId: string; token: string; room: string; resumed: boolean }
  | RoomStateMessage
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
    case "leave":
      return { t: "leave" };
    default:
      return null;
  }
}
