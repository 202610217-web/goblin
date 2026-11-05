// GameRoom Durable Object: 방 1개를 담당한다.
// - WebSocket Hibernation API 사용 (ctx.acceptWebSocket + webSocketMessage/Close 핸들러)
// - 타이머는 Alarm 1개 + 마감 시각 목록(deadlines)으로 처리
// - 메모리는 Hibernation 때 사라질 수 있으므로 방 상태는 storage에 저장한다.
import { DurableObject } from "cloudflare:workers";
import {
  MAX_MESSAGE_BYTES,
  MAX_SOCKETS_PER_ROOM,
  STATE_FLUSH_MS,
  JUMP_RATE_LIMIT_PER_SEC,
  MOVE_RATE_LIMIT_PER_SEC,
  BOT_ATTACK_COOLDOWN_MS,
  BOT_THINK_MS,
  BOT_THINK_NEAR_MS,
  MSG_RATE_LIMIT_PER_SEC,
  PING_MESSAGE,
  PONG_MESSAGE,
  RECONNECT_GRACE_MS,
  SESSION_TOKEN_BYTES,
  SPAWNS,
} from "./constants";
import { type Body, angleToRad, groundHeightAt, makeBody, roundBody, simulate, withAngle, withCrouch, withJump } from "../../shared/sim";
import { MAPS, PHYS } from "../../shared/world";
import { NEON_SPAWNS } from "../../shared/neon";
import { findAimTarget } from "../../shared/aim";
import { ARROW, CLASSES, CLASS_IDS, type ClassId, STEALTH } from "../../shared/classes";
import { arrowSegmentHit, makeArrow } from "../../shared/arrow";
import { type BotPlan, decide, msToWaypoint, planFor } from "./bots";
import { inputTime } from "./lag";
import { type Score, addKill, killWinner, timeUpWinner } from "./score";
import {
  type Combat,
  applyHit,
  checkAttack,
  endStealth,
  isBehind,
  isCombatPhase,
  isHittable,
  newCombat,
  respawn,
  startStealth,
} from "./combat";
import { type Deadline, nextDeadlineAt, removeDeadline, splitDue, upsertDeadline } from "./deadlines";
import { assignTeam, canSwitchTeam, ownerId, sanitizeNickname } from "./lobby";
import {
  type PhaseState,
  canMoveIn,
  canStartMatch,
  enterPhase,
  forcePhase,
  initialPhase,
  nextOnTimeout,
  startMatch,
} from "./phase";
import {
  type ClientMessage,
  type ConnState,
  type ErrorCode,
  type MapId,
  type Phase,
  type PublicPlayer,
  type ServerMessage,
  type Team,
  type UsageStats,
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
  /** 체력, 사망/부활, 킬/데스 */
  c: Combat;
  /** 연습용 더미면 true (소켓 없음, 서버가 움직임) */
  bot?: boolean;
  /** 직업 (예전에 저장된 방에는 없을 수 있음 → 기사) */
  cls?: ClassId;
  /** 더미의 이번 단계 계획 */
  plan?: BotPlan;
  /** 마지막으로 움직인 방향 (멈춰 있을 때 바라보는 방향, 뒤치기 판정용) */
  faceA?: number;
}

/** storage에 저장되는 방 상태 */
interface RoomState extends PhaseState {
  code: string;
  /** 팀별 킬 수 */
  score: Score;
  matchWinner: Team | null;
  matchEndReason: "score" | "time" | "player_left" | null;
  /** 연습 경기인지 */
  practice: boolean;
  players: PlayerRecord[];
  deadlines: Deadline[];
}

/** 소켓마다 붙여두는 정보 (Hibernation 후에도 유지됨) */
interface SocketAttachment {
  playerId: string | null;
  /** 이 소켓이 들어온 Cloudflare 위치 (핑 진단용) */
  edge?: string;
}

/** 1초 창 레이트 리밋 카운터 */
interface RateWindow {
  windowStart: number;
  count: number;
}

const STATE_KEY = "room";

/** 타격 거부 사유 → 안내 문구 */
const ATTACK_REJECT_TEXT: Record<string, string> = {
  wrong_phase: "지금은 타격할 수 없어요",
  not_normal: "죽은 상태에서는 타격할 수 없어요",
  cooldown: "아직 타격할 수 없어요 (쿨다운)",
};

/** 이 플레이어의 직업 수치 */
const cls = (p: { cls?: ClassId }) => CLASSES[p.cls ?? "KNIGHT"];
const maxHp = (p: { cls?: ClassId }) => cls(p).maxHp;

/** 팀 안 index번째 시작(부활) 위치에 선 물리 상태. 직업별 걷는 속도도 붙인다 */
function spawnBody(p: { team: Team; cls?: ClassId }, index: number, now: number, map: MapId = "CLASSIC"): Body {
  const list = map === "NEON" ? NEON_SPAWNS[p.team] : SPAWNS[p.team];
  const at = list[index % list.length]!;
  const b = makeBody(at.x, at.y, now);
  if (cls(p).speed !== PHYS.SPEED) b.v = cls(p).speed; // 직업별 걷는 속도 (물리가 몸 상태로 계산)
  return b;
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

/** 경기 기록 초기값 */
function freshMatch() {
  return { score: { A: 0, B: 0 }, matchWinner: null, matchEndReason: null, practice: false };
}

function emptyState(code: string): RoomState {
  return { code, ...initialPhase(), map: "CLASSIC", ...freshMatch(), players: [], deadlines: [] };
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
  /** 저장 안 된 변경이 있는지, 바로 저장해야 하는지, 모아서 저장할 예정 시각 */
  private dirty = false;
  private mustSave = false;
  private flushAt: number | null = null;
  /** 지금 걸려 있는 알람 시각 (같은 값이면 setAlarm을 다시 부르지 않는다. undefined = 모름) */
  private alarmAt: number | null | undefined = undefined;
  /** 무료 한도 점검용 사용량 카운터 (메모리 전용) */
  private stats: UsageStats = { since: Date.now(), messagesIn: {}, puts: 0, alarmSets: 0, alarmDeletes: 0, alarmRuns: 0, connects: 0 };
  private lastSaveAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // "ping" 에 대해 DO를 깨우지 않고 런타임이 바로 "pong" 응답
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MESSAGE, PONG_MESSAGE));
    // 깨어날 때 저장된 상태를 먼저 불러온다
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>(STATE_KEY)) ?? null;
      this.alarmAt = await ctx.storage.getAlarm();
    });
  }

  // ---------- 접속 ----------
  async fetch(request: Request): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) {
      return new Response("Too many connections", { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (this.roomColo === null) this.roomColo = this.findRoomColo(); // 이 방 서버 위치는 한 번만 알아낸다
    await this.acceptPeer(server, request.headers.get("X-Room-Code") ?? "", request.headers.get("X-Edge-Colo") ?? "?");
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 새 연결 받기. Cloudflare(fetch)와 "내 기기로 방 열기"(호스트 기기 브라우저)가 함께 쓴다.
   * edge = 이 연결이 들어온 위치 표시 (핑 진단용)
   */
  async acceptPeer(server: WebSocket, code: string, edge: string, roomLabel?: string): Promise<void> {
    if (!this.state) {
      this.state = emptyState(code);
      await this.save();
    }
    if (roomLabel && this.roomColo === null) this.roomColo = Promise.resolve(roomLabel);
    this.ctx.acceptWebSocket(server); // ws.accept()는 쓰지 않는다 (Hibernation)
    this.stats.connects++;
    server.serializeAttachment({ playerId: null, edge } satisfies SocketAttachment);
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
    this.stats.messagesIn[msg?.t ?? "invalid"] = (this.stats.messagesIn[msg?.t ?? "invalid"] ?? 0) + 1;
    if (!msg) return this.sendError(ws, "bad_message", "잘못된 메시지");

    const st = await this.load();
    // 알람이 조금 늦게 와도 판정이 정확하도록, 지난 마감을 먼저 처리한다
    await this.processDue(now);

    const att = ws.deserializeAttachment() as SocketAttachment | null;
    const player = att?.playerId ? st.players.find((p) => p.id === att.playerId) : undefined;

    if (msg.t === "join") {
      if (player) return this.sendError(ws, "already_joined", "이미 입장했어요");
      await this.handleJoin(ws, st, msg, now);
      return this.persist();
    }
    if (!player) return this.sendError(ws, "not_joined", "먼저 입장해야 해요");
    await this.handlePlayerMessage(ws, st, player, msg, now);
    await this.persist();
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
        existing.seq = 0; // 새로고침한 화면은 입력 순번을 1부터 다시 센다
        st.deadlines = removeDeadline(st.deadlines, "reconnect", existing.id);
        ws.serializeAttachment({ ...(ws.deserializeAttachment() as SocketAttachment), playerId: existing.id } satisfies SocketAttachment);
        this.send(ws, this.welcome(existing, true, now, (ws.deserializeAttachment() as SocketAttachment | null)?.edge ?? "?", await (this.roomColo ?? Promise.resolve("?"))));
        await this.commit();
        this.broadcastRoomState(now);
        return;
      }
      // 토큰이 만료/무효면 새 입장으로 처리
    }

    // 2) 새 입장 (로비에서만)
    if (st.phase !== "LOBBY") return this.reject(ws, "game_in_progress", "이미 게임이 진행 중이에요");
    // 로비에서 자리가 다 찼는데 더미가 있으면, 더미 하나가 자리를 비켜 준다
    if (!assignTeam(st.players)) {
      const bots = st.players.filter((p) => p.bot);
      if (bots.length > 0) st.players = st.players.filter((p) => p !== bots[bots.length - 1]);
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
      ready: false,
      body: spawnBody({ team }, st.players.filter((p) => p.team === team).length, now, st.map),
      wantA: -1,
      seq: 0,
      c: newCombat(),
    };
    st.players.push(player);
    ws.serializeAttachment({ ...(ws.deserializeAttachment() as SocketAttachment), playerId: player.id } satisfies SocketAttachment);
    await this.save();
    this.send(ws, this.welcome(player, false, now, (ws.deserializeAttachment() as SocketAttachment | null)?.edge ?? "?", await (this.roomColo ?? Promise.resolve("?"))));
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
        await this.commit();
        this.broadcastRoomState(now);
        return;

      case "move":
      case "jump":
      case "crouch": {
        // 이동은 초당 MOVE_RATE_LIMIT_PER_SEC, 점프는 초당 JUMP_RATE_LIMIT_PER_SEC 회까지만 (연결별)
        const limited = msg.t === "move"
          ? !allowInWindow(this.moveRate, ws, MOVE_RATE_LIMIT_PER_SEC, now)
          : !allowInWindow(this.jumpRate, ws, JUMP_RATE_LIMIT_PER_SEC, now);
        if (limited) {
          return this.sendError(ws, "rate_limited", "이동 메시지가 너무 많아요");
        }
        // 기기 직접 연결의 빠른 통로는 순서를 지키지 않으므로, 더 새 입력보다 늦게 온 이동은 버린다
        if (msg.t === "move" && msg.s < player.seq) return;
        player.seq = Math.max(player.seq, msg.s);
        // 경기 중이 아니거나 죽었으면 그 자리에 고정 (이동 의도만 기억했다가 풀리면 적용)
        const movable = this.canMoveNow(player);
        // 화면에서 누른 시각 기준으로 처리 (화면 예측과 같은 계산 → 내 캐릭터가 뒤로 당겨지지 않음)
        const at = inputTime(msg.at, player.body.t, now);
        if (msg.t === "move") {
          player.wantA = msg.a;
          if (msg.a >= 0) player.faceA = msg.a;
          // 이동 불가 단계면 정지 상태 유지 (원하는 방향만 기억)
          const a = movable ? msg.a : -1;
          if (a !== player.body.a) player.body = roundBody(withAngle(player.body, a, at));
        } else if (msg.t === "crouch") {
          if (movable || !msg.on) player.body = roundBody(withCrouch(player.body, msg.on, at)); // 일어서기는 언제나
          // 고블린: 앉으면 은신, 일어서면 은신 끝
          const before = player.c.stealthUntil;
          if (cls(player).sneaky) player.c = player.body.k ? startStealth(player.c, now) : endStealth(player.c, now);
          if (player.c.stealthUntil !== before) this.broadcastRoomState(now);
        } else if (movable) {
          const jumped = withJump(player.body, at); // 공중에 있으면 null (무시)
          if (jumped) player.body = roundBody(jumped);
        }
        this.markDirty();
        // 바뀐 게 없어도 응답(순번 확인)은 보낸다. 서버→클라이언트 메시지는 요청 수에 포함되지 않는다
        this.broadcastMove(player);
        return;
      }

      case "attack": {
        const reason = checkAttack(player.c, st.phase, now, cls(player).cooldownMs);
        if (reason) return this.sendError(ws, "cannot_attack", ATTACK_REJECT_TEXT[reason]!);
        this.performAttack(player, msg.yaw, msg.pitch, now);
        await this.commit();
        this.broadcastRoomState(now);
        return;
      }

      case "debug_score":
        if (this.env.DEBUG_COMMANDS !== "true") return this.sendError(ws, "debug_disabled", "디버그 명령이 꺼져 있어요");
        st.score = { A: msg.A, B: msg.B };
        await this.save();
        this.broadcastRoomState(now);
        return;

      case "debug_stats":
        if (this.env.DEBUG_COMMANDS !== "true") return this.sendError(ws, "debug_disabled", "디버그 명령이 꺼져 있어요");
        this.send(ws, { t: "debug_stats", stats: this.stats });
        return;

      case "add_bots": {
        if (st.phase !== "LOBBY") return this.sendError(ws, "wrong_phase", "로비에서만 더미를 넣을 수 있어요");
        // 빈자리(최대 4명, 팀당 2명)를 더미로 채운다
        let n = st.players.filter((p) => p.bot).length;
        for (let team = assignTeam(st.players); team; team = assignTeam(st.players)) {
          n++;
          st.players.push({
            id: randomHex(6), token: randomHex(SESSION_TOKEN_BYTES), nickname: `더미${n}`, team,
            conn: "CONNECTED", reconnectDeadline: null, ready: true,
            body: spawnBody({ team }, st.players.filter((p) => p.team === team).length, now, st.map),
            wantA: -1, seq: 0, c: newCombat(), bot: true,
          });
        }
        this.mustSave = true;
        await this.commit();
        this.broadcastRoomState(now);
        return;
      }

      case "remove_bots":
        if (st.phase !== "LOBBY") return this.sendError(ws, "wrong_phase", "로비에서만 더미를 뺄 수 있어요");
        st.players = st.players.filter((p) => !p.bot);
        this.mustSave = true;
        await this.commit();
        this.broadcastRoomState(now);
        return;

      case "start_game":
      case "start_practice":
        if (st.phase !== "LOBBY") return this.sendError(ws, "wrong_phase", "로비에서만 시작할 수 있어요");
        if (ownerId(st.players) !== player.id) return this.sendError(ws, "not_owner", "방장만 시작할 수 있어요");
        if (msg.t === "start_game" && !canStartMatch(st.players)) return this.sendError(ws, "wrong_phase", "4명이 2대2로 모두 준비해야 시작할 수 있어요");
        this.startMatchNow(now, msg.t === "start_practice" || st.players.some((p) => p.bot));
        await this.commit();
        this.broadcastRoomState(now);
        return;

      case "set_map":
        if (st.phase !== "LOBBY") return this.sendError(ws, "wrong_phase", "로비에서만 맵을 바꿀 수 있어요");
        if (ownerId(st.players) !== player.id) return this.sendError(ws, "not_owner", "방장만 맵을 고를 수 있어요");
        st.map = msg.map;
        // 로비에서도 고른 맵에 서 있도록 시작 위치로 옮긴다
        for (const team of ["A", "B"] as const) {
          st.players.filter((p) => p.team === team).forEach((p, i) => { p.body = spawnBody(p, i, now, st.map); });
        }
        this.mustSave = true;
        await this.commit();
        this.broadcastRoomState(now);
        return;

      case "set_class":
        if (st.phase !== "CLASS_SELECT") return this.sendError(ws, "wrong_phase", "직업은 경기 시작 직후에만 고를 수 있어요");
        player.cls = msg.cls;
        this.mustSave = true;
        await this.commit();
        this.broadcastRoomState(now);
        return;

      case "rematch":
        if (st.phase !== "MATCH_END") return this.sendError(ws, "wrong_phase", "경기가 끝난 뒤에만 다시 할 수 있어요");
        this.applyPhase(initialPhase(), now); // 로비로: 모두 다시 준비하면 새 경기
        await this.commit();
        this.broadcastRoomState(now);
        return;

      case "debug_teleport": {
        if (this.env.DEBUG_COMMANDS !== "true") return this.sendError(ws, "debug_disabled", "디버그 명령이 꺼져 있어요");
        const m = MAPS[st.map ?? "CLASSIC"], H = 0.4;
        const x = Math.min(m.x1 - H, Math.max(m.x0 + H, msg.x));
        const y = Math.min(m.y1 - H, Math.max(m.y0 + H, msg.y));
        player.body = { ...makeBody(x, y, now), z: groundHeightAt(x, y, 100), v: player.body.v };
        this.markDirty();
        this.broadcastMove(player);
        return;
      }

      case "debug_phase":
        if (this.env.DEBUG_COMMANDS !== "true") return this.sendError(ws, "debug_disabled", "디버그 명령이 꺼져 있어요");
        this.applyPhase(forcePhase(st, msg.phase, now), now);
        await this.commit();
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
      this.mustSave = true;
      player.reconnectDeadline = now + RECONNECT_GRACE_MS;
      player.wantA = -1;
      player.body = stopped(player.body, now); // 재접속 대기 중에는 정지
      st.deadlines = upsertDeadline(st.deadlines, { kind: "reconnect", key: player.id, at: player.reconnectDeadline });
      await this.commit();
      this.broadcastRoomState(now);
    }
    await this.cleanupIfEmpty();
  }

  // ---------- 알람 (마감 시각 처리) ----------
  async alarm(): Promise<void> {
    this.stats.alarmRuns++;
    this.alarmAt = null; // 알람은 울리면 사라진다
    await this.load();
    const now = Date.now();
    await this.processDue(now);
    if (this.dirty && this.flushAt !== null && this.flushAt <= now) this.mustSave = true; // 모아 둔 변경 저장 시각
    await this.persist(); // 다음 알람을 다시 건다 (일찍 깨어났어도)
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
          // 단계 제한 시간 종료 (원래 마감 시각 기준으로 계산). 경기 시간이 끝나면 킬이 많은 팀 승리
          if (st.phaseEndsAt === null || st.phaseEndsAt > now) continue;
          if (st.phase === "PLAY") this.endMatch(timeUpWinner(st.score), "time", d.at);
          else this.applyPhase(nextOnTimeout(st, d.at), d.at);
        } else if (d.kind === "bot") {
          this.botsThink(d.at);
        } else if (d.kind === "respawn") {
          this.onRespawnDue(d.key, d.at);
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
      await this.commit();
      this.broadcastRoomState(now);
    }
  }

  // ---------- 전투 ----------
  /** 지금 움직일 수 있는지: 경기 중 + 살아 있음 + 접속 중 */
  private canMoveNow(p: PlayerRecord): boolean {
    return canMoveIn(this.state!.phase) && p.conn === "CONNECTED" && p.c.state === "NORMAL";
  }

  /** 상태에 맞게 이동을 다시 맞춘다 (움직일 수 있으면 원하는 방향으로, 아니면 정지) */
  private refreshMotion(p: PlayerRecord, now: number) {
    const a = this.canMoveNow(p) ? p.wantA : -1;
    if (a !== p.body.a) {
      p.body = roundBody(withAngle(p.body, a, now));
      this.markDirty();
    }
  }

  /** 부활 시각: 우리 팀 시작 위치에서 체력 가득 + 잠깐 무적 */
  private onRespawnDue(id: string, at: number) {
    const st = this.state!;
    const p = st.players.find((x) => x.id === id);
    if (!p || p.c.state !== "DEAD" || st.phase !== "PLAY") return;
    p.c = respawn(p.c, at, maxHp(p));
    // 같은 팀 두 명이 번갈아 두 시작 위치를 쓴다 (죽은 횟수로 고름 → 한 자리에 겹치지 않게)
    p.body = spawnBody(p, st.players.filter((q) => q.team === p.team).indexOf(p) + p.c.deaths, at, st.map);
    this.refreshMotion(p, at);
    if (p.bot) p.plan = planFor(p.team, st.players.filter((q) => q.bot && q.team === p.team).indexOf(p), st.map ?? "CLASSIC", p.body);
    this.broadcastMove(p);
    this.scheduleBots(at, 50);
  }

  // ---------- 사람과 더미가 같이 쓰는 행동 ----------
  /** 타격: 조준 광선(yaw/pitch)으로 맞은 상대를 찾아 체력 처리. 검증은 부르는 쪽에서 한다 */
  private performAttack(player: PlayerRecord, yaw: number, pitch: number, now: number): PlayerRecord | null {
    const st = this.state!;
    player.c = endStealth({ ...player.c, lastAttackAt: now }, now); // 공격하면 모습이 드러난다
    const me = simulate(player.body, now);
    if (cls(player).ranged) {
      this.fireArrow(player, me, yaw, pitch, now);
      return null; // 맞았는지는 화살이 날아간 뒤 판정
    }
    const candidates = st.players
      .filter((p) => p.team !== player.team && isHittable(p.c, now))
      .map((p) => ({ id: p.id, body: simulate(p.body, now), p }));
    const hit = findAimTarget(me, yaw, pitch, candidates);
    // 고블린 뒤치기: 대상이 바라보는 방향(움직이는 방향, 멈췄으면 마지막 방향)의 등 뒤에서 맞히면 1.5배
    const faceA = hit ? (hit.p.body.a >= 0 ? hit.p.body.a : hit.p.faceA) : undefined;
    const back = !!hit && !!cls(player).sneaky && faceA !== undefined && isBehind(hit.body, angleToRad(faceA), me);
    this.landHit(player.id, hit?.p ?? null, now, Math.round(cls(player).damage * (back ? STEALTH.BACKSTAB : 1)));
    return hit?.p ?? null;
  }

  /** 맞은 뒤 처리 (근접/화살 공통): 체력, 죽으면 킬 점수·부활 예약, swing 방송, 15킬이면 경기 끝 */
  private landHit(by: string, target: PlayerRecord | null, now: number, damage: number) {
    const st = this.state!;
    if (target) {
      const wasAlive = target.c.state === "NORMAL";
      target.c = applyHit(target.c, now, damage);
      if (wasAlive && target.c.state === "DEAD") {
        const killer = st.players.find((p) => p.id === by);
        if (killer) {
          killer.c = { ...killer.c, kills: killer.c.kills + 1 };
          st.score = addKill(st.score, killer.team);
        }
        st.deadlines = upsertDeadline(st.deadlines, { kind: "respawn", key: target.id, at: target.c.respawnAt! });
        this.refreshMotion(target, now); // 죽으면 그 자리에 멈춤
      }
    }
    this.broadcast({ t: "swing", by, target: target?.id ?? null, serverTime: now });
    const winner = killWinner(st.score);
    if (winner) this.endMatch(winner, "score", now);
  }

  /** 화살: 쏜 걸 알리고 50ms마다 지나간 구간을 판정. 메모리 타이머만 쓰고 저장하지 않는다 (0.4초면 끝남) */
  private fireArrow(shooter: PlayerRecord, me: Body, yaw: number, pitch: number, now: number) {
    const arrow = makeArrow(me, yaw, pitch, now, cls(shooter).proj);
    this.broadcast({ t: "shot", by: shooter.id, ...arrow });
    let from = now;
    const step = async () => {
      const st = this.state;
      if (!st || !isCombatPhase(st.phase)) return; // 라운드가 끝났으면 화살은 버린다
      const to = Math.max(from, Date.now());
      const r = arrowSegmentHit(arrow, from, to, st.players.filter((p) => p.team !== shooter.team && isHittable(p.c, to)));
      if (r.hit) {
        this.landHit(shooter.id, r.hit, to, cls(shooter).damage);
        await this.commit();
        this.broadcastRoomState(to);
      } else if (!r.stopped) {
        from = to;
        setTimeout(step, ARROW.STEP_MS);
      }
    };
    setTimeout(step, ARROW.STEP_MS);
  }

  // ---------- 연습용 더미 ----------
  /** 더미가 있고 경기 중이면 delay 뒤에 생각하도록 마감 시각을 건다 (아니면 지운다) */
  private scheduleBots(now: number, delay: number) {
    const st = this.state!;
    const active = canMoveIn(st.phase) && st.players.some((p) => p.bot);
    st.deadlines = active
      ? upsertDeadline(st.deadlines, { kind: "bot", key: "think", at: now + delay })
      : removeDeadline(st.deadlines, "bot", "think");
  }

  /** 더미들이 생각하고 움직인다 (알람으로 불림) */
  private botsThink(now: number) {
    const st = this.state!;
    if (!canMoveIn(st.phase)) return;
    let next = BOT_THINK_MS;
    let changed = false;
    const seen = (p: PlayerRecord) => ({ id: p.id, team: p.team, body: simulate(p.body, now), c: p.c });
    for (const bot of st.players) {
      if (!bot.bot || !bot.plan) continue;
      const me = seen(bot);
      const enemies = st.players.filter((p) => p.team !== bot.team && now >= (p.c.stealthUntil ?? 0)).map(seen); // 은신한 상대는 못 본다
      const canAttack = !checkAttack(bot.c, st.phase, now, cls(bot).cooldownMs) && now - bot.c.lastAttackAt >= BOT_ATTACK_COOLDOWN_MS;
      const d = decide(me, bot.plan, enemies, { canAttack, proj: cls(bot).proj ?? null });
      if (d.attack) {
        this.performAttack(bot, d.attack.yaw, d.attack.pitch, now);
        changed = true;
        if (!canMoveIn(st.phase)) return; // 15킬로 경기가 끝났으면 그만
      }
      if (d.arrived) {
        // 길 끝: 상대 진영 ↔ 맵 가운데를 오가며 순찰
        const slot = st.players.filter((q) => q.bot && q.team === bot.team).indexOf(bot);
        bot.plan = planFor(bot.team, slot, st.map ?? "CLASSIC", me.body, !bot.plan.back);
        next = Math.min(next, 120);
      }
      const before = bot.body.a;
      bot.wantA = d.angle;
      if (d.angle >= 0) bot.faceA = d.angle;
      this.refreshMotion(bot, now);
      if (bot.body.a !== before) this.broadcastMove(bot);
      if (d.enemyNear) next = Math.min(next, BOT_THINK_NEAR_MS);
      // 다음 지점에 도착할 때쯤 다시 생각 (지나치지 않게)
      if (bot.body.a >= 0) {
        const t = msToWaypoint(me.body, bot.plan, PHYS.SPEED);
        if (t !== null) next = Math.min(next, Math.max(120, t));
      }
    }
    if (changed) this.broadcastRoomState(now);
    this.scheduleBots(now, next);
    this.markDirty();
  }

  /** 경기 끝: 이긴 팀(무승부면 null)과 이유를 남기고 결과 화면으로 */
  private endMatch(winner: Team | null, reason: "score" | "time", at: number) {
    const st = this.state!;
    if (st.phase !== "PLAY") return;
    st.matchWinner = winner;
    st.matchEndReason = reason;
    this.applyPhase(enterPhase(st, "MATCH_END", at), at);
  }

  // ---------- 단계 전환 ----------
  /** 경기 시작 (practice = 연습 경기: 인원이 모자라거나 더미가 있는 경기) */
  private startMatchNow(now: number, practice: boolean) {
    const st = this.state!;
    for (const p of st.players) {
      if (p.bot) p.cls = CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)]!;
      p.ready = true;
    }
    Object.assign(st, freshMatch());
    st.practice = practice;
    this.applyPhase(startMatch(st, now), now);
  }

  /** 새 단계 상태를 적용하고, 단계에 따른 부수 효과(위치·체력 초기화, 정지, 마감 시각)를 처리 */
  private applyPhase(next: PhaseState, now: number) {
    const st = this.state!;
    const phaseChanged = next.phase !== st.phase;
    st.phase = next.phase;
    st.phaseEndsAt = next.phaseEndsAt;

    if (st.phase === "LOBBY") {
      for (const p of st.players) { p.ready = false; p.c = newCombat(maxHp(p)); }
      Object.assign(st, freshMatch());
    }
    if (st.phase !== "PLAY") st.deadlines = st.deadlines.filter((d) => d.kind !== "respawn");
    if (phaseChanged && st.phase === "COUNTDOWN") {
      // 시작 직전: 고른 직업의 체력으로, 팀별 시작 위치에 (킬/데스 0)
      for (const team of ["A", "B"] as const) {
        st.players.filter((p) => p.team === team).forEach((p, i) => {
          p.c = newCombat(maxHp(p));
          p.body = spawnBody(p, i, now, st.map);
        });
      }
    }
    // 이동 가능해지면 누르고 있던 방향으로 바로 출발, 불가능해지면 정지
    for (const p of st.players) this.refreshMotion(p, now);

    st.deadlines = st.phaseEndsAt === null
      ? removeDeadline(st.deadlines, "phase", "phase")
      : upsertDeadline(st.deadlines, { kind: "phase", key: "phase", at: st.phaseEndsAt });
    // 더미: 경기가 시작되면 순찰 계획을 세우고 생각하기 시작, 아니면 멈춤
    if (phaseChanged && st.phase === "PLAY") {
      for (const team of ["A", "B"] as const) {
        st.players.filter((p) => p.bot && p.team === team).forEach((p, i) => {
          p.plan = planFor(team, i, st.map ?? "CLASSIC", simulate(p.body, now));
        });
      }
    }
    this.scheduleBots(now, 50);
    this.markDirty();
    this.mustSave = true; // 단계 전환은 드물고 중요하므로 바로 저장
  }

  // ---------- 도우미 ----------
  private async load(): Promise<RoomState> {
    if (!this.state) this.state = (await this.ctx.storage.get<RoomState>(STATE_KEY)) ?? emptyState("");
    return this.state;
  }

  private async save() {
    if (!this.state) return;
    await this.ctx.storage.put(STATE_KEY, this.state);
    this.stats.puts++;
    this.dirty = false;
    this.mustSave = false;
    this.flushAt = null;
    this.lastSaveAt = Date.now();
  }

  /** 저장 안 된 변경이 생겼다고 표시. STATE_FLUSH_MS 안에 저장되도록 예정 시각을 잡는다 */
  private markDirty() {
    this.dirty = true;
    // 호스트 기기(메모리 전용)는 저장할 곳이 없으므로 모아서 저장하는 알람을 걸지 않는다 (기기 부담 줄이기)
    if (this.env.MEMORY_ONLY === "true") return;
    if (this.flushAt === null) this.flushAt = Date.now() + STATE_FLUSH_MS;
  }

  /** 상태가 바뀐 뒤 부른다: 변경 표시 + (필요하면) 저장 + 알람 맞추기 */
  private async commit() {
    this.markDirty();
    await this.persist();
  }

  /** 바로 저장해야 하면 저장하고, 마감 시각 목록과 모아서 저장할 시각 중 가장 빠른 시각으로 알람을 맞춘다 */
  private async persist() {
    if (!this.state) return;
    if (this.mustSave) await this.save();
    let next = nextDeadlineAt(this.state.deadlines);
    if (this.dirty && this.flushAt !== null && (next === null || this.flushAt < next)) next = this.flushAt;
    if (next === this.alarmAt) return; // 이미 그 시각으로 걸려 있으면 쓰지 않는다 (setAlarm도 쓴 행 1개)
    if (next === null) { await this.ctx.storage.deleteAlarm(); this.stats.alarmDeletes++; }
    else { await this.ctx.storage.setAlarm(next); this.stats.alarmSets++; }
    this.alarmAt = next;
  }

  /** 플레이어 제거. 게임 중에 인원이 빠지면 (임시 규칙) 로비로 돌아간다 */
  private async removePlayers(ids: string[], now: number) {
    const st = await this.load();
    st.players = st.players.filter((p) => !ids.includes(p.id));
    if (!st.players.some((p) => !p.bot)) st.players = []; // 사람이 아무도 없으면 더미도 정리
    this.mustSave = true;
    for (const id of ids) st.deadlines = removeDeadline(st.deadlines, "reconnect", id);
    if (st.phase !== "LOBBY" && st.phase !== "MATCH_END" && ids.length > 0 && st.players.length > 0) {
      // 이탈 처리(단순 규칙): 경기를 끝내고 결과 화면으로. "다시 하기"를 누르면 로비로 돌아간다
      st.matchWinner = null;
      st.matchEndReason = "player_left";
      this.applyPhase(enterPhase(st, "MATCH_END", now), now);
      this.broadcast({ t: "notice", code: "player_left_game", message: "플레이어가 나가서 경기가 끝났어요" });
    }
    await this.commit();
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
    this.dirty = false;
    this.mustSave = false;
    this.flushAt = null;
    this.alarmAt = null;
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

  private welcome(p: PlayerRecord, resumed: boolean, now: number, edge: string, roomColo: string): ServerMessage {
    return { t: "welcome", playerId: p.id, token: p.token, room: this.state!.code, resumed, serverTime: now, edge, roomColo };
  }

  /** 이 Durable Object가 실행 중인 Cloudflare 위치 (cdn-cgi/trace의 colo=). 실패하면 "?" */
  private roomColo: Promise<string> | null = null;
  private async findRoomColo(): Promise<string> {
    try {
      // 0.8초 안에 답이 없으면 포기 (입장이 늦어지지 않게)
      const text = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(800) })).text();
      return /colo=(\w+)/.exec(text)?.[1] ?? "?";
    } catch {
      return "?";
    }
  }

  private publicPlayers(): PublicPlayer[] {
    const owner = ownerId(this.state?.players ?? []);
    return (this.state?.players ?? []).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      team: p.team,
      conn: p.conn,
      reconnectDeadline: p.reconnectDeadline,
      ready: p.ready,
      body: p.body,
      seq: p.seq,
      combat: {
        hp: p.c.hp,
        state: p.c.state,
        respawnAt: p.c.respawnAt,
        invulnUntil: p.c.invulnUntil,
        kills: p.c.kills,
        deaths: p.c.deaths,
        attackReadyAt: p.c.lastAttackAt + cls(p).cooldownMs,
        stealthUntil: p.c.stealthUntil,
        stealthReadyAt: p.c.stealthReadyAt,
      },
      bot: !!p.bot,
      cls: p.cls ?? "KNIGHT",
      owner: p.id === owner,
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
      phaseEndsAt: st.phaseEndsAt,
      map: st.map ?? "CLASSIC",
      score: st.score,
      matchWinner: st.matchWinner,
      matchEndReason: st.matchEndReason,
      practice: st.practice,
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
