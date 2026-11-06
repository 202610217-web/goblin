// 연속 처치·현상금 보상과 맵 가운데 파워업 (서버 방 코드를 호스트 어댑터로 돌림)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRoom, type PeerLink } from "../../client/src/host/hostRoom";
import { CLASSES, PICKUP, STREAK } from "../../shared/classes";
import { PICKUP_SPOTS } from "../../shared/world";
import { CLASS_SELECT_MS, COUNTDOWN_MS, RESPAWN_INVULN_MS, RESPAWN_MS } from "../src/constants";
import { addKillStreak, applyHit, newCombat, powered, takePickup } from "../src/combat";

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

describe("연속 처치 보상 (규칙)", () => {
  it("죽지 않고 3킬마다 궁극기 +30, 3연속 이상인 적을 잡으면 현상금 +50, 죽으면 연속 0", () => {
    let c: ReturnType<typeof newCombat> = { ...newCombat(100), ult: 0 };
    for (let i = 1; i <= 2; i++) { const r = addKillStreak(c, 0); c = r.c; expect(r.milestone).toBe(false); }
    const r3 = addKillStreak(c, 0);
    expect(r3).toMatchObject({ milestone: true, bounty: false, c: { streak: 3, kills: 3, ult: STREAK.ULT_BONUS } });
    expect(addKillStreak({ ...newCombat(100), ult: 10 }, 3)).toMatchObject({ bounty: true, c: { streak: 1, ult: 10 + STREAK.BOUNTY_ULT } });
    expect(addKillStreak({ ...r3.c, ult: 90 }, 5).c.ult).toBe(100); // 100을 넘지 않음
    expect(applyHit(r3.c, 1000, 999).streak).toBe(0);
  });

  it("파워업: 체력 가득 / 10초 데미지 1.5배 / 궁극기 +50, 죽은 사람은 못 먹음", () => {
    const hurt = { ...newCombat(100), hp: 20, ult: 70 };
    expect(takePickup(hurt, "heal", 0, 100).hp).toBe(100);
    expect(takePickup(hurt, "ult", 0, 100).ult).toBe(100);
    const p = takePickup(hurt, "power", 1000, 100);
    expect(powered(p, 20, 1000 + PICKUP.POWER_MS - 1)).toBe(30);
    expect(powered(p, 20, 1000 + PICKUP.POWER_MS)).toBe(20);
    expect(takePickup(applyHit(hurt, 0, 999), "heal", 0, 100).hp).toBe(0);
    expect(applyHit(p, 1000, 999).powerUntil).toBeUndefined(); // 죽으면 강화도 끝
  });
});

describe("연속 처치·파워업 (방 흐름)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => vi.useRealTimers());

  it("3연속 처치하면 streak 알림, 그 사람을 잡으면 현상금 알림", async () => {
    const { host, a, b, d, id, me } = await room();
    await run(COUNTDOWN_MS);
    for (let i = 0; i < 3; i++) {
      await kill(a, i % 2 ? d : b);
      await run(RESPAWN_MS + RESPAWN_INVULN_MS + 10);
    }
    expect(last(b, "streak")).toMatchObject({ by: id(a), streak: 3, bounty: false });
    expect(me(a).combat.streak).toBe(3);
    await kill(b, a, 14);
    expect(last(a, "streak")).toMatchObject({ by: id(b), victim: id(a), bounty: true });
    expect(me(a).combat.streak).toBe(0);
    host.stop();
  });

  it("경기 30초 뒤 가운데에 파워업이 생기고, 밟으면 먹고 30초 뒤 다시 생긴다. 멀리선 못 먹음", async () => {
    const { host, a, b, id, me } = await room();
    await run(COUNTDOWN_MS);
    expect(last(a, "room_state").pickup).toBeNull();
    await run(PICKUP.RESPAWN_MS);
    const pk = last(a, "room_state").pickup;
    expect(pk).toMatchObject({ ...PICKUP_SPOTS.CLASSIC, z: 1.6 }); // 기본 맵 가운데 단상 위
    b.push({ t: "pickup" }); await run(1); // 스폰에 있는 b는 너무 멂
    expect(last(a, "room_state").pickup).not.toBeNull();
    a.push({ t: "debug_teleport", x: pk.x + 0.5, y: pk.y }); await run(1);
    a.push({ t: "pickup" }); await run(1);
    expect(last(b, "picked")).toMatchObject({ by: id(a), kind: pk.kind });
    expect(last(a, "room_state").pickup).toBeNull();
    if (pk.kind === "power") expect(me(a).combat.powerUntil).toBe(Date.now() - 1 + PICKUP.POWER_MS);
    if (pk.kind === "ult") expect(me(a).combat.ult).toBe(PICKUP.ULT);
    if (pk.kind === "heal") expect(me(a).combat.hp).toBe(CLASSES.KNIGHT.maxHp);
    await run(PICKUP.RESPAWN_MS);
    expect(last(a, "room_state").pickup).not.toBeNull();
    host.stop();
  });
});
