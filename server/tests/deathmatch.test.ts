// 데스매치 방 흐름: 맵 선택 → 팀별 스폰 → 준비 5초 → 경기(킬 점수, 3초 뒤 부활) → 15킬 또는 10분이면 끝.
// 서버 방 코드를 그대로 돌리고(호스트 기기 어댑터), 가짜 시계로 시간을 빨리 감는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRoom, type PeerLink } from "../../client/src/host/hostRoom";
import { NEON_SPAWNS } from "../../shared/neon";
import { simulate } from "../../shared/sim";
import { CLASSES } from "../../shared/classes";
import { SPAWNS } from "../../shared/world";
import { CLASS_SELECT_MS, COUNTDOWN_MS, MATCH_MS, RESPAWN_INVULN_MS, RESPAWN_MS } from "../src/constants";

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

/** 4명(A팀 a·c, B팀 b·d) 입장 → 맵 선택 → 연습 시작 → 직업 선택이 끝나 준비 단계 */
async function room(map: "CLASSIC" | "NEON" = "CLASSIC") {
  const host = new HostRoom("DMDM", { DEBUG_COMMANDS: "true" });
  const [a, b, c, d] = [fakePeer(), fakePeer(), fakePeer(), fakePeer()];
  for (const p of [a, b, c, d]) host.addPeer(p, "P2P");
  await run(0);
  for (const [p, n] of [[a, "a"], [b, "b"], [c, "c"], [d, "d"]] as const) { p.push({ t: "join", nickname: n }); await run(1); }
  const id = (p: { got: any[] }) => last(p, "welcome").playerId as string;
  const me = (p: { got: any[] }) => last(a, "room_state").players.find((x: any) => x.id === id(p));
  a.push({ t: "set_map", map }); await run(1);
  a.push({ t: "start_practice" }); await run(1);
  await run(CLASS_SELECT_MS);
  return { host, a, b, c, d, id, me };
}
/** a가 b 바로 동쪽 옆에서 동쪽을 보고 죽을 때까지 때린다 (기본 맵 y=2 줄 x 10~22는 빈 곳) */
async function kill(att: ReturnType<typeof fakePeer>, vic: ReturnType<typeof fakePeer>, x = 12) {
  att.push({ t: "debug_teleport", x, y: 2 });
  vic.push({ t: "debug_teleport", x: x + 1.2, y: 2 });
  await run(1);
  for (let i = 0; i < 20; i++) {
    att.push({ t: "attack", yaw: 0, pitch: 0.42 });
    await run(1_000);
    const vId = last(vic, "welcome").playerId;
    if (last(att, "room_state").players.find((p: any) => p.id === vId).combat.state === "DEAD") return;
  }
  throw new Error("못 잡음");
}

describe("데스매치 방 흐름", () => {
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

  it("NEON: A팀은 서쪽, B팀은 동쪽 스폰. 준비 5초 동안은 못 움직이고 못 때리다가 경기 10분 시작", async () => {
    const { host, a, b, me } = await room("NEON");
    const st = last(a, "room_state");
    expect(st.phase).toBe("COUNTDOWN");
    expect(me(a).body).toMatchObject({ x: NEON_SPAWNS.A[0]!.x, y: NEON_SPAWNS.A[0]!.y });
    expect(me(b).body).toMatchObject({ x: NEON_SPAWNS.B[0]!.x, y: NEON_SPAWNS.B[0]!.y });
    expect(me(a).body.v).toBe(CLASSES.KNIGHT.speed); // 직업 안 고르면 기사
    a.push({ t: "move", a: 0, s: 1 }); await run(1_000);
    expect(simulate(last(a, "move").body, Date.now()).x).toBe(NEON_SPAWNS.A[0]!.x); // 준비 중엔 제자리
    a.push({ t: "attack", yaw: 0, pitch: 0.3 }); await run(1);
    expect(last(a, "error").code).toBe("cannot_attack");
    await run(COUNTDOWN_MS);
    const play = last(a, "room_state");
    expect(play.phase).toBe("PLAY");
    expect(play.phaseEndsAt - Date.now()).toBeGreaterThan(MATCH_MS - 5_000);
    // 누르고 있던 방향으로 바로 출발
    expect(simulate(me(a).body, Date.now() + 500).x).toBeGreaterThan(NEON_SPAWNS.A[0]!.x);
    host.stop();
  });

  it("죽이면 팀 킬 +1·킬/데스 기록, 죽은 사람은 3초 뒤 자기 팀 스폰에서 체력 가득 + 2초 무적으로 부활", async () => {
    const { host, a, b, me } = await room();
    await run(COUNTDOWN_MS);
    await kill(a, b);
    let st = last(a, "room_state");
    expect(st.score).toEqual({ A: 1, B: 0 });
    expect(me(a).combat.kills).toBe(1);
    expect(me(b).combat).toMatchObject({ state: "DEAD", hp: 0, deaths: 1 });
    const respawnAt = me(b).combat.respawnAt;
    b.push({ t: "move", a: 0, s: 1 }); await run(1);
    expect(last(b, "move").body.a).toBe(-1); // 죽은 동안엔 못 움직임
    await run(respawnAt - Date.now() + 1);
    st = last(a, "room_state");
    expect(me(b).combat).toMatchObject({ state: "NORMAL", hp: CLASSES.KNIGHT.maxHp, kills: 0, deaths: 1 });
    expect(me(b).combat.invulnUntil).toBe(respawnAt + RESPAWN_INVULN_MS);
    const sp = last(b, "move").body;
    expect(SPAWNS.B.some((p) => p.x === sp.x && p.y === sp.y)).toBe(true);
    expect(RESPAWN_MS).toBe(3_000);
    host.stop();
  });

  it("먼저 15킬 한 팀이 바로 승리", async () => {
    const { host, a, b } = await room();
    await run(COUNTDOWN_MS);
    a.push({ t: "debug_score", A: 14, B: 3 }); await run(1);
    await kill(a, b);
    const st = last(a, "room_state");
    expect(st).toMatchObject({ phase: "MATCH_END", matchWinner: "A", matchEndReason: "score", score: { A: 15, B: 3 } });
    host.stop();
  });

  it("10분이 지나면 킬이 많은 팀 승리, 같으면 무승부", async () => {
    for (const [score, winner] of [[{ A: 4, B: 6 }, "B"], [{ A: 5, B: 5 }, null]] as const) {
      const { host, a } = await room();
      await run(COUNTDOWN_MS);
      a.push({ t: "debug_score", ...score }); await run(1);
      await run(MATCH_MS);
      expect(last(a, "room_state")).toMatchObject({ phase: "MATCH_END", matchWinner: winner, matchEndReason: "time" });
      host.stop();
    }
  });

  it("다시 하기를 누르면 로비로, 킬 점수 초기화", async () => {
    const { host, a } = await room();
    await run(COUNTDOWN_MS);
    a.push({ t: "debug_score", A: 3, B: 2 }); await run(1);
    await run(MATCH_MS);
    a.push({ t: "rematch" }); await run(1);
    expect(last(a, "room_state")).toMatchObject({ phase: "LOBBY", score: { A: 0, B: 0 }, matchWinner: null });
    host.stop();
  });
});
