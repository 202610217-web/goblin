// 연결 통로 추상화: 게임 코드는 이 모양만 쓴다.
// - WsTransport: Cloudflare 방 서버 (WebSocket)
// - 기기 직접 연결(WebRTC)은 p2p.ts
// - loopbackPair: 호스트 기기에서 내 화면 ↔ 내 기기 안의 방 서버
import type { PeerLink } from "./host/hostRoom";

export interface Transport {
  send(text: string): void;
  close(): void;
  readonly open: boolean;
  readonly connecting: boolean;
  onopen: () => void;
  onmessage: (text: string) => void;
  /** code 4404 = 이 방에 호스트 기기가 없음(Cloudflare 방으로 바꿔서 다시), 4410 = 호스트가 방을 닫음 */
  onclose: (code: number) => void;
  /** 연결 종류 표시 (핑 옆에 보임) */
  readonly label: string;
}

export class WsTransport implements Transport {
  private ws: WebSocket;
  onopen = () => {};
  onmessage = (_t: string) => {};
  onclose = (_c: number) => {};
  label = "";
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.onopen();
    this.ws.onmessage = (e) => { if (typeof e.data === "string") this.onmessage(e.data); };
    this.ws.onclose = (e) => this.onclose(e.code);
  }
  get open() { return this.ws.readyState === WebSocket.OPEN; }
  get connecting() { return this.ws.readyState === WebSocket.CONNECTING; }
  send(text: string) { if (this.open) this.ws.send(text); }
  close() { try { this.ws.close(); } catch { /* 무시 */ } }
}

/** 호스트 기기 안에서 내 화면과 방 서버를 잇는 통로 한 쌍 (네트워크를 거치지 않음) */
export function loopbackPair(): { client: Transport; server: PeerLink } {
  let open = true;
  const server: PeerLink = {
    onmessage: () => {},
    onclose: () => {},
    send: (text) => { if (open) setTimeout(() => client.onmessage(text), 0); },
    close: (code = 1000) => { if (!open) return; open = false; setTimeout(() => client.onclose(code), 0); },
  };
  const client: Transport = {
    onopen: () => {},
    onmessage: () => {},
    onclose: () => {},
    label: "내 기기(호스트)",
    get open() { return open; },
    get connecting() { return false; },
    send: (text) => { if (open) setTimeout(() => server.onmessage(text), 0); },
    close: () => { if (!open) return; open = false; setTimeout(() => server.onclose(1000), 0); },
  };
  setTimeout(() => client.onopen(), 0);
  return { client, server };
}
