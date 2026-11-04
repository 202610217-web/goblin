// "내 기기로 방 열기"용 연결 중계 서버 (SignalRoom Durable Object)
// 게임 데이터는 여기로 오지 않는다. 호스트 기기와 친구 기기가 서로 직접 연결(WebRTC)할 수 있도록
// 연결 정보(SDP, ICE 후보)만 한두 번 전달한다. 연결이 끝나면 게임은 기기끼리 직접 주고받는다.
import { DurableObject } from "cloudflare:workers";
import { PING_MESSAGE, PONG_MESSAGE } from "./constants";

/** 방 하나에 동시에 붙을 수 있는 중계 연결 수 */
const MAX_SIGNAL_SOCKETS = 12;
/** 연결 정보 메시지 최대 크기 (SDP는 보통 2~5KB) */
const MAX_SIGNAL_BYTES = 16 * 1024;
/**
 * 연결별 초당 메시지 수. 직접 연결이 막힌 네트워크(학교 와이파이 등)에서는 게임 메시지도 여기로 중계되므로,
 * 손님 여럿에게 보내는 호스트는 더 많이 허용한다.
 */
const SIGNAL_RATE_PER_SEC = { host: 300, other: 60 } as const;

interface SignalAttachment {
  id: string;
  role: "host" | "guest" | null;
}

/** 클라이언트 → 중계 서버 */
export type SignalClientMessage =
  | { t: "host" } // 이 방의 호스트로 등록
  | { t: "guest" } // 손님: 이 방에 호스트가 있는지 묻기
  | { t: "to"; id: string; data: unknown }; // 상대에게 연결 정보 전달

/** 중계 서버 → 클라이언트 */
export type SignalServerMessage =
  | { t: "hello"; id: string }
  | { t: "room"; host: string | null } // 손님에게: 호스트 연결 id (없으면 null)
  | { t: "from"; id: string; data: unknown }
  | { t: "peer_left"; id: string }
  | { t: "error"; message: string };

function randomId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class SignalRoom extends DurableObject<Env> {
  private rate = new Map<WebSocket, { start: number; n: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MESSAGE, PONG_MESSAGE));
  }

  async fetch(): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_SIGNAL_SOCKETS) return new Response("Too many connections", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server); // Hibernation API
    const id = randomId();
    server.serializeAttachment({ id, role: null } satisfies SignalAttachment);
    server.send(JSON.stringify({ t: "hello", id } satisfies SignalServerMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  private att(ws: WebSocket): SignalAttachment {
    return ws.deserializeAttachment() as SignalAttachment;
  }

  private open(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
  }

  private hostSocket(): WebSocket | undefined {
    return this.open().find((w) => this.att(w).role === "host");
  }

  private send(ws: WebSocket, m: SignalServerMessage) {
    try { ws.send(JSON.stringify(m)); } catch { /* 무시 */ }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_SIGNAL_BYTES) return;
    // 연결별 레이트 리밋
    const now = Date.now();
    const r = this.rate.get(ws);
    if (!r || now - r.start >= 1000) this.rate.set(ws, { start: now, n: 1 });
    else if (++r.n > (this.att(ws).role === "host" ? SIGNAL_RATE_PER_SEC.host : SIGNAL_RATE_PER_SEC.other)) return;

    let m: SignalClientMessage;
    try { m = JSON.parse(raw); } catch { return; }
    const me = this.att(ws);
    if (m.t === "host") {
      const existing = this.hostSocket();
      if (existing && existing !== ws) return this.send(ws, { t: "error", message: "이 방 코드는 이미 다른 기기가 열었어요. 다른 방 코드로 만들어 주세요." });
      ws.serializeAttachment({ ...me, role: "host" } satisfies SignalAttachment);
      return;
    }
    if (m.t === "guest") {
      ws.serializeAttachment({ ...me, role: "guest" } satisfies SignalAttachment);
      const host = this.hostSocket();
      return this.send(ws, { t: "room", host: host ? this.att(host).id : null });
    }
    if (m.t === "to" && typeof m.id === "string") {
      // 호스트 ↔ 손님 사이에서만 전달 (손님끼리는 안 됨)
      const target = this.open().find((w) => this.att(w).id === m.id);
      if (!target) return;
      const tRole = this.att(target).role;
      if (!((me.role === "guest" && tRole === "host") || (me.role === "host" && tRole === "guest"))) return;
      this.send(target, { t: "from", id: me.id, data: m.data });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* 이미 닫힘 */ }
    this.rate.delete(ws);
    const me = this.att(ws);
    // 상대에게 알려 준다 (호스트가 나가면 손님들에게, 손님이 나가면 호스트에게)
    for (const w of this.open()) {
      if (w === ws) continue;
      const role = this.att(w).role;
      if ((me.role === "host" && role === "guest") || (me.role === "guest" && role === "host")) this.send(w, { t: "peer_left", id: me.id });
    }
  }
}
