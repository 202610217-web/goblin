// GameRoom Durable Object: 방 1개를 담당한다.
// - WebSocket Hibernation API 사용 (ctx.acceptWebSocket + webSocketMessage/Close 핸들러)
// - 타이머는 Alarm 1개 + 마감 시각 목록(deadlines)으로 처리
// - 메모리는 Hibernation 때 사라질 수 있으므로 방 상태는 storage에 저장한다.
import { DurableObject } from "cloudflare:workers";
import {
  MAX_MESSAGE_BYTES,
  MAX_SOCKETS_PER_ROOM,
  MOVE_PERSIST_INTERVAL_MS,
  JUMP_RATE_LIMIT_PER_SEC,
  MOVE_RATE_LIMIT_PER_SEC,
  MSG_RATE_LIMIT_PER_SEC,
  PING_MESSAGE,
  PONG_MESSAGE,
  RECONNECT_GRACE_MS,
  SESSION_TOKEN_BYTES,
  SPAWNS,
} from "./constants";
import { type Body, makeBody, roundBody, withAngle, withJump } from "../../shared/sim";
import { type Deadline, nextDeadlineAt, removeDeadline, splitDue, upsertDeadline } from "./deadlines";
import { assignTeam, canSwitchTeam, sanitizeNickname } from "./lobby";
import {
  type PhaseState,
  canMoveIn,
  canStartMatch,
  forcePhase,
  initialPhase,
  nextOnTimeout,
  startMatch,
} from "./phase";
import {
  type ClientMessage,
  type ConnState,
  type ErrorCode,
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
  ready: boolean;
  /** 물리 상태 (마지막 이벤트 시각 기준. 현재 위치는 simulate로 계산) */
  body: Body;
  /** 클라이언트가 마지막으로 원한 이동 각도. 이동 불가 단계에서 받은 입력도 기억했다가 이동 가능해지면 적용 */
  wantA: number;
  /** 마지막으로 처리한 입력 순번 (클라이언트 예측 보정용) */
  seq: number;
}

/** storage에 저장되는 방 상태 */
interface RoomState extends PhaseState {
  code: string;
  players: PlayerRecord[];
  deadlines: Deadline[];
}

/** 소켓마다 붙여두는 정보 (Hibernation 후에도 유지됨) */
interface SocketAttachment {
  playerId: string | null;
}

/** 1초 창 레이트 리밋 카운터 */
interface RateWindow {
  windowStart: number;
  count: number;
}

const STATE_KEY = "room";

/** 팀 안 index번째 시작 위치에 선 물리 상태 */
function spawnBody(team: Team, index: number, now: number): Body {
  const list = SPAWNS[team];
  const p = list[Math.min(index, list.length - 1)]!;
  return makeBody(p.x, p.y, now);
}

/** 지금 시각에 그 자리에 멈춘 상태 */
function stopped(b: Body, now: number): Body {
  return roundBody(withAngle(b, -1, now));
}

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

function emptyState(code: string): RoomState {
  return { code, ...initialPhase(), players: [], deadlines: [] };
}

/** 1초 창 안에서 limit 개까지 허용 */
function allowInWindow(map: Map<WebSocket, RateWindow>, ws: WebSocket, limit: number, now: number): boolean {
  const r = map.get(ws);
  if (!r || now - r.windowStart >= 1000) {
    map.set(ws, { windowStart: now, count: 1 });
    return true;
  }
  r.count++;
  return r.count <= limit;
}

export class GameRoom extends DurableObject<Env> {
  private state: RoomState | null = null;
  /** 연결별 레이트 리밋 (메모리 전용. Hibernation으로 사라져도 문제 없음) */
  private rate = new Map<WebSocket, RateWindow>();
  private moveRate = new Map<WebSocket, RateWindow>();
  private jumpRate = new Map<WebSocket, RateWindow>();
  /** 이동 상태가 아직 storage에 저장되지 않았는지 */
  private movesDirty = false;
  private lastSaveAt = 0;

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
      this.state = emptyState(code);
      await this.save();
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server); // ws.accept()는 쓰지 않는다 (Hibernation)
    server.serializeAttachment({ playerId: null } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- 메시지 ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) {
      return this.sendError(ws, "bad_message", "잘못된 메시지");
    }
    if (!allowInWindow(this.rate, ws, MSG_RATE_LIMIT_PER_SEC, now)) {
      return this.sendError(ws, "rate_limited", "메시지가 너무 많아요");
    }
    const msg = parseClientMessage(raw);
    if (!msg) return this.sendError(ws, "bad_message", "잘못된 메시지");

    const st = await this.load();
    // 알람이 조금 늦게 와도 판정이 정확하도록, 지난 마감을 먼저 처리한다
    await this.processDue(now);

    const att = ws.deserializeAttachment() as SocketAttachment | null;
    const player = att?.playerId ? st.players.find((p) => p.id === att.playerId) : undefined;

    if (msg.t === "join") {
      if (player) return this.sendError(ws, "already_joined", "이미 입장했어요");
      return this.handleJoin(ws, st, msg, now);
    }
    if (!player) return this.sendError(ws, "not_joined", "먼저 입장해야 해요");
    await this.handlePlayerMessage(ws, st, player, msg, now);
    await this.flushMovesIfDue(now);
  }

  private async handleJoin(ws: WebSocket, st: RoomState, msg: Extract<ClientMessage, { t: "join" }>, now: number) {
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
        this.send(ws, this.welcome(existing, true, now));
        this.tryStartMatch(now);
        await this.saveAndSchedule();
        this.broadcastRoomState(now);
        return;
      }
      // 토큰이 만료/무효면 새 입장으로 처리
    }

    // 2) 새 입장 (로비에서만)
    if (st.phase !== "LOBBY") return this.reject(ws, "game_in_progress", "이미 게임이 진행 중이에요");
    const team = assignTeam(st.players);
    if (!team) return this.reject(ws, "room_full", "방이 가득 찼어요 (최대 4명)");

    const player: PlayerRecord = {
      id: randomHex(6),
      token: randomHex(SESSION_TOKEN_BYTES),
      nickname: sanitizeNickname(msg.nickname, `플레이어${st.players.length + 1}`),
      team,
      conn: "CONNECTED",
      reconnectDeadline: null,
      ready: false,
      body: spawnBody(team, st.players.filter((p) => p.team === team).length, now),
      wantA: -1,
      seq: 0,
    };
    st.players.push(player);
    ws.serializeAttachment({ playerId: player.id } satisfies SocketAttachment);
    await this.save();
    this.send(ws, this.welcome(player, false, now));
    this.broadcastRoomState(now);
  }

  private async handlePlayerMessage(ws: WebSocket, st: RoomState, player: PlayerRecord, msg: ClientMessage, now: number) {
    switch (msg.t) {
      case "set_nickname":
        player.nickname = sanitizeNickname(msg.nickname, player.nickname);
        await this.save();
        this.broadcastRoomState(now);
        return;

      case "set_team":
        if (st.phase !== "LOBBY") return this.sendError(ws, "game_in_progress", "게임 중에는 팀을 바꿀 수 없어요");
        if (!canSwitchTeam(st.players, player.id, msg.team)) {
          return this.sendError(ws, "team_full", "그 팀은 가득 찼어요 (팀당 2명)");
        }
        if (player.team === msg.team) return;
        player.team = msg.team;
        player.ready = false; // 팀을 바꾸면 준비 해제
        await this.save();
        this.broadcastRoomState(now);
        return;

      case "set_ready":
        if (st.phase !== "LOBBY") return this.sendError(ws, "wrong_phase", "로비에서만 준비할 수 있어요");
        player.ready = msg.ready;
        this.tryStartMatch(now);
        await this.saveAndSchedule();
        this.broadcastRoomState(now);
        return;

      case "move":
      case "jump": {
        // 이동은 초당 MOVE_RATE_LIMIT_PER_SEC, 점프는 초당 JUMP_RATE_LIMIT_PER_SEC 회까지만 (연결별)
        const limited = msg.t === "move"
          ? !allowInWindow(this.moveRate, ws, MOVE_RATE_LIMIT_PER_SEC, now)
          : !allowInWindow(this.jumpRate, ws, JUMP_RATE_LIMIT_PER_SEC, now);
        if (limited) {
          return this.sendError(ws, "rate_limited", "이동 메시지가 너무 많아요");
        }
        player.seq = msg.s;
        const movable = canMoveIn(st.phase);
        if (msg.t === "move") {
          player.wantA = msg.a;
          // 이동 불가 단계면 정지 상태 유지 (원하는 방향만 기억)
          const a = movable ? msg.a : -1;
          if (a !== player.body.a) player.body = roundBody(withAngle(player.body, a, now));
        } else if (movable) {
          const jumped = withJump(player.body, now); // 공중에 있으면 null (무시)
          if (jumped) player.body = roundBody(jumped);
        }
        this.movesDirty = true;
        // 바뀐 게 없어도 응답(순번 확인)은 보낸다. 서버→클라이언트 메시지는 요청 수에 포함되지 않는다
        this.broadcastMove(player);
        return;
      }

      case "debug_phase":
        if (this.env.DEBUG_COMMANDS !== "true") return this.sendError(ws, "debug_disabled", "디버그 명령이 꺼져 있어요");
        this.applyPhase(forcePhase(st, msg.phase, now), now);
        await this.saveAndSchedule();
        this.broadcastRoomState(now);
        return;

      case "leave":
        // 즉시 퇴장: 재접속 대기 없이 자리를 비운다
        ws.serializeAttachment({ playerId: null } satisfies SocketAttachment);
        await this.removePlayers([player.id], now);
        try { ws.close(1000, "left"); } catch { /* 이미 닫힘 */ }
        return;

      case "join":
        return; // 위에서 처리됨
    }
  }

  // ---------- 연결 끊김 ----------
  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* 이미 닫힘 */ }
    await this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.onSocketGone(ws);
  }

  /** 소켓이 사라졌을 때: 플레이어를 정지시키고 재접속 대기 상태로 바꾼 뒤 마감 시각 등록 */
  private async onSocketGone(ws: WebSocket) {
    this.rate.delete(ws);
    this.moveRate.delete(ws);
    this.jumpRate.delete(ws);
    const now = Date.now();
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    const st = await this.load();
    const player = att?.playerId ? st.players.find((p) => p.id === att.playerId) : undefined;
    if (player && player.conn === "CONNECTED" && this.socketsOf(player.id, ws).length === 0) {
      player.conn = "RECONNECTING";
      player.reconnectDeadline = now + RECONNECT_GRACE_MS;
      player.body = stopped(player.body, now); // 재접속 대기 중에는 정지
      player.wantA = -1;
      st.deadlines = upsertDeadline(st.deadlines, { kind: "reconnect", key: player.id, at: player.reconnectDeadline });
      await this.saveAndSchedule();
      this.broadcastRoomState(now);
    }
    await this.cleanupIfEmpty();
  }

  // ---------- 알람 (마감 시각 처리) ----------
  async alarm(): Promise<void> {
    await this.load();
    const now = Date.now();
    await this.processDue(now);
    await this.saveAndSchedule(); // 혹시 일찍 깨어났어도 다음 알람을 다시 건다
    await this.cleanupIfEmpty();
  }

  /** 지난 마감 시각들을 시각 순서대로 처리한다 */
  private async processDue(now: number) {
    const st = this.state;
    if (!st) return;
    const expired: string[] = [];
    let handled = false;
    // 알람이 많이 늦은 경우 단계가 연달아 끝났을 수 있으므로 지난 마감이 없을 때까지 반복
    for (let guard = 0; guard < 20; guard++) {
      const { due, rest } = splitDue(st.deadlines, now);
      if (due.length === 0) break;
      handled = true;
      st.deadlines = rest;
      for (const d of due) {
        if (d.kind === "phase") {
          // 단계 제한 시간 종료 → 다음 단계 (원래 마감 시각 기준으로 계산)
          if (st.phaseEndsAt !== null && st.phaseEndsAt <= now) this.applyPhase(nextOnTimeout(st, d.at), d.at);
        } else if (d.kind === "reconnect") {
          // 재접속 대기 시간 초과 → 이탈 처리
          const p = st.players.find((x) => x.id === d.key && x.conn === "RECONNECTING");
          if (p) expired.push(p.id);
        }
      }
    }
    if (!handled) return;
    if (expired.length > 0) {
      await this.removePlayers(expired, now); // 저장/브로드캐스트 포함
    } else {
      await this.saveAndSchedule();
      this.broadcastRoomState(now);
    }
  }

  // ---------- 단계 전환 ----------
  /** 로비에서 시작 조건이 맞으면 게임 시작 */
  private tryStartMatch(now: number) {
    const st = this.state;
    if (!st || st.phase !== "LOBBY" || !canStartMatch(st.players)) return;
    this.applyPhase(startMatch(now), now);
  }

  /** 새 단계 상태를 적용하고, 단계에 따른 부수 효과(위치 초기화, 정지, 마감 시각)를 처리 */
  private applyPhase(next: PhaseState, now: number) {
    const st = this.state!;
    const enteredNewRound = next.phase === "COUNTDOWN" && (st.phase !== "COUNTDOWN" || st.round !== next.round);
    const becameMovable = !canMoveIn(st.phase) && canMoveIn(next.phase);
    st.phase = next.phase;
    st.round = next.round;
    st.attackingTeam = next.attackingTeam;
    st.phaseEndsAt = next.phaseEndsAt;

    if (enteredNewRound) {
      // 라운드 시작: 모두 팀별 시작 위치로
      for (const team of ["A", "B"] as const) {
        st.players.filter((p) => p.team === team).forEach((p, i) => {
          p.body = spawnBody(team, i, now);
        });
      }
    } else if (!canMoveIn(st.phase)) {
      for (const p of st.players) p.body = stopped(p.body, now);
    } else if (becameMovable) {
      // 이동 가능해지는 순간: 준비 단계 동안 누르고 있던 방향으로 바로 출발
      for (const p of st.players) if (p.conn === "CONNECTED") p.body = roundBody(withAngle(p.body, p.wantA, now));
    }
    if (st.phase === "LOBBY") for (const p of st.players) p.ready = false;

    st.deadlines = st.phaseEndsAt === null
      ? removeDeadline(st.deadlines, "phase", "phase")
      : upsertDeadline(st.deadlines, { kind: "phase", key: "phase", at: st.phaseEndsAt });
    this.movesDirty = true;
  }

  // ---------- 도우미 ----------
  private async load(): Promise<RoomState> {
    if (!this.state) this.state = (await this.ctx.storage.get<RoomState>(STATE_KEY)) ?? emptyState("");
    return this.state;
  }

  private async save() {
    if (!this.state) return;
    await this.ctx.storage.put(STATE_KEY, this.state);
    this.movesDirty = false;
    this.lastSaveAt = Date.now();
  }

  /**
   * 이동 상태는 자주 바뀌므로 매번 저장하지 않고 최소 간격마다 저장한다 (쓰기 횟수 절약).
   * 저장 전에 DO가 잠들면 마지막 1초 이내의 방향 변경만 잃는다.
   */
  private async flushMovesIfDue(now: number) {
    if (this.movesDirty && now - this.lastSaveAt >= MOVE_PERSIST_INTERVAL_MS) await this.save();
  }

  /** 저장 후, 마감 시각 목록 중 가장 가까운 것으로 알람을 다시 건다 */
  private async saveAndSchedule() {
    await this.save();
    const next = this.state ? nextDeadlineAt(this.state.deadlines) : null;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /** 플레이어 제거. 게임 중에 인원이 빠지면 (임시 규칙) 로비로 돌아간다 */
  private async removePlayers(ids: string[], now: number) {
    const st = await this.load();
    st.players = st.players.filter((p) => !ids.includes(p.id));
    for (const id of ids) st.deadlines = removeDeadline(st.deadlines, "reconnect", id);
    if (st.phase !== "LOBBY" && ids.length > 0) {
      this.applyPhase(initialPhase(), now);
      this.broadcast({ t: "notice", code: "player_left_game", message: "플레이어가 나가서 로비로 돌아갑니다" });
    }
    await this.saveAndSchedule();
    this.broadcastRoomState(now);
    await this.cleanupIfEmpty();
  }

  /** 플레이어도 없고 열린 소켓도 없으면 저장된 상태를 모두 지운다 */
  private async cleanupIfEmpty() {
    const st = this.state;
    if (!st || st.players.length > 0) return;
    const open = this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
    if (open.length > 0) return;
    this.state = null;
    this.movesDirty = false;
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

  private welcome(p: PlayerRecord, resumed: boolean, now: number): ServerMessage {
    return { t: "welcome", playerId: p.id, token: p.token, room: this.state!.code, resumed, serverTime: now };
  }

  private publicPlayers(): PublicPlayer[] {
    return (this.state?.players ?? []).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      team: p.team,
      conn: p.conn,
      reconnectDeadline: p.reconnectDeadline,
      ready: p.ready,
      body: p.body,
      seq: p.seq,
    }));
  }

  /** 입장한 모든 소켓에 방 상태 전송 */
  private broadcastRoomState(now: number) {
    const st = this.state;
    if (!st) return;
    this.broadcast({
      t: "room_state",
      room: st.code,
      phase: st.phase,
      round: st.round,
      attackingTeam: st.attackingTeam,
      phaseEndsAt: st.phaseEndsAt,
      players: this.publicPlayers(),
      serverTime: now,
    });
  }

  /** 입력이 처리된 플레이어 1명의 물리 상태만 전송 (클라이언트가 이후 위치를 직접 계산) */
  private broadcastMove(p: PlayerRecord) {
    this.broadcast({ t: "move", id: p.id, body: p.body, s: p.seq });
  }

  private broadcast(msg: ServerMessage) {
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
