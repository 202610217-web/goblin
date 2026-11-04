// 게임 연결 관리: 통로 고르기 + ping + 서버 시계 맞추기 + 자동 재접속(지수 백오프)
// 통로는 세 가지 (transport.ts, p2p.ts):
// - "host": 이 기기가 방 서버 (내 화면 ↔ 내 기기 안의 방)
// - "p2p" : 호스트 기기에 직접 연결 (WebRTC)
// - "ws"  : Cloudflare 방 서버
// 처음 들어갈 때는 "auto": 방에 호스트 기기가 있으면 p2p, 없으면 ws 로 정하고, 재접속도 같은 방식으로 한다.
import { CONFIG } from "./config";
import type { HostLike } from "./host/hostProxy";
import { P2PGuestTransport } from "./p2p";
import { type Transport, WsTransport, loopbackPair } from "./transport";

export type Handler = (msg: any) => void;
export type NetMode = "auto" | "ws" | "p2p" | "host";

export class Net {
  private t: Transport | null = null;
  private pingTimer = 0;
  private retryTimer = 0;
  private pingSentAt = 0;
  private lastPongAt = 0;
  private attempt = 0;
  private room = "";
  /** 지금 연결 방식 */
  mode: NetMode = "auto";
  private hostRoom: HostLike | null = null;
  /** true인 동안은 끊기면 자동으로 다시 접속한다 */
  autoReconnect = false;
  /** 서버시각 - 내시각 추정값 (가장 지연이 적었던 표본 기준) */
  private offset = -Infinity;
  /** 최근 왕복 시간(ms) 표본. 화면에는 중간값을 보여 준다 (한 번 튄 값에 흔들리지 않게) */
  private samples: number[] = [];
  onMessage: Handler = () => {};
  onOpen: () => void = () => {};
  /** willRetry = 자동 재접속을 예약했는지, delay = 다음 시도까지(ms) */
  onClose: (code: number, willRetry: boolean, delay: number) => void = () => {};

  constructor(private baseUrl: string) {}

  get rtt(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }
  /** 왕복 시간 표본 추가 (ping 응답, 내 입력에 대한 서버 응답) */
  addRttSample(ms: number) {
    this.samples.push(ms);
    if (this.samples.length > CONFIG.RTT_SAMPLES) this.samples.shift();
  }
  /** 연결 종류 표시 ("기기 직접 연결" 등). Cloudflare면 빈 문자열 */
  get label(): string { return this.t?.label ?? ""; }

  /** 이 기기를 방 서버로 쓴다 ("내 기기로 방 만들기") */
  useHost(hostRoom: HostLike) {
    this.hostRoom = hostRoom;
    this.mode = "host";
  }

  connect(room: string) {
    this.room = room;
    clearTimeout(this.retryTimer);
    this.closeTransport();
    const t = this.makeTransport(room);
    this.t = t;
    t.onopen = () => {
      if (this.t !== t) return;
      if (this.mode === "auto") this.mode = t instanceof P2PGuestTransport ? "p2p" : "ws"; // 이제부터 이 방식으로 재접속
      this.attempt = 0;
      this.samples = []; // 새 연결은 새로 잰다
      this.lastPongAt = performance.now();
      this.onOpen();
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), CONFIG.PING_INTERVAL_MS);
    };
    t.onmessage = (text) => {
      if (this.t !== t) return;
      if (text === "pong") {
        this.addRttSample(performance.now() - this.pingSentAt);
        this.lastPongAt = performance.now();
        return;
      }
      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }
      if (typeof msg.serverTime === "number") this.sampleClock(msg.serverTime);
      this.onMessage(msg);
    };
    t.onclose = (code) => {
      clearInterval(this.pingTimer);
      if (this.t !== t) return;
      this.t = null;
      // 이 방에 호스트 기기가 없음 → Cloudflare 방으로 바로 다시
      if (code === 4404 && this.mode === "auto") {
        this.mode = "ws";
        this.connect(this.room);
        return;
      }
      let delay = 0;
      // 4410 = 호스트가 방을 닫음, 4411 = 경기가 끝나서 방을 닫음 → 재접속 안 함
      const retry = this.autoReconnect && code !== 4410 && code !== 4411;
      if (retry) {
        const d = CONFIG.RECONNECT_DELAYS_MS;
        delay = d[Math.min(this.attempt, d.length - 1)]!;
        this.attempt++;
        this.retryTimer = window.setTimeout(() => this.connect(this.room), delay);
      }
      this.onClose(code, retry, delay);
    };
  }

  private makeTransport(room: string): Transport {
    if (this.mode === "host" && this.hostRoom) {
      const { client, server } = loopbackPair();
      this.hostRoom.addPeer(server, "HOST");
      return client;
    }
    if (this.mode === "ws") return new WsTransport(`${this.baseUrl}/ws?room=${encodeURIComponent(room)}`);
    // auto: 호스트 기기가 있는지 먼저 물어본다 / p2p: 호스트 기기에만 다시 연결
    return new P2PGuestTransport(this.baseUrl, room, this.mode === "p2p");
  }

  /** 지금 바로 다시 접속 (앱이 다시 보일 때 등) */
  reconnectNow() {
    if (this.connected || !this.room) return;
    if (this.t && this.t.connecting) return;
    this.connect(this.room);
  }

  /** 연결을 끊고 자동 재접속도 멈춘다 */
  stop() {
    this.autoReconnect = false;
    clearTimeout(this.retryTimer);
    this.closeTransport();
  }

  /** 처음 상태로 (다른 방에 들어갈 때) */
  reset() {
    this.stop();
    this.mode = "auto";
    this.hostRoom = null;
    this.offset = -Infinity; // 호스트 기기와 Cloudflare는 시계가 다르므로 새로 잰다
  }

  private closeTransport() {
    clearInterval(this.pingTimer);
    const t = this.t;
    this.t = null;
    t?.close();
  }

  get connected() { return !!this.t?.open; }
  /** ping 응답이 오래 없으면 연결 불안정 */
  get unstable() { return this.connected && performance.now() - this.lastPongAt > CONFIG.PING_INTERVAL_MS * 1.5; }

  send(obj: unknown) {
    if (this.connected) this.t!.send(JSON.stringify(obj));
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
    this.t!.send("ping"); // Cloudflare/호스트 기기 모두 방 코드를 거치지 않고 바로 "pong" 응답
  }
}
