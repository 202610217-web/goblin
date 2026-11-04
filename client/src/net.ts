// WebSocket 연결 + ping + 서버 시계 맞추기 + 자동 재접속(지수 백오프)
import { CONFIG } from "./config";

export type Handler = (msg: any) => void;

export class Net {
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  private retryTimer = 0;
  private pingSentAt = 0;
  private lastPongAt = 0;
  private attempt = 0;
  private room = "";
  /** true인 동안은 끊기면 자동으로 다시 접속한다 */
  autoReconnect = false;
  /** 서버시각 - 내시각 추정값 (가장 지연이 적었던 표본 기준) */
  private offset = -Infinity;
  rtt = 0;
  onMessage: Handler = () => {};
  onOpen: () => void = () => {};
  /** willRetry = 자동 재접속을 예약했는지, delay = 다음 시도까지(ms) */
  onClose: (code: number, willRetry: boolean, delay: number) => void = () => {};

  constructor(private baseUrl: string) {}

  connect(room: string) {
    this.room = room;
    clearTimeout(this.retryTimer);
    this.closeSocket();
    const ws = new WebSocket(`${this.baseUrl}/ws?room=${encodeURIComponent(room)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastPongAt = performance.now();
      this.onOpen();
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), CONFIG.PING_INTERVAL_MS);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") {
        this.rtt = performance.now() - this.pingSentAt;
        this.lastPongAt = performance.now();
        return;
      }
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (typeof msg.serverTime === "number") this.sampleClock(msg.serverTime);
      this.onMessage(msg);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      let delay = 0;
      if (this.autoReconnect) {
        const d = CONFIG.RECONNECT_DELAYS_MS;
        delay = d[Math.min(this.attempt, d.length - 1)]!;
        this.attempt++;
        this.retryTimer = window.setTimeout(() => this.connect(this.room), delay);
      }
      this.onClose(e.code, this.autoReconnect, delay);
    };
  }

  /** 지금 바로 다시 접속 (앱이 다시 보일 때 등) */
  reconnectNow() {
    if (this.connected || !this.room) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this.connect(this.room);
  }

  /** 연결을 끊고 자동 재접속도 멈춘다 */
  stop() {
    this.autoReconnect = false;
    clearTimeout(this.retryTimer);
    this.closeSocket();
  }

  private closeSocket() {
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(); } catch { /* 무시 */ }
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  /** ping 응답이 오래 없으면 연결 불안정 */
  get unstable() { return this.connected && performance.now() - this.lastPongAt > CONFIG.PING_INTERVAL_MS * 1.5; }

  send(obj: unknown) {
    if (this.connected) this.ws!.send(JSON.stringify(obj));
  }

  /** 서버가 보낸 시각으로 시계 차이를 추정 (지연이 가장 적은 표본 = 가장 큰 값) */
  sampleClock(serverTime: number) {
    const s = serverTime - Date.now();
    if (s > this.offset) this.offset = s;
  }

  /** 현재 서버 시각 추정 */
  serverNow(): number {
    return Date.now() + (Number.isFinite(this.offset) ? this.offset : 0);
  }

  private ping() {
    if (!this.connected) return;
    this.pingSentAt = performance.now();
    this.ws!.send("ping"); // 서버가 Durable Object를 깨우지 않고 자동으로 "pong" 응답
  }
}
