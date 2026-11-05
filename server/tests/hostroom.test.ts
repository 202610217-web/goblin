import { describe, expect, it } from "vitest";
import { CLASSES, type ClassId } from "../../shared/classes";
import { HostRoom, type PeerLink } from "../../client/src/host/hostRoom";
import { makeArrow } from "../../shared/arrow";
import { makeBody } from "../../shared/sim";

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
    expect(last(a, "room_state").phase).toBe("LOBBY"); // 자동 시작 없음
    a.push({ t: "start_game" });
    await tick(5);
    expect(last(a, "room_state").phase).toBe("CLASS_SELECT");
    host.stop();
  });

  it("방장만 시작, 직업 선택 후 COUNTDOWN에서 직업 체력 적용 (안 고르면 기사)", async () => {
    const host = new HostRoom("CLSS", { DEBUG_COMMANDS: "true" });
    const a = fakePeer(), b = fakePeer();
    host.addPeer(a, "HOST"); host.addPeer(b, "P2P");
    await tick();
    a.push({ t: "join", nickname: "방장" }); b.push({ t: "join", nickname: "손님" });
    await tick(5);
    const st = last(a, "room_state");
    expect(st.players.map((p: any) => p.owner)).toEqual([true, false]);
    a.push({ t: "add_bots" }); await tick(5);
    a.push({ t: "set_ready", ready: true }); b.push({ t: "set_ready", ready: true }); await tick(5);
    b.push({ t: "start_game" }); await tick(5);
    expect(last(b, "error").code).toBe("not_owner");
    a.push({ t: "start_game" }); await tick(5);
    expect(last(a, "room_state").phase).toBe("CLASS_SELECT");
    b.push({ t: "set_class", cls: "ARCHER" }); await tick(5);
    a.push({ t: "debug_phase", phase: "COUNTDOWN" }); await tick(5);
    const ps = last(a, "room_state").players;
    const byName = (n: string) => ps.find((p: any) => p.nickname === n);
    expect(byName("손님")).toMatchObject({ cls: "ARCHER", combat: { hp: CLASSES.ARCHER.maxHp } });
    expect(byName("방장")).toMatchObject({ cls: "KNIGHT", combat: { hp: CLASSES.KNIGHT.maxHp } });
    for (const p of ps.filter((p: any) => p.bot)) expect(p.combat.hp).toBe(CLASSES[p.cls as ClassId].maxHp);
    host.stop();
  });

  it("궁수 화살: 쏘면 shot 방송, 가만히 있는 적은 날아간 뒤 맞는다", async () => {
    const host = new HostRoom("ARRW", { DEBUG_COMMANDS: "true" });
    const a = fakePeer(), b = fakePeer();
    host.addPeer(a, "HOST"); host.addPeer(b, "P2P");
    await tick();
    a.push({ t: "join", nickname: "기사" }); b.push({ t: "join", nickname: "궁수" });
    await tick(5);
    a.push({ t: "start_practice" }); await tick(5);
    b.push({ t: "set_class", cls: "ARCHER" }); await tick(5);
    a.push({ t: "debug_phase", phase: "COUNTDOWN" }); await tick(5);
    a.push({ t: "debug_phase", phase: "ATTACK" }); await tick(5);
    // y=2 줄은 x 10~22가 빈 곳. 궁수는 (10,2)에서 동쪽으로, 적은 화살 길 위 7m 앞에 세운다
    b.push({ t: "debug_teleport", x: 10, y: 2 }); await tick(5);
    const arrow = makeArrow(makeBody(10, 2, 0), 0, 0.1, 0);
    a.push({ t: "debug_teleport", x: 10 + arrow.dir.x * 7, y: 2 + arrow.dir.y * 7 }); await tick(5);
    const aId = last(a, "welcome").playerId;
    const hp0 = last(a, "room_state").players.find((p: any) => p.id === aId).combat.hp;
    b.push({ t: "attack", yaw: 0, pitch: 0.1 }); await tick(5);
    expect(last(a, "shot")).toMatchObject({ by: last(b, "welcome").playerId });
    expect(last(a, "swing")).toBeUndefined(); // 아직 날아가는 중
    await tick(400);
    expect(last(a, "swing")).toMatchObject({ target: aId });
    expect(last(a, "room_state").players.find((p: any) => p.id === aId).combat.hp).toBe(hp0 - 25);
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

describe("순서 없이 도착하는 이동 (기기 직접 연결의 빠른 통로)", () => {
  it("더 새 입력보다 늦게 도착한 이동은 버리고, 재접속하면 순번을 다시 센다", async () => {
    const host = new HostRoom("SEQQ", { DEBUG_COMMANDS: "true" });
    const a = fakePeer();
    host.addPeer(a, "HOST");
    await tick();
    a.push({ t: "join", nickname: "A" });
    await tick(5);
    a.push({ t: "debug_phase", phase: "ATTACK" });
    await tick(5);
    a.push({ t: "move", a: 8, s: 5 });
    a.push({ t: "move", a: 3, s: 4 }); // 늦게 도착한 옛 입력
    await tick(5);
    const id = last(a, "welcome").playerId;
    const moves = a.got.filter((m) => m.t === "move" && m.id === id);
    expect(moves.at(-1).body.a).toBe(8);
    // 새로고침한 화면처럼 순번 1부터 다시 보내도 받아 준다
    const token = last(a, "welcome").token;
    a.onclose(1006);
    await tick(5);
    const a2 = fakePeer();
    host.addPeer(a2, "HOST");
    await tick();
    a2.push({ t: "join", nickname: "", token });
    await tick(5);
    a2.push({ t: "move", a: 16, s: 1 });
    await tick(5);
    expect(a2.got.filter((m) => m.t === "move" && m.id === id).at(-1).body.a).toBe(16);
    host.stop();
  });
});

describe("창던지기병", () => {
  it("직업 선택에서 고르면 그 직업 체력으로 시작", async () => {
    const host = new HostRoom("JAVL", { DEBUG_COMMANDS: "true" });
    const a = fakePeer();
    host.addPeer(a, "HOST");
    await tick();
    a.push({ t: "join", nickname: "창" }); await tick(5);
    a.push({ t: "start_practice" }); await tick(5);
    a.push({ t: "set_class", cls: "JAVELIN" }); await tick(5);
    a.push({ t: "debug_phase", phase: "COUNTDOWN" }); await tick(5);
    expect(last(a, "room_state").players[0]).toMatchObject({ cls: "JAVELIN", combat: { hp: CLASSES.JAVELIN.maxHp } });
    host.stop();
  });
});
