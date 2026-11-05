// NEON DISTRICT 방 흐름: 맵 선택 → 역할별 스폰 → 15초 준비(결계) → A/B 사이트 → 승리 판정.
// 서버 방 코드를 그대로 돌리고(호스트 기기 어댑터), 가짜 시계로 시간을 빨리 감는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRoom, type PeerLink } from "../../client/src/host/hostRoom";
import { NEON_SPAWNS } from "../../shared/neon";
import { simulate } from "../../shared/sim";
import { BARRIERS, SITES } from "../../shared/world";
import { ATTACK_MS, BREAK_TIME_MS, CLASS_SELECT_MS, PREP_MS, REPAIR_MS, REPAIR_TIME_MS } from "../src/constants";

function fakePeer(): PeerLink & { got: any[]; push(o: unknown): void } {
  const p = {
    got: [] as any[],
    onmessage: (_t: string) => {}, onclose: (_c: number) => {},
    send(text: string) { try { p.got.push(JSON.parse(text)); } catch { /* pong */ } },
    close() {},
    push(o: unknown) { p.onmessage(JSON.stringify(o)); },
  };
  return p;
}
const last = (p: { got: any[] }, t: string) => p.got.filter((m) => m.t === t).at(-1);
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** 4명(A팀 a·c, B팀 b·d) 입장 → NEON 선택 → 연습 시작 → 직업 선택이 끝나 준비 시간 시작 */
async function neonRoom() {
  const host = new HostRoom("NEON", { DEBUG_COMMANDS: "true" });
  const [a, b, c, d] = [fakePeer(), fakePeer(), fakePeer(), fakePeer()];
  for (const p of [a, b, c, d]) host.addPeer(p, "P2P");
  await run(0);
  for (const [p, n] of [[a, "a"], [b, "b"], [c, "c"], [d, "d"]] as const) { p.push({ t: "join", nickname: n }); await run(1); }
  const id = (p: { got: any[] }) => last(p, "welcome").playerId as string;
  const me = (p: { got: any[] }) => last(a, "room_state").players.find((x: any) => x.id === id(p));
  a.push({ t: "set_map", map: "NEON" }); await run(1);
  a.push({ t: "start_practice" }); await run(1);
  await run(CLASS_SELECT_MS);
  return { host, a, b, c, d, id, me };
}
/** 사이트 건물 서쪽 벽 바로 앞 */
const frontOf = (site: "A" | "B", dy = 0) => ({ x: SITES[site].x0 - 0.9, y: (SITES[site].y0 + SITES[site].y1) / 2 + dy });

describe("NEON DISTRICT 방 흐름", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => vi.useRealTimers());

  it("방장만 맵을 고를 수 있다", async () => {
    const host = new HostRoom("MAPS", {});
    const a = fakePeer(), b = fakePeer();
    host.addPeer(a, "P2P"); host.addPeer(b, "P2P");
    await run(0);
    a.push({ t: "join", nickname: "a" }); await run(1);
    b.push({ t: "join", nickname: "b" }); await run(1);
    b.push({ t: "set_map", map: "NEON" }); await run(1);
    expect(last(b, "error").code).toBe("not_owner");
    expect(last(a, "room_state").map).toBe("CLASSIC");
    a.push({ t: "set_map", map: "NEON" }); await run(1);
    expect(last(b, "room_state").map).toBe("NEON");
    host.stop();
  });

  it("역할별 스폰 + 15초 준비: 공격팀은 결계에 막히고 공격 불가, 0초에 결계가 모두에게 같은 시각에 풀린다", async () => {
    const { host, a, b, me } = await neonRoom();
    const st = last(a, "room_state");
    expect(st.phase).toBe("COUNTDOWN");
    expect(st.attackingTeam).toBe("A");
    expect(PREP_MS - (st.phaseEndsAt - Date.now())).toBeLessThan(10); // 준비 시간 15초 (측정 전 1ms 지남)
    expect(st.barrierUntil).toBe(st.phaseEndsAt);
    // A팀(공격)은 서쪽 공격 스폰, B팀(수비)은 동쪽 수비 스폰. 몸에 결계 해제 시각과 역할
    expect(me(a).body).toMatchObject({ x: NEON_SPAWNS.atk[0]!.x, y: NEON_SPAWNS.atk[0]!.y, bu: st.phaseEndsAt, br: "atk" });
    expect(me(b).body).toMatchObject({ x: NEON_SPAWNS.def[0]!.x, y: NEON_SPAWNS.def[0]!.y, bu: st.phaseEndsAt, br: "def" });
    // 공격팀이 동쪽 출구로 걸어가면 결계에서 멈춘다 (준비 시간에도 이동은 됨)
    a.push({ t: "move", a: 0, s: 1 }); await run(3_000);
    const gate = BARRIERS.find((w) => w.role === "all" && w.x0 === 70)!;
    expect(simulate(last(a, "move").body, Date.now()).x).toBeCloseTo(gate.x0 - 0.4, 3);
    a.push({ t: "attack", yaw: 0, pitch: 0.3 }); await run(1);
    expect(last(a, "error").code).toBe("cannot_attack");
    // 수비팀은 준비 시간에 서쪽으로 걸어 사이트 쪽으로 이동 가능
    b.push({ t: "move", a: 16, s: 1 }); await run(1_000);
    expect(simulate(last(b, "move").body, Date.now()).x).toBeLessThan(NEON_SPAWNS.def[0]!.x - 5);
    // 준비 시간 끝 → 공격 단계, 결계 없음, 공격팀이 출구를 지나간다
    await run(PREP_MS);
    const st2 = last(a, "room_state");
    expect(st2.phase).toBe("ATTACK");
    expect(st2.barrierUntil).toBeNull();
    expect(st2.phaseEndsAt - st.phaseEndsAt).toBe(ATTACK_MS);
    expect(simulate(me(a).body, Date.now()).x).toBeGreaterThan(gate.x1);
    host.stop();
  });

  it("라운드 시작 전부터 방향키를 누르고 있으면 준비 시간이 되자마자 걷는다", async () => {
    const host = new HostRoom("WALK", { DEBUG_COMMANDS: "true" });
    const a = fakePeer();
    host.addPeer(a, "P2P");
    await run(0);
    a.push({ t: "join", nickname: "a" }); await run(1);
    a.push({ t: "set_map", map: "NEON" }); await run(1);
    a.push({ t: "start_practice" }); await run(1);
    a.push({ t: "move", a: 8, s: 1 }); // 직업 선택 중에 북쪽 키
    await run(CLASS_SELECT_MS + 500);
    const body = last(a, "room_state").players[0].body;
    expect(body.a).toBe(8);
    expect(simulate(body, Date.now()).y).toBeGreaterThan(NEON_SPAWNS.atk[0]!.y + 1);
    host.stop();
  });

  it("A/B 체력은 따로: A가 부서지면 A만 수리 단계, B는 그대로 멈춤. 수비팀이 고치면 수비팀 승리", async () => {
    const { host, a, b, c, d, id } = await neonRoom();
    await run(PREP_MS);
    a.push({ t: "debug_teleport", ...frontOf("A") }); await run(1);
    c.push({ t: "debug_teleport", ...frontOf("B") }); await run(1);
    b.push({ t: "debug_teleport", ...frontOf("A", 1.5) }); await run(1);
    b.push({ t: "hold_start" }); await run(1);
    expect(last(b, "error").code).toBe("cannot_work"); // 공격 단계에 수비팀은 부술 수 없음
    a.push({ t: "hold_start" }); await run(BREAK_TIME_MS / 4);
    let sites = last(a, "work").sites;
    expect(sites.A.holders).toEqual([id(a)]);
    expect(sites.B.holders).toEqual([]);
    expect(sites.B.progress).toBe(0);
    c.push({ t: "hold_start" }); await run(1);
    expect(last(a, "work").sites.B.holders).toEqual([id(c)]);
    await run((BREAK_TIME_MS * 3) / 4); // A 파괴 (B는 약 3/4)
    let st = last(a, "room_state");
    expect(st.phase).toBe("REPAIR");
    expect(st.roundEnd).toBeNull();
    expect(st.sites.A).toMatchObject({ kind: "REPAIR", progress: 0, holders: [] });
    expect(st.sites.B.kind).toBeNull();
    const bLeft = st.sites.B.progress;
    expect(bLeft).toBeGreaterThan(0.7);
    expect(bLeft).toBeLessThan(0.8);
    // 공격팀은 수리 단계에 아무 건물도 못 건드리고, 수비팀은 B(안 부서진 건물)는 못 고친다
    c.push({ t: "hold_start" }); await run(1);
    expect(last(c, "error").code).toBe("cannot_work");
    d.push({ t: "debug_teleport", ...frontOf("B") }); await run(1);
    d.push({ t: "hold_start" }); await run(1);
    expect(last(d, "error").code).toBe("cannot_work");
    b.push({ t: "hold_start" }); await run(REPAIR_TIME_MS + 1);
    st = last(a, "room_state");
    expect(st.phase).toBe("ROUND_END");
    expect(st.roundEnd).toEqual({ winner: "B", reason: "repair_success", site: "A" });
    expect(st.score).toEqual({ A: 0, B: 1 });
    expect(st.sites.A.progress).toBe(0); // 다 고쳐짐 (멈춘 사이트 progress = 부서진 정도)
    expect(st.sites.B.progress).toBe(bLeft);
    for (const p of [b, c]) expect(last(p, "room_state").roundEnd).toEqual(st.roundEnd);
    host.stop();
  });

  it("A와 B가 같은 순간에 다 부서져도 수리 단계는 한 번, 못 고치면 공격팀 승리", async () => {
    const { host, a, c } = await neonRoom();
    await run(PREP_MS);
    a.push({ t: "debug_teleport", ...frontOf("A") });
    c.push({ t: "debug_teleport", ...frontOf("B") });
    await run(1);
    a.push({ t: "hold_start" }); c.push({ t: "hold_start" }); // 같은 시각에 시작 → 같은 시각에 완료
    await run(BREAK_TIME_MS + 1_000);
    let st = last(a, "room_state");
    expect(st.phase).toBe("REPAIR");
    expect([st.sites.A.kind, st.sites.B.kind].filter((k) => k === "REPAIR")).toHaveLength(1);
    await run(REPAIR_MS);
    st = last(a, "room_state");
    expect(st.phase).toBe("ROUND_END");
    expect(st.score).toEqual({ A: 1, B: 0 });
    expect(st.history).toHaveLength(1);
    expect(st.roundEnd.reason).toBe("repair_fail");
    expect(["A", "B"]).toContain(st.roundEnd.site);
    host.stop();
  });

  it("2분 동안 두 건물을 지키면 수비팀 승리, 다음 라운드도 역할별 스폰", async () => {
    const { host, a, b, me } = await neonRoom();
    await run(PREP_MS + ATTACK_MS);
    const st = last(a, "room_state");
    expect(st.phase).toBe("ROUND_END");
    expect(st.roundEnd).toEqual({ winner: "B", reason: "break_timeout" });
    expect(st.score).toEqual({ A: 0, B: 1 });
    await run(5_000); // 다음 라운드 준비 시간
    const st2 = last(a, "room_state");
    expect(st2).toMatchObject({ phase: "COUNTDOWN", round: 2 });
    expect(me(a).body).toMatchObject({ x: NEON_SPAWNS.atk[0]!.x, br: "atk" });
    expect(me(b).body).toMatchObject({ x: NEON_SPAWNS.def[0]!.x, br: "def" });
    expect(st2.sites.A.progress).toBe(0);
    host.stop();
  });
});
