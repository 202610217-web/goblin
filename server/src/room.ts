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
  ATTACK_COOLDOWN_MS,
  MSG_RATE_LIMIT_PER_SEC,
  PING_MESSAGE,
  PONG_MESSAGE,
  RECONNECT_GRACE_MS,
  SESSION_TOKEN_BYTES,
  SPAWNS,
} from "./constants";
import { type Body, groundHeightAt, makeBody, roundBody, simulate, withAngle, withJump } from "../../shared/sim";
import { PHYS, isNearHouse } from "../../shared/world";
import { AIM, findAimTarget, inReach } from "../../shared/aim";
import {
  type Combat,
  applyDeath,
  checkAttack,
  checkReviveStart,
  completeRevive,
  isHittable,
  newCombat,
  resetForRound,
  resolveHit,
  startRevive,
  stopRevive,
  wipeWinner,
} from "./combat";
import {
  type HoldRejectReason,
  type WorkState,
  checkHoldStart,
  completionAt,
  isComplete,
  startHold,
  stopHold,
  targetHouseTeam,
  workForPhase,
  workRate,
  DEFAULT_WORK_RULES,
} from "./work";
import { type Deadline, nextDeadlineAt, removeDeadline, splitDue, upsertDeadline } from "./deadlines";
import { assignTeam, canSwitchTeam, sanitizeNickname } from "./lobby";
import {
  type PhaseState,
  canMoveIn,
  canStartMatch,
  forcePhase,
  initialPhase,
  nextOnTimeout,
  nextOnWorkComplete,
  startMatch,
  enterPhase,
} from "./phase";
import {
  type ClientMessage,
  type ConnState,
  type ErrorCode,
  type PublicPlayer,
  type ServerMessage,
  type Team,
  type WorkInfo,
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
  /** 체력, 기절/사망, 치유 상태 */
  c: Combat;
}

/** storage에 저장되는 방 상태 */
interface RoomState extends PhaseState {
  code: string;
  /** 집 작업(부수기/수리) 상태 */
  work: WorkState;
  /** 이번 라운드가 전멸로 끝났으면 이긴 팀 (승점은 5단계) */
  roundEnd: { winner: Team; reason: "wipe" } | null;
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

/** hold_start 거부 사유 → 안내 문구 */
const ATTACK_REJECT_TEXT: Record<string, string> = {
  wrong_phase: "지금은 타격할 수 없어요",
  not_normal: "기절/사망 상태에서는 타격할 수 없어요",
  busy: "작업이나 치유 중에는 타격할 수 없어요",
  cooldown: "아직 타격할 수 없어요 (쿨다운)",
};
const REVIVE_REJECT_TEXT: Record<string, string> = {
  wrong_phase: "지금은 치유할 수 없어요",
  not_normal: "기절/사망 상태에서는 치유할 수 없어요",
  busy: "작업 중에는 치유할 수 없어요",
  no_target: "근처에 기절한 팀원이 없어요",
};

const HOLD_REJECT_TEXT: Record<HoldRejectReason, string> = {
  wrong_phase: "지금은 집 작업을 할 수 없어요",
  wrong_team: "우리 팀이 할 수 있는 작업이 아니에요",
  not_connected: "연결 상태를 확인해 주세요",
  too_far: "집에 더 가까이 가야 해요",
  not_normal: "기절/사망 상태에서는 작업할 수 없어요",
  busy: "치유 중에는 작업할 수 없어요",
  already_holding: "이미 작업 중이에요",
};

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
  return { code, ...initialPhase(), work: workForPhase("LOBBY", 0), roundEnd: null, players: [], deadlines: [] };
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
      c: newCombat(),
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
        // 작업/치유 중이거나 기절/사망이면 그 자리에 고정 (이동 의도만 기억했다가 풀리면 적용)
        const movable = this.canMoveNow(player);
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

      case "hold_start": {
        const body = simulate(player.body, now);
        const target = targetHouseTeam(st.attackingTeam);
        const reason = checkHoldStart({
          phase: st.phase,
          attackingTeam: st.attackingTeam,
          playerTeam: player.team,
          connected: player.conn === "CONNECTED",
          normal: player.c.state === "NORMAL",
          reviving: player.c.revive !== null,
          nearTarget: isNearHouse(target, body.x, body.y, body.z),
          alreadyHolding: this.isHolding(player.id),
        });
        if (reason) return this.sendError(ws, "cannot_work", HOLD_REJECT_TEXT[reason]);
        player.body = stopped(player.body, now); // 작업 중에는 제자리 고정
        st.work = startHold(st.work, player.id, now);
        this.scheduleWork();
        await this.saveAndSchedule();
        this.broadcastMove(player);
        this.broadcastWork(now);
        return;
      }

      case "hold_stop":
        if (!this.releaseHold(player, now)) return; // 누르고 있지 않았으면 무시
        await this.saveAndSchedule();
        this.broadcastMove(player);
        this.broadcastWork(now);
        return;

      case "attack": {
        const reason = checkAttack(player.c, st.phase, this.isHolding(player.id), now);
        if (reason) return this.sendError(ws, "cannot_attack", ATTACK_REJECT_TEXT[reason]!);
        player.c = { ...player.c, lastAttackAt: now };
        // 화면 가운데 조준점 광선으로 맞은 상대 찾기 (모든 위치는 지금 시각 기준)
        const me = simulate(player.body, now);
        const candidates = st.players
          .filter((p) => p.team !== player.team && isHittable(p.c, now))
          .map((p) => ({ id: p.id, body: simulate(p.body, now), p }));
        const hit = findAimTarget(me, msg.yaw, msg.pitch, candidates);
        if (hit) {
          const r = resolveHit(hit.p.c, hit.p.id, st.work, now); // 맞아도 작업 유지, 기절하면 작업 중단
          hit.p.c = r.c;
          st.work = r.work;
          if (hit.p.c.state === "DOWNED") this.onDowned(hit.p, now);
        }
        this.broadcast({ t: "swing", by: player.id, target: hit?.id ?? null, serverTime: now });
        this.checkWipe(now);
        await this.saveAndSchedule();
        this.broadcastRoomState(now);
        if (hit) this.broadcastWork(now); // 기절로 작업이 멈췄을 수 있음
        return;
      }

      case "revive_start": {
        // 근처(1.5m, 높이 차 1.2m)의 기절한 같은 팀원 중 가장 가까운 사람
        const me = simulate(player.body, now);
        let target: PlayerRecord | null = null;
        let best = Infinity;
        for (const p of st.players) {
          if (p.id === player.id || p.team !== player.team || p.c.state !== "DOWNED") continue;
          const b = simulate(p.body, now);
          if (!inReach(me, b, AIM.REVIVE_RANGE, AIM.REVIVE_MAX_HEIGHT_DIFF)) continue;
          const d = Math.hypot(me.x - b.x, me.y - b.y);
          if (d < best) { best = d; target = p; }
        }
        const reason = checkReviveStart(player.c, st.phase, this.isHolding(player.id), target?.c ?? null);
        if (reason || !target) return this.sendError(ws, "cannot_revive", REVIVE_REJECT_TEXT[reason ?? "no_target"]!);
        player.c = startRevive(player.c, target.id, now);
        st.deadlines = upsertDeadline(st.deadlines, { kind: "revive", key: player.id, at: player.c.revive!.endsAt });
        this.refreshMotion(player, now); // 치유 중에는 제자리 고정
        await this.saveAndSchedule();
        this.broadcastRoomState(now);
        return;
      }

      case "revive_stop":
        if (!this.cancelRevive(player, now)) return;
        await this.saveAndSchedule();
        this.broadcastRoomState(now);
        return;

      case "debug_teleport": {
        if (this.env.DEBUG_COMMANDS !== "true") return this.sendError(ws, "debug_disabled", "디버그 명령이 꺼져 있어요");
        const x = Math.min(PHYS.MAP_X - PHYS.PLAYER_HALF, Math.max(PHYS.PLAYER_HALF, msg.x));
        const y = Math.min(PHYS.MAP_Y - PHYS.PLAYER_HALF, Math.max(PHYS.PLAYER_HALF, msg.y));
        this.releaseHold(player, now);
        player.body = { ...makeBody(x, y, now), z: groundHeightAt(x, y, 100) };
        this.movesDirty = true;
        this.broadcastMove(player);
        this.broadcastWork(now);
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
      player.wantA = -1;
      this.releaseHold(player, now); // 작업 중이었다면 중단
      this.cancelRevive(player, now); // 치유 중이었다면 중단
      player.body = stopped(player.body, now); // 재접속 대기 중에는 정지
      st.deadlines = upsertDeadline(st.deadlines, { kind: "reconnect", key: player.id, at: player.reconnectDeadline });
      await this.saveAndSchedule();
      this.broadcastRoomState(now);
      this.broadcastWork(now);
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
        } else if (d.kind === "work") {
          // 집 작업 100% → 부수기 완료는 REPAIR, 수리 완료는 ROUND_END (판정 시각은 완료 예정 시각)
          const kind = st.work.kind;
          if (kind && isComplete(st.work, d.at)) {
            this.applyPhase(nextOnWorkComplete(st, kind, d.at), d.at);
            this.checkWipe(d.at); // REPAIR 시작 순간 수비팀이 이미 전멸이면 바로 종료
          }
        } else if (d.kind === "revive") {
          this.onReviveDue(d.key, d.at);
        } else if (d.kind === "death") {
          // 기절 후 20초 동안 치유받지 못함 → 사망
          const p = st.players.find((x) => x.id === d.key);
          if (p && p.c.state === "DOWNED" && p.c.deathAt !== null && p.c.deathAt <= d.at) {
            p.c = applyDeath(p.c);
            for (const q of st.players) if (q.c.revive?.target === p.id) this.cancelRevive(q, d.at); // 대상이 죽으면 치유 중단
          }
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

  // ---------- 집 작업 ----------
  private isHolding(playerId: string): boolean {
    return this.state?.work.holders.includes(playerId) ?? false;
  }

  /** 이 플레이어의 작업을 중단 (버튼 뗌/접속 끊김/퇴장). 중단했으면 true */
  private releaseHold(player: PlayerRecord, now: number): boolean {
    const st = this.state!;
    if (!st.work.holders.includes(player.id)) return false;
    st.work = stopHold(st.work, player.id, now);
    this.refreshMotion(player, now); // 고정 해제: 누르고 있던 이동 방향이 있으면 바로 출발
    this.scheduleWork();
    return true;
  }

  // ---------- 전투 ----------
  /** 지금 움직일 수 있는지: 이동 단계 + 정상 상태 + 작업/치유 중 아님 + 접속 중 */
  private canMoveNow(p: PlayerRecord): boolean {
    return canMoveIn(this.state!.phase) && p.conn === "CONNECTED" && p.c.state === "NORMAL" && !p.c.revive && !this.isHolding(p.id);
  }

  /** 상태에 맞게 이동을 다시 맞춘다 (움직일 수 있으면 원하는 방향으로, 아니면 정지) */
  private refreshMotion(p: PlayerRecord, now: number) {
    const a = this.canMoveNow(p) ? p.wantA : -1;
    if (a !== p.body.a) {
      p.body = roundBody(withAngle(p.body, a, now));
      this.movesDirty = true;
    }
  }

  /** 기절 처리: 작업/치유 즉시 중단, 정지, 사망 타이머 등록 */
  private onDowned(p: PlayerRecord, now: number) {
    const st = this.state!;
    this.releaseHold(p, now); // (resolveHit에서 이미 빠졌으면 아무 일 없음)
    this.scheduleWork(); // 작업 완료 예정 시각 다시 계산
    st.deadlines = removeDeadline(st.deadlines, "revive", p.id); // applyHit이 revive 기록은 이미 지움
    this.refreshMotion(p, now);
    st.deadlines = upsertDeadline(st.deadlines, { kind: "death", key: p.id, at: p.c.deathAt! });
  }

  /** 치유 중단 (버튼 뗌/기절/대상 사망/접속 끊김). 중단했으면 true */
  private cancelRevive(p: PlayerRecord, now: number): boolean {
    if (!p.c.revive) return false;
    p.c = stopRevive(p.c);
    this.state!.deadlines = removeDeadline(this.state!.deadlines, "revive", p.id);
    this.refreshMotion(p, now);
    return true;
  }

  /** 치유 완료 시각 도달: 대상이 아직 기절 상태면 부활 */
  private onReviveDue(reviverId: string, at: number) {
    const st = this.state!;
    const r = st.players.find((x) => x.id === reviverId);
    if (!r?.c.revive || r.c.revive.endsAt > at) return;
    const target = st.players.find((x) => x.id === r.c.revive!.target);
    if (target && target.c.state === "DOWNED") {
      target.c = completeRevive(target.c, at);
      st.deadlines = removeDeadline(st.deadlines, "death", target.id);
      this.refreshMotion(target, at);
    }
    this.cancelRevive(r, at);
  }

  /** 전멸 확인: 라운드를 끝내야 하면 ROUND_END로 */
  private checkWipe(now: number) {
    const st = this.state!;
    const teams = { A: st.players.filter((p) => p.team === "A").map((p) => p.c), B: st.players.filter((p) => p.team === "B").map((p) => p.c) };
    const winner = wipeWinner(st.phase, st.attackingTeam, teams);
    if (!winner) return;
    this.applyPhase(enterPhase(st, "ROUND_END", now), now);
    st.roundEnd = { winner, reason: "wipe" };
  }

  /** 작업 완료 예정 시각을 마감 시각 목록에 넣는다 (아무도 안 누르면 제거) */
  private scheduleWork() {
    const st = this.state!;
    const at = completionAt(st.work);
    st.deadlines = at === null
      ? removeDeadline(st.deadlines, "work", "work")
      : upsertDeadline(st.deadlines, { kind: "work", key: "work", at });
  }

  private workInfo(): WorkInfo {
    const w = this.state!.work;
    return { ...w, rate: workRate(w), completesAt: completionAt(w), checkpoint: DEFAULT_WORK_RULES.checkpoint };
  }

  private broadcastWork(now: number) {
    if (this.state) this.broadcast({ t: "work", work: this.workInfo(), serverTime: now });
  }

  // ---------- 단계 전환 ----------
  /** 로비에서 시작 조건이 맞으면 게임 시작 */
  private tryStartMatch(now: number) {
    const st = this.state;
    if (!st || st.phase !== "LOBBY" || !canStartMatch(st.players)) return;
    for (const p of st.players) p.c = newCombat(); // 경기 시작: 누적 기절/사망 횟수도 0
    this.applyPhase(startMatch(now), now);
  }

  /** 새 단계 상태를 적용하고, 단계에 따른 부수 효과(위치 초기화, 정지, 마감 시각)를 처리 */
  private applyPhase(next: PhaseState, now: number) {
    const st = this.state!;
    const enteredNewRound = next.phase === "COUNTDOWN" && (st.phase !== "COUNTDOWN" || st.round !== next.round);
    // 단계가 바뀌면 작업은 중단되고, 새 단계에 맞는 작업(0%)으로 초기화
    if (next.phase !== st.phase || next.round !== st.round) {
      st.work = workForPhase(next.phase, now);
      st.deadlines = removeDeadline(st.deadlines, "work", "work");
    }
    st.phase = next.phase;
    st.round = next.round;
    st.attackingTeam = next.attackingTeam;
    st.phaseEndsAt = next.phaseEndsAt;

    // 라운드가 끝나거나 새로 시작되면 치유는 중단되고 사망 타이머도 없어진다 (ATTACK→REPAIR는 같은 라운드라 유지)
    if (!canMoveIn(st.phase)) {
      for (const p of st.players) p.c = stopRevive(p.c);
      st.deadlines = st.deadlines.filter((d) => d.kind !== "revive" && d.kind !== "death");
    }
    if (st.phase === "LOBBY") for (const p of st.players) { p.ready = false; p.c = newCombat(); }
    if (enteredNewRound) {
      st.roundEnd = null;
      // 라운드 시작: 체력/상태 초기화(사망자도 부활), 팀별 시작 위치로
      for (const team of ["A", "B"] as const) {
        st.players.filter((p) => p.team === team).forEach((p, i) => {
          p.c = resetForRound(p.c);
          p.body = spawnBody(team, i, now);
        });
      }
    } else {
      // 이동 가능해지면 누르고 있던 방향으로 바로 출발, 불가능해지면 정지 (작업이 끝난 사람의 고정도 풀림)
      for (const p of st.players) this.refreshMotion(p, now);
    }

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
    for (const p of st.players) {
      if (ids.includes(p.id)) { this.releaseHold(p, now); this.cancelRevive(p, now); }
      else if (p.c.revive && ids.includes(p.c.revive.target)) this.cancelRevive(p, now);
    }
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
      combat: {
        hp: p.c.hp,
        state: p.c.state,
        deathAt: p.c.deathAt,
        invulnUntil: p.c.invulnUntil,
        downs: p.c.downs,
        deaths: p.c.deaths,
        revive: p.c.revive,
        attackReadyAt: p.c.lastAttackAt + ATTACK_COOLDOWN_MS,
      },
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
      work: this.workInfo(),
      roundEnd: st.roundEnd,
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
