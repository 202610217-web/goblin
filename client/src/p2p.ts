// 기기끼리 직접 연결 (WebRTC DataChannel)
// 처음 연결할 때만 Cloudflare의 연결 중계(/signal)를 써서 연결 정보(SDP, ICE 후보)를 주고받고,
// 연결되면 게임 메시지는 기기끼리 직접 오간다 (와이파이가 미국을 거쳐도 게임은 국내로 직접).
import { CONFIG } from "./config";
import type { HostRoom, PeerLink } from "./host/hostRoom";
import type { Transport } from "./transport";

/** 기기끼리 서로의 인터넷 주소를 알아내는 무료 STUN 서버 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

type SignalIn =
  | { t: "hello"; id: string }
  | { t: "room"; host: string | null }
  | { t: "from"; id: string; data: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit } }
  | { t: "peer_left"; id: string }
  | { t: "error"; message: string };

/** 연결 중계 서버와의 WebSocket */
class Signal {
  private ws: WebSocket;
  private pingTimer = 0;
  onmsg: (m: SignalIn) => void = () => {};
  onclose: () => void = () => {};
  constructor(base: string, room: string) {
    this.ws = new WebSocket(`${base}/signal?room=${encodeURIComponent(room)}`);
    this.ws.onmessage = (e) => {
      if (e.data === "pong") return;
      try { this.onmsg(JSON.parse(e.data)); } catch { /* 무시 */ }
    };
    this.ws.onopen = () => { this.pingTimer = window.setInterval(() => this.raw("ping"), CONFIG.PING_INTERVAL_MS); };
    this.ws.onclose = () => { clearInterval(this.pingTimer); this.onclose(); };
  }
  send(o: unknown) { this.raw(JSON.stringify(o)); }
  private raw(s: string) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(s); }
  close() { clearInterval(this.pingTimer); try { this.ws.close(); } catch { /* 무시 */ } }
}

/** 연결된 경로 종류 → 사람이 읽는 말 (host = 같은 와이파이, srflx = 인터넷으로 직접, relay = 중계) */
async function routeLabel(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await pc.getStats();
    let pairId = "";
    stats.forEach((s: any) => { if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId; });
    let local = "", remote = "";
    stats.forEach((s: any) => {
      if (s.type === "candidate-pair" && (s.id === pairId || (!pairId && s.nominated && s.state === "succeeded"))) {
        local = stats.get(s.localCandidateId)?.candidateType ?? "";
        remote = stats.get(s.remoteCandidateId)?.candidateType ?? "";
      }
    });
    if (local === "relay" || remote === "relay") return "기기 연결(중계)";
    if (local === "host" && remote === "host") return "기기 직접(같은 와이파이)";
    return "기기 직접 연결";
  } catch {
    return "기기 직접 연결";
  }
}

/** DataChannel을 PeerLink 모양으로 (호스트 쪽에서 방 서버에 넘긴다) */
function channelLink(ch: RTCDataChannel, pc: RTCPeerConnection): PeerLink {
  let closed = false;
  const link: PeerLink = {
    onmessage: () => {},
    onclose: () => {},
    send: (text) => { if (ch.readyState === "open") ch.send(text); },
    close: () => { if (closed) return; closed = true; try { ch.close(); pc.close(); } catch { /* 무시 */ } },
  };
  ch.onmessage = (e) => { if (typeof e.data === "string") link.onmessage(e.data); };
  const gone = () => { if (closed) return; closed = true; try { pc.close(); } catch { /* 무시 */ } link.onclose(1006); };
  ch.onclose = gone;
  pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" || pc.connectionState === "closed") gone(); };
  return link;
}

/**
 * 호스트: 연결 중계에 "내가 이 방의 호스트"라고 등록하고, 손님이 오면 직접 연결을 받아
 * 이 기기 안의 방 서버(HostRoom)에 넘긴다. 중계 연결이 끊기면 다시 붙는다 (새 손님/재접속을 받으려고).
 */
export class P2PHost {
  private signal: Signal | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private stopped = false;
  private retry = 0;
  onerror: (message: string) => void = () => {};

  constructor(private base: string, private room: string, private hostRoom: HostRoom) {}

  start() {
    if (this.stopped) return;
    const sig = new Signal(this.base, this.room);
    this.signal = sig;
    sig.onmsg = (m) => this.onSignal(m);
    sig.onclose = () => {
      if (this.stopped || this.signal !== sig) return;
      this.retry = window.setTimeout(() => this.start(), 2000);
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.signal?.close();
    for (const pc of this.peers.values()) try { pc.close(); } catch { /* 무시 */ }
    this.hostRoom.stop();
  }

  private async onSignal(m: SignalIn) {
    if (m.t === "hello") { this.signal?.send({ t: "host" }); return; }
    if (m.t === "error") { this.onerror(m.message); return; }
    if (m.t !== "from") return;
    const { sdp, ice } = m.data ?? {};
    if (sdp?.type === "offer") {
      // 새 손님: 연결을 받는다
      this.peers.get(m.id)?.close();
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.peers.set(m.id, pc);
      pc.onicecandidate = (e) => { if (e.candidate) this.signal?.send({ t: "to", id: m.id, data: { ice: e.candidate.toJSON() } }); };
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        ch.onopen = () => this.hostRoom.addPeer(channelLink(ch, pc), "P2P");
      };
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal?.send({ t: "to", id: m.id, data: { sdp: pc.localDescription?.toJSON() } });
    } else if (ice) {
      try { await this.peers.get(m.id)?.addIceCandidate(ice); } catch { /* 늦게 온 후보 무시 */ }
    }
  }
}

/**
 * 손님: 이 방에 호스트 기기가 있으면 직접 연결하고, 없으면 4404로 닫아서
 * Net이 Cloudflare 방 서버로 바꿔 접속하게 한다.
 * requireHost = 이미 호스트 방에 있던 손님의 재접속 (호스트가 없으면 4410 = 방이 닫힘)
 */
export class P2PGuestTransport implements Transport {
  private signal: Signal;
  private pc: RTCPeerConnection | null = null;
  private ch: RTCDataChannel | null = null;
  private done = false;
  private gotRoom = false;
  private timer = 0;
  label = "기기 직접 연결";
  onopen = () => {};
  onmessage = (_t: string) => {};
  onclose = (_c: number) => {};

  constructor(base: string, room: string, private requireHost: boolean) {
    this.signal = new Signal(base, room);
    this.signal.onmsg = (m) => this.onSignal(m);
    this.signal.onclose = () => {
      if (this.ch && this.ch.readyState === "open") return;
      // 처음 입장 중에 중계에 못 붙으면 호스트 기기가 없는 것으로 보고 Cloudflare 방으로
      this.finish(!this.gotRoom && !this.requireHost ? 4404 : 1006);
    };
    // 정해진 시간 안에 연결 안 되면 실패
    this.timer = window.setTimeout(() => { if (!this.open) this.finish(4408); }, CONFIG.P2P_CONNECT_TIMEOUT_MS);
  }

  get open() { return this.ch?.readyState === "open"; }
  get connecting() { return !this.done && !this.open; }
  send(text: string) { if (this.open) this.ch!.send(text); }
  close() { this.finish(1000); }

  private finish(code: number) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.signal.close();
    try { this.ch?.close(); this.pc?.close(); } catch { /* 무시 */ }
    this.onclose(code);
  }

  private async onSignal(m: SignalIn) {
    if (m.t === "hello") { this.signal.send({ t: "guest" }); return; }
    if (m.t === "room") {
      this.gotRoom = true;
      if (!m.host) { this.finish(this.requireHost ? 4410 : 4404); return; }
      await this.connect(m.host);
      return;
    }
    if (m.t === "from" && this.pc) {
      const { sdp, ice } = m.data ?? {};
      if (sdp?.type === "answer") await this.pc.setRemoteDescription(sdp);
      else if (ice) { try { await this.pc.addIceCandidate(ice); } catch { /* 무시 */ } }
      return;
    }
    if (m.t === "peer_left" && !this.open) this.finish(4410);
  }

  private async connect(hostId: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    const ch = pc.createDataChannel("game", { ordered: true });
    this.ch = ch;
    pc.onicecandidate = (e) => { if (e.candidate) this.signal.send({ t: "to", id: hostId, data: { ice: e.candidate.toJSON() } }); };
    ch.onopen = async () => {
      clearTimeout(this.timer);
      this.signal.close(); // 연결됐으니 중계는 더 필요 없다
      this.label = await routeLabel(pc);
      this.onopen();
    };
    ch.onmessage = (e) => { if (typeof e.data === "string") this.onmessage(e.data); };
    ch.onclose = () => this.finish(1006);
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") this.finish(4408); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal.send({ t: "to", id: hostId, data: { sdp: pc.localDescription?.toJSON() } });
  }
}
