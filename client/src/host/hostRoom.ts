// "내 기기로 방 열기": 서버 방 코드(GameRoom)를 이 기기 브라우저 안에서 그대로 돌린다.
// Durable Object가 주던 것(저장, 알람 1개, 연결 목록, ping 자동 응답, 한 번에 하나씩 처리)을 흉내 낸다.
import { GameRoom } from "@goblin/room";

/** 손님 한 명과 이어진 통로 (기기 직접 연결 또는 이 기기 안의 연결) */
export interface PeerLink {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onmessage: (text: string) => void;
  onclose: (code: number) => void;
}

/** 서버 코드가 보는 WebSocket 대역 */
class VirtualSocket {
  readyState = 1; // OPEN
  closeNotified = false;
  private attachment: unknown = null;
  constructor(private link: PeerLink, private host: HostRoom) {}
  send(text: string) {
    if (this.readyState === 1) this.link.send(text);
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.link.close(code, reason);
    this.host.notifyClosed(this, code);
  }
  serializeAttachment(v: unknown) {
    this.attachment = v === undefined ? undefined : structuredClone(v);
  }
  deserializeAttachment(): unknown {
    // 서버 코드는 꺼낸 값을 고치지 않고 새로 만들어 넣으므로 복사 없이 돌려준다 (자주 불려서 부담 줄이기)
    return this.attachment;
  }
}

export class HostRoom {
  private room: GameRoom;
  private sockets = new Set<VirtualSocket>();
  private auto: { request: string; response: string } | null = null;
  private store = new Map<string, unknown>();
  private alarmAt: number | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  /** 서버 코드는 한 번에 하나의 일만 처리한다고 가정하므로 줄을 세운다 */
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(readonly code: string, env: Record<string, string>) {
    env = { MEMORY_ONLY: "true", ...env };
    const ctx = {
      setWebSocketAutoResponse: (pair: { request: string; response: string }) => { this.auto = pair; },
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => this.enqueue(fn),
      acceptWebSocket: (ws: VirtualSocket) => { this.sockets.add(ws); },
      getWebSockets: () => [...this.sockets],
      storage: {
        get: async (k: string) => this.store.get(k),
        put: async (k: string, v: unknown) => { this.store.set(k, v); },
        deleteAll: async () => { this.store.clear(); },
        getAlarm: async () => this.alarmAt,
        setAlarm: async (t: number) => this.setAlarm(t),
        deleteAlarm: async () => this.setAlarm(null),
      },
    };
    // 진짜 Durable Object 타입과 모양이 달라서 타입만 바꿔 넘긴다 (서버 코드가 쓰는 부분은 모두 흉내 냄)
    this.room = new GameRoom(ctx as never, env as never);
  }

  /** 새 손님(또는 이 기기의 내 화면) 연결. edge = 화면에 보일 연결 종류 */
  addPeer(link: PeerLink, edge: string): void {
    if (this.stopped) { link.close(1001, "stopped"); return; }
    const ws = new VirtualSocket(link, this);
    link.onmessage = (text) => {
      if (ws.readyState !== 1) return;
      if (this.auto && text === this.auto.request) { ws.send(this.auto.response); return; } // ping → pong
      this.enqueue(() => this.room.webSocketMessage(ws as never, text));
    };
    link.onclose = (code) => this.notifyClosed(ws, code);
    this.enqueue(() => this.room.acceptPeer(ws as never, this.code, edge, "HOST"));
  }

  /** 연결이 끊겼을 때 서버 코드에 한 번만 알린다 */
  notifyClosed(ws: VirtualSocket, code: number) {
    if (ws.closeNotified) return;
    ws.closeNotified = true;
    ws.readyState = 3;
    this.enqueue(async () => {
      await this.room.webSocketClose(ws as never, code, "", false);
      this.sockets.delete(ws);
    });
  }

  /** 방 닫기. code 4410 = 호스트가 나감, 4411 = 경기가 끝나서 닫음 */
  stop(code = 4410) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.alarmTimer !== null) clearTimeout(this.alarmTimer);
    for (const ws of this.sockets) ws.close(code, "host_closed");
  }

  private setAlarm(t: number | null) {
    if (this.alarmTimer !== null) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    this.alarmAt = t;
    if (t === null || this.stopped) return;
    this.alarmTimer = setTimeout(() => {
      this.alarmAt = null;
      this.enqueue(() => this.room.alarm());
    }, Math.max(0, t - Date.now()));
  }

  private enqueue(fn: () => Promise<unknown>): Promise<unknown> {
    this.queue = this.queue.then(fn).catch((e) => console.error("host room error", e));
    return this.queue;
  }
}
