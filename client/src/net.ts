// WebSocket 연결 + ping + 서버 시계 맞추기
import { CONFIG } from "./config";

export type Handler = (msg: any) => void;

export class Net {
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  private pingSentAt = 0;
  /** 서버시각 - 내시각 추정값 (가장 지연이 적었던 표본 기준) */
  private offset = -Infinity;
  rtt = 0;
  onMessage: Handler = () => {};
  onOpen: () => void = () => {};
  onClose: (code: number) => void = () => {};

  constructor(private baseUrl: string) {}

  connect(room: string) {
    this.close();
    const ws = new WebSocket(`${this.baseUrl}/ws?room=${encodeURIComponent(room)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.onOpen();
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), CONFIG.PING_INTERVAL_MS);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") {
        this.rtt = performance.now() - this.pingSentAt;
        return;
      }
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (typeof msg.serverTime === "number") this.sampleClock(msg.serverTime);
      this.onMessage(msg);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) { this.ws = null; this.onClose(e.code); }
    };
  }

  close() {
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(); } catch { /* 무시 */ }
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

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
