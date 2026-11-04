// 호스트 기기의 게임 서버를 Web Worker(화면과 다른 작업 공간)에서 돌린다.
// 3D 그리기와 서로 기다리지 않아서, 화면이 버벅여도 판정이 밀리지 않고 서버 일 때문에 화면이 끊기지도 않는다.
// 화면 쪽(hostProxy.ts)과는 메시지로만 주고받는다.
import { HostRoom, type PeerLink } from "./hostRoom";

export type ToWorker =
  | { t: "init"; code: string; env: Record<string, string> }
  | { t: "open"; id: number; edge: string } // 새 연결
  | { t: "msg"; id: number; text: string } // 연결에서 온 메시지
  | { t: "closed"; id: number; code: number } // 연결이 끊김
  | { t: "stop"; code: number }; // 방 닫기

export type FromWorker =
  | { t: "send"; id: number; text: string } // 이 연결로 보내기
  | { t: "close"; id: number; code: number }; // 이 연결 닫기

let room: HostRoom | null = null;
const links = new Map<number, PeerLink>();
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.t) {
    case "init":
      room = new HostRoom(m.code, m.env);
      break;
    case "open": {
      const link: PeerLink = {
        onmessage: () => {},
        onclose: () => {},
        send: (text) => post({ t: "send", id: m.id, text }),
        close: (code = 1000) => { links.delete(m.id); post({ t: "close", id: m.id, code }); },
      };
      links.set(m.id, link);
      room?.addPeer(link, m.edge);
      break;
    }
    case "msg":
      links.get(m.id)?.onmessage(m.text);
      break;
    case "closed": {
      const link = links.get(m.id);
      links.delete(m.id);
      link?.onclose(m.code);
      break;
    }
    case "stop":
      room?.stop(m.code);
      break;
  }
};
