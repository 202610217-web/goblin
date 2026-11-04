// GameRoom Durable Object: 방 1개를 담당한다.
// - WebSocket Hibernation API 사용 (ctx.acceptWebSocket + webSocketMessage/Close 핸들러)
// - 타이머는 Alarm 1개 + 마감 시각 목록으로 처리
// - 메모리는 Hibernation 때 사라질 수 있으므로 방 상태는 storage에 저장한다.
import { DurableObject } from "cloudflare:workers";
import {
  MAX_MESSAGE_BYTES,
  MAX_SOCKETS_PER_ROOM,
  MSG_RATE_LIMIT_PER_SEC,
  PING_MESSAGE,
  PONG_MESSAGE,
  RECONNECT_GRACE_MS,
  SESSION_TOKEN_BYTES,
} from "./constants";
import { type Deadline, nextDeadlineAt, removeDeadline, splitDue, upsertDeadline } from "./deadlines";
import { assignTeam, canSwitchTeam, sanitizeNickname } from "./lobby";
import {
  type ClientMessage,
  type ConnState,
  type ErrorCode,
  type Phase,
  type PublicPlayer,
  type ServerMessage,
  type Team,
  parseClientMessage,
} from "./protocol";

/** 서버만 아는 플레이어 정보 (token은 절대 다른 사람에게 보내지 않는다) */
interface PlayerRecord {
  id: string;
  token: string;
  nickname: string;
  team: Team;
  conn: ConnState;
  reconnectDeadline: number | null;
}

/** storage에 저장되는 방 상태 */
interface RoomState {
  code: string;
  phase: Phase;
  players: PlayerRecord[];
  deadlines: Deadline[];
}

/** 소켓마다 붙여두는 정보 (Hibernation 후에도 유지됨) */
interface SocketAttachment {
  playerId: string | null;
}

const STATE_KEY = "room";

/** 추측 불가능한 랜덤 hex 문자열 */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 토큰 비교 (길이가 같으면 끝까지 비교해서 시간 차이로 추측하기 어렵게) */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class GameRoom extends DurableObject<Env> {
  private state: RoomState | null = null;
  /** 연결별 레이트 리밋 카운터 (메모리 전용. Hibernation으로 사라져도 문제 없음) */
  private rate = new Map<WebSocket, { windowStart: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // "ping" 에 대해 DO를 깨우지 않고 런타임이 바로 "pong" 응답
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MESSAGE, PONG_MESSAGE));
    // 깨어날 때 저장된 상태를 먼저 불러온다
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>(STATE_KEY)) ?? null;
    });
  }

  // ---------- 접속 ----------
  async fetch(request: Request): Promise<Response> {
    const code = request.headers.get("X-Room-Code") ?? "";
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) {
      return new Response("Too many connections", { status: 503 });
    }
    if (!this.state) {
      this.state = { code, phase: "LOBBY", players: [], deadlines: [] };
      await this.save();
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server); // ws.accept()는 쓰지 않는다 (Hibernation)
    const att: SocketAttachment = { playerId: null };
    server.serializeAttachment(att);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- 메시지 ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) {
      return this.sendError(ws, "bad_message", "잘못된 메시지");
    }
    if (!this.allowRate(ws)) return this.sendError(ws, "rate_limited", "메시지가 너무 많아요");

    const msg = parseClientMessage(raw);
    if (!msg) return this.sendError(ws, "bad_message", "잘못된 메시지");
    const st = await this.load();

    const att = ws.deserializeAttachment() as SocketAttachment | null;
    const player = att?.playerId ? st.players.find((p) => p.id === att.playerId) : undefined;

    if (msg.t === "join") {
      if (player) return this.sendError(ws, "already_joined", "이미 입장했어요");
      return this.handleJoin(ws, st, msg);
    }
    if (!player) return this.sendError(ws, "not_joined", "먼저 입장해야 해요");
    await this.handlePlayerMessage(ws, st, player, msg);
  }

  private async handleJoin(ws: WebSocket, st: RoomState, msg: Extract<ClientMessage, { t: "join" }>) {
    // 1) 토큰 재접속: 같은 자리로 복귀
    if (msg.token) {
      const existing = st.players.find((p) => safeEqual(p.token, msg.token!));
      if (existing) {
        // 같은 토큰의 이전 소켓이 아직 열려 있으면 정리 (새 소켓이 자리를 이어받음)
        for (const other of this.socketsOf(existing.id)) {
          other.serializeAttachment({ playerId: null } satisfies SocketAttachment);
          this.send(other, { t: "error", code: "replaced", message: "다른 연결에서 접속했어요" });
          try { other.close(4000, "replaced"); } catch { /* 이미 닫힘 */ }
        }
        existing.conn = "CONNECTED";
        existing.reconnectDeadline = null;
        st.deadlines = removeDeadline(st.deadlines, "reconnect", existing.id);
        ws.serializeAttachment({ playerId: existing.id } satisfies SocketAttachment);
        await this.saveAndSchedule();
        this.send(ws, { t: "welcome", playerId: existing.id, token: existing.token, room: st.code, resumed: true });
        this.broadcastRoomState();
        return;
      }
      // 토큰이 만료/무효면 새 입장으로 처리
    }

    // 2) 새 입장
    if (st.phase !== "LOBBY") {
      return this.reject(ws, "game_in_progress", "이미 게임이 진행 중이에요");
    }
    const team = assignTeam(st.players);
    if (!team) return this.reject(ws, "room_full", "방이 가득 찼어요 (최대 4명)");

    const player: PlayerRecord = {
      id: randomHex(6),
      token: randomHex(SESSION_TOKEN_BYTES),
      nickname: sanitizeNickname(msg.nickname, `플레이어${st.players.length + 1}`),
      team,
      conn: "CONNECTED",
      reconnectDeadline: null,
    };
    st.players.push(player);
    ws.serializeAttachment({ playerId: player.id } satisfies SocketAttachment);
    await this.save();
    this.send(ws, { t: "welcome", playerId: player.id, token: player.token, room: st.code, resumed: false });
    this.broadcastRoomState();
  }

  private async handlePlayerMessage(ws: WebSocket, st: RoomState, player: PlayerRecord, msg: ClientMessage) {
    switch (msg.t) {
      case "set_nickname":
        player.nickname = sanitizeNickname(msg.nickname, player.nickname);
        await this.save();
        this.broadcastRoomState();
        return;
      case "set_team":
        if (st.phase !== "LOBBY") return this.sendError(ws, "game_in_progress", "게임 중에는 팀을 바꿀 수 없어요");
        if (!canSwitchTeam(st.players, player.id, msg.team)) {
          return this.sendError(ws, "team_full", "그 팀은 가득 찼어요 (팀당 2명)");
        }
        if (player.team === msg.team) return;
        player.team = msg.team;
        await this.save();
        this.broadcastRoomState();
        return;
      case "leave":
        // 즉시 퇴장: 재접속 대기 없이 자리를 비운다
        ws.serializeAttachment({ playerId: null } satisfies SocketAttachment);
        await this.removePlayer(player.id);
        try { ws.close(1000, "left"); } catch { /* 이미 닫힘 */ }
        return;
      case "join":
        return; // 위에서 처리됨
    }
  }

  // ---------- 연결 끊김 ----------
  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.rate.delete(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* 이미 닫힘 */ }
    await this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.rate.delete(ws);
    await this.onSocketGone(ws);
  }

  /** 소켓이 사라졌을 때: 플레이어를 재접속 대기 상태로 바꾸고 마감 시각 등록 */
  private async onSocketGone(ws: WebSocket) {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    const st = await this.load();
    const player = att?.playerId ? st.players.find((p) => p.id === att.playerId) : undefined;
    if (player && player.conn === "CONNECTED" && this.socketsOf(player.id, ws).length === 0) {
      player.conn = "RECONNECTING";
      player.reconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
      st.deadlines = upsertDeadline(st.deadlines, {
        kind: "reconnect",
        key: player.id,
        at: player.reconnectDeadline,
      });
      await this.saveAndSchedule();
      this.broadcastRoomState();
    }
    await this.cleanupIfEmpty();
  }

  // ---------- 알람 (마감 시각 처리) ----------
  async alarm(): Promise<void> {
    const st = await this.load();
    const { due, rest } = splitDue(st.deadlines, Date.now());
    st.deadlines = rest;
    let changed = false;
    for (const d of due) {
      if (d.kind === "reconnect") {
        // 재접속 대기 시간 초과 → 이탈 처리 (로비에서는 자리만 비움)
        const idx = st.players.findIndex((p) => p.id === d.key && p.conn === "RECONNECTING");
        if (idx >= 0) {
          st.players.splice(idx, 1);
          changed = true;
        }
      }
    }
    await this.saveAndSchedule();
    if (changed) this.broadcastRoomState();
    await this.cleanupIfEmpty();
  }

  // ---------- 도우미 ----------
  private async load(): Promise<RoomState> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<RoomState>(STATE_KEY)) ?? {
        code: "",
        phase: "LOBBY",
        players: [],
        deadlines: [],
      };
    }
    return this.state;
  }

  private async save() {
    if (this.state) await this.ctx.storage.put(STATE_KEY, this.state);
  }

  /** 저장 후, 마감 시각 목록 중 가장 가까운 것으로 알람을 다시 건다 */
  private async saveAndSchedule() {
    await this.save();
    const next = this.state ? nextDeadlineAt(this.state.deadlines) : null;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private async removePlayer(playerId: string) {
    const st = await this.load();
    st.players = st.players.filter((p) => p.id !== playerId);
    st.deadlines = removeDeadline(st.deadlines, "reconnect", playerId);
    await this.saveAndSchedule();
    this.broadcastRoomState();
    await this.cleanupIfEmpty();
  }

  /** 플레이어도 없고 열린 소켓도 없으면 저장된 상태를 모두 지운다 */
  private async cleanupIfEmpty() {
    const st = this.state;
    if (!st || st.players.length > 0) return;
    const open = this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
    if (open.length > 0) return;
    this.state = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** 이 플레이어에 연결된 열린 소켓들 (except 제외) */
  private socketsOf(playerId: string, except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => {
      if (w === except || w.readyState !== WebSocket.OPEN) return false;
      const a = w.deserializeAttachment() as SocketAttachment | null;
      return a?.playerId === playerId;
    });
  }

  /** 1초 창 레이트 리밋 */
  private allowRate(ws: WebSocket): boolean {
    const now = Date.now();
    const r = this.rate.get(ws);
    if (!r || now - r.windowStart >= 1000) {
      this.rate.set(ws, { windowStart: now, count: 1 });
      return true;
    }
    r.count++;
    return r.count <= MSG_RATE_LIMIT_PER_SEC;
  }

  private publicPlayers(): PublicPlayer[] {
    return (this.state?.players ?? []).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      team: p.team,
      conn: p.conn,
      reconnectDeadline: p.reconnectDeadline,
    }));
  }

  /** 입장한 모든 소켓에 방 상태 전송 */
  private broadcastRoomState() {
    if (!this.state) return;
    const msg: ServerMessage = {
      t: "room_state",
      room: this.state.code,
      phase: this.state.phase,
      players: this.publicPlayers(),
      serverTime: Date.now(),
    };
    const text = JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment() as SocketAttachment | null;
      if (a?.playerId && w.readyState === WebSocket.OPEN) {
        try { w.send(text); } catch { /* 무시 */ }
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try { ws.send(JSON.stringify(msg)); } catch { /* 무시 */ }
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string) {
    this.send(ws, { t: "error", code, message });
  }

  /** 오류를 보내고 연결을 닫는다 */
  private reject(ws: WebSocket, code: ErrorCode, message: string) {
    this.sendError(ws, code, message);
    try { ws.close(4003, code); } catch { /* 무시 */ }
  }
}
