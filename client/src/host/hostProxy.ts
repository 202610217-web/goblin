// 화면 쪽에서 보는 "내 기기 방 서버". 실제 서버는 Web Worker(hostWorker.ts) 안에서 돈다.
// HostRoom과 같은 모양(addPeer, stop)이라 Net/P2PHost는 차이를 모른다.
import type { PeerLink } from "./hostRoom";
import type { FromWorker, ToWorker } from "./hostWorker";

export interface HostLike {
  addPeer(link: PeerLink, edge: string): void;
  stop(code?: number): void;
}

export class HostRoomProxy implements HostLike {
  private worker: Worker;
  private links = new Map<number, PeerLink>();
  private nextId = 1;
  private stopped = false;

  constructor(readonly code: string, env: Record<string, string>) {
    this.worker = new Worker(new URL("./hostWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      const link = this.links.get(m.id);
      if (!link) return;
      if (m.t === "send") link.send(m.text);
      else if (m.t === "close") { this.links.delete(m.id); link.close(m.code); }
    };
    this.worker.onerror = (e) => console.error("host worker error", e.message);
    this.post({ t: "init", code, env });
  }

  addPeer(link: PeerLink, edge: string) {
    if (this.stopped) { link.close(4410); return; }
    const id = this.nextId++;
    this.links.set(id, link);
    link.onmessage = (text) => this.post({ t: "msg", id, text });
    link.onclose = (code) => { if (this.links.delete(id)) this.post({ t: "closed", id, code }); };
    this.post({ t: "open", id, edge });
  }

  /** 방 닫기: 모든 연결에 code로 닫으라고 알린 뒤 Worker를 끝낸다 (기기 자원 반납) */
  stop(code = 4410) {
    if (this.stopped) return;
    this.stopped = true;
    this.post({ t: "stop", code });
    // Worker가 닫기 메시지를 다 보낼 시간을 조금 준 뒤 종료
    setTimeout(() => {
      for (const link of this.links.values()) link.close(code);
      this.links.clear();
      this.worker.terminate();
    }, 300);
  }

  private post(m: ToWorker) { this.worker.postMessage(m); }
}
