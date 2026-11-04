import { describe, expect, it } from "vitest";
import { HostRoom, type PeerLink } from "../../client/src/host/hostRoom";

/** 화면 한 개 흉내: 받은 메시지를 모아 두는 통로 */
function fakePeer(): PeerLink & { got: any[]; raw: string[]; closed: number | null; push(o: unknown): void } {
  const p = {
    got: [] as any[], raw: [] as string[], closed: null as number | null,
    onmessage: (_t: string) => {}, onclose: (_c: number) => {},
    send(text: string) { p.raw.push(text); try { p.got.push(JSON.parse(text)); } catch { /* pong */ } },
    close(code = 1000) { p.closed = code; },
    push(o: unknown) { p.onmessage(typeof o === "string" ? o : JSON.stringify(o)); },
  };
  return p;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const last = (p: { got: any[] }, t: string) => p.got.filter((m) => m.t === t).at(-1);

describe("내 기기로 방 열기 (서버 방 코드를 브라우저 어댑터로 실행)", () => {
  it("입장, 팀 배정, ping 자동 응답, 더미, 연습 경기 시작까지 서버와 똑같이 동작", async () => {
    const host = new HostRoom("ABCD", { DEBUG_COMMANDS: "true" });
    const a = fakePeer(), b = fakePeer();
    host.addPeer(a, "HOST");
    host.addPeer(b, "P2P");
    await tick();
    a.push({ t: "join", nickname: "호스트" });
    b.push({ t: "join", nickname: "손님" });
    await tick(5);
    expect(last(a, "welcome").edge).toBe("HOST");
    expect(last(b, "welcome").roomColo).toBe("HOST");
    expect(last(a, "room_state").players.map((p: any) => p.team).join("")).toBe("AB");
    a.push("ping");
    await tick();
    expect(a.raw.at(-1)).toBe("pong");
    a.push({ t: "add_bots" });
    await tick(5);
    expect(last(b, "room_state").players.filter((p: any) => p.bot).length).toBe(2);
    a.push({ t: "set_ready", ready: true });
    b.push({ t: "set_ready", ready: true });
    await tick(5);
    expect(last(a, "room_state").phase).toBe("COUNTDOWN");
    host.stop();
  });

  it("알람(타이머)으로 단계가 넘어가고, 연결이 끊기면 재접속 대기 → 토큰으로 복귀", async () => {
    const host = new HostRoom("WXYZ", { DEBUG_COMMANDS: "true" });
    const a = fakePeer(), b = fakePeer();
    host.addPeer(a, "HOST"); host.addPeer(b, "P2P");
    await tick();
    a.push({ t: "join", nickname: "A" }); b.push({ t: "join", nickname: "B" });
    await tick(5);
    a.push({ t: "debug_phase", phase: "ROUND_END" });
    await tick(5);
    expect(last(a, "room_state").phase).toBe("ROUND_END");
    // ROUND_END 5초 → 다음 라운드 (알람). 테스트를 빨리 하려고 단계 종료 시각을 직접 기다리지 않고 확인만
    const endsAt = last(a, "room_state").phaseEndsAt;
    expect(endsAt - Date.now()).toBeGreaterThan(4000);
    // 손님 연결 끊김 → 재접속 대기
    const token = last(b, "welcome").token;
    b.onclose(1006);
    await tick(5);
    const bId = last(b, "welcome").playerId;
    expect(last(a, "room_state").players.find((p: any) => p.id === bId).conn).toBe("RECONNECTING");
    const b2 = fakePeer();
    host.addPeer(b2, "P2P");
    await tick();
    b2.push({ t: "join", nickname: "", token });
    await tick(5);
    expect(last(b2, "welcome").resumed).toBe(true);
    expect(last(a, "room_state").players.find((p: any) => p.id === bId).conn).toBe("CONNECTED");
    host.stop();
    expect(a.closed).toBe(4410);
  });
});
