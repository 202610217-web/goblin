// 3D 시험판 진입점: 입장 → 로비 → 게임 화면(이동/점프/카메라)
import { type Body, angleToRad, groundHeightAt, makeBody, radToAngle, simulate, withAngle, withJump } from "../../shared/sim";
import { SPAWNS, type TeamId } from "../../shared/world";
import { CONFIG } from "./config";
import { Input } from "./input";
import { Net } from "./net";
import { PlayerView, World3D } from "./world3d";

// ---------- 서버 주소 ----------
// .env의 VITE_SERVER_URL, 없으면 지금 접속한 주소의 8787 포트 (같은 와이파이 패드 테스트용)
const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL || `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787`;

/**
 * 혼자 연습 모드: 서버 없이 같은 물리 코드(shared/sim.ts)를 브라우저에서만 돌려 조작감을 확인한다.
 * 빌드 시 VITE_OFFLINE=1 이거나 주소에 ?offline 이 있으면 켜진다.
 */
const OFFLINE = import.meta.env.VITE_OFFLINE === "1" || new URLSearchParams(location.search).has("offline");

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Phase = "LOBBY" | "COUNTDOWN" | "ATTACK" | "REPAIR" | "ROUND_END" | "MATCH_END";
interface PublicPlayer {
  id: string; nickname: string; team: TeamId; conn: "CONNECTED" | "RECONNECTING";
  ready: boolean; body: Body; seq: number;
}
interface RoomState {
  room: string; phase: Phase; round: number; attackingTeam: TeamId; phaseEndsAt: number | null; players: PublicPlayer[];
}

/** 화면에 그리는 플레이어 */
interface Actor {
  view: PlayerView;
  team: TeamId;
  /** 현재 시각까지 진행한 물리 상태 (내 캐릭터는 예측 상태) */
  cur: Body;
  /** 서버 보정 오차 (점점 0으로 줄여서 부드럽게 보정) */
  off: { x: number; y: number; z: number };
  face: number;
}

const world = new World3D($("stage"));
const input = new Input($("touch"), $("stickBase"), $("stickKnob"), $("jumpBtn"));
const net = new Net(SERVER_URL);

let myId: string | null = null;
let roomCode = "";
let room: RoomState | null = null;
const actors = new Map<string, Actor>();

// 입력 전송 상태
let seq = 0;
let lastSentSeq = 0;
let lastSentA = -2;
let lastMoveSendAt = 0;

const tokenKey = () => `token:${roomCode}`;
const movable = () => room?.phase === "ATTACK" || room?.phase === "REPAIR";

// ---------- 입장 화면 ----------
const roomInput = $<HTMLInputElement>("roomInput");
const nickInput = $<HTMLInputElement>("nickInput");
nickInput.value = localStorage.getItem("nickname") ?? "";
roomInput.value = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});
// 가상 키보드가 올라와도 입력창이 보이도록
for (const el of [roomInput, nickInput]) el.addEventListener("focus", () => setTimeout(() => el.scrollIntoView({ block: "center" }), 300));
$("randomRoom").onclick = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  roomInput.value = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};
$("joinBtn").onclick = () => {
  const code = roomInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) return showJoinError("방 코드는 4~6자리 영문/숫자예요");
  localStorage.setItem("nickname", nickInput.value.trim());
  roomCode = code;
  showJoinError("");
  (document.activeElement as HTMLElement | null)?.blur();
  net.connect(code);
};
function showJoinError(t: string) { $("joinError").textContent = t; }

// ---------- 로비 ----------
document.querySelectorAll<HTMLButtonElement>("[data-team]").forEach((b) => {
  b.onclick = () => net.send({ t: "set_team", team: b.dataset.team });
});
$("readyBtn").onclick = () => {
  const me = room?.players.find((p) => p.id === myId);
  net.send({ t: "set_ready", ready: !me?.ready });
};
$("reconnectBtn").onclick = () => { $("disconnected").classList.add("hidden"); net.connect(roomCode); };

// 개발 모드: 강제 단계 전환 버튼 (서버 DEBUG_COMMANDS=true 필요)
if (import.meta.env.DEV && !OFFLINE) {
  const dbg = $("debug");
  dbg.classList.remove("hidden");
  for (const ph of ["LOBBY", "COUNTDOWN", "ATTACK", "REPAIR", "ROUND_END"]) {
    const b = document.createElement("button");
    b.className = "secondary";
    b.textContent = ph;
    b.onclick = () => net.send({ t: "debug_phase", phase: ph });
    dbg.appendChild(b);
  }
}

// ---------- 네트워크 ----------
net.onOpen = () => {
  net.send({ t: "join", nickname: nickInput.value, token: sessionStorage.getItem(tokenKey()) ?? undefined });
};
net.onClose = (code) => {
  if (myId) $("disconnected").classList.remove("hidden");
  else showJoinError(code === 1006 ? "서버에 연결할 수 없어요" : `연결 실패 (${code})`);
};
net.onMessage = (m) => {
  switch (m.t) {
    case "welcome":
      myId = m.playerId;
      sessionStorage.setItem(tokenKey(), m.token);
      lastSentA = -2; // 접속 직후 현재 입력을 다시 보낸다
      $("join").classList.add("hidden");
      break;
    case "room_state":
      applyRoomState(m as RoomState);
      break;
    case "move":
      onMove(m.id, m.body, m.s);
      break;
    case "notice":
      toast(m.message);
      break;
    case "error":
      if (!myId) showJoinError(m.message);
      else if (m.code !== "rate_limited") toast(m.message);
      break;
  }
};

let lastRoundKey = "";
function applyRoomState(s: RoomState) {
  const prevPhase = room?.phase;
  room = s;
  // 라운드 시작(준비 단계 진입) 때 카메라를 상대 진영 쪽으로 돌린다
  const myTeam = s.players.find((p) => p.id === myId)?.team;
  const roundKey = `${s.round}:${myTeam}`;
  if (myTeam && (s.phase === "COUNTDOWN" || s.phase === "LOBBY") && (roundKey !== lastRoundKey || prevPhase !== s.phase)) {
    lastRoundKey = roundKey;
    world.yaw = myTeam === "A" ? 0 : Math.PI;
    world.pitch = CONFIG.CAMERA_PITCH_DEFAULT;
  }
  // 사라진 플레이어 정리
  for (const [id, a] of actors) {
    if (!s.players.some((p) => p.id === id)) { a.view.dispose(world.scene); actors.delete(id); }
  }
  for (const p of s.players) {
    let a = actors.get(p.id);
    if (!a || a.team !== p.team) {
      a?.view.dispose(world.scene);
      a = { view: new PlayerView(world.scene, p.team, p.nickname, p.id === myId), team: p.team, cur: p.body, off: { x: 0, y: 0, z: 0 }, face: 0 };
      actors.set(p.id, a);
    }
    a.view.setNickname(p.id === myId ? `${p.nickname} (나)` : p.nickname + (p.conn === "RECONNECTING" ? " (재접속 중)" : ""));
    reconcile(a, p.body, p.id === myId);
  }
  renderLobby();
  renderScreens();
}

function onMove(id: string, body: Body, s: number) {
  const a = actors.get(id);
  if (!a) return;
  if (id === myId && s < lastSentSeq) return; // 더 새 입력이 아직 서버로 가는 중이면 보정하지 않는다
  reconcile(a, body, id === myId);
}

/** 내 이동 의도 (카메라 기준 스틱 방향 → 월드 각도 단계, 없으면 -1) */
function desiredAngle(): number {
  if (input.moveX === 0 && input.moveY === 0) return -1;
  // 카메라 앞 방향 f, 오른쪽 r = (f.y, -f.x)
  const fx = Math.cos(world.yaw), fy = Math.sin(world.yaw);
  const mx = fx * input.moveY + fy * input.moveX;
  const my = fy * input.moveY - fx * input.moveX;
  return radToAngle(Math.atan2(my, mx));
}

/** 서버 상태를 받아 현재 시각까지 진행하고, 화면 위치가 튀지 않게 오차를 off에 넣는다 */
function reconcile(a: Actor, body: Body, isMe: boolean) {
  const now = net.serverNow();
  let nb = simulate(body, now);
  if (isMe) {
    const effA = movable() ? desiredAngle() : -1;
    if (nb.a !== effA) nb = withAngle(nb, effA, now); // 아직 서버에 안 간 내 입력은 바로 반영
  }
  const ox = a.cur.x + a.off.x - nb.x;
  const oy = a.cur.y + a.off.y - nb.y;
  const oz = a.cur.z + a.off.z - nb.z;
  if (Math.hypot(ox, oy, oz) > CONFIG.SNAP_DISTANCE) a.off = { x: 0, y: 0, z: 0 };
  else a.off = { x: ox, y: oy, z: oz };
  a.cur = nb;
}

// ---------- 화면 ----------
function renderLobby() {
  if (!room) return;
  $("lobbyRoom").textContent = room.room;
  for (const t of ["A", "B"] as TeamId[]) {
    const box = $(`team${t}`);
    box.replaceChildren(...room.players.filter((p) => p.team === t).map((p) => {
      const d = document.createElement("div");
      d.textContent = `${p.nickname}${p.ready ? " ✔" : ""}${p.conn === "RECONNECTING" ? " (재접속 중)" : ""}`;
      if (p.id === myId) d.className = "me";
      if (p.ready) d.classList.add("ready");
      return d;
    }));
  }
  const me = room.players.find((p) => p.id === myId);
  const btn = $("readyBtn");
  btn.textContent = me?.ready ? "준비 취소" : "준비";
  btn.classList.toggle("on", !!me?.ready);
}

function renderScreens() {
  const inLobby = !room || room.phase === "LOBBY";
  $("lobby").classList.toggle("hidden", !myId || !inLobby);
  $("hud").classList.toggle("hidden", inLobby);
  $("touch").classList.toggle("hidden", !myId || inLobby);
}

const PHASE_NAME: Record<Phase, string> = {
  LOBBY: "로비", COUNTDOWN: "준비", ATTACK: "공격 단계", REPAIR: "수리 단계", ROUND_END: "라운드 종료", MATCH_END: "게임 종료",
};
function renderHud(now: number) {
  if (!room || room.phase === "LOBBY") return;
  if (OFFLINE) {
    setText("hudRound", "혼자 연습 모드");
    setText("hudTimer", "자유 이동");
    setText("hudRole", "왼쪽: 이동 · 오른쪽 드래그: 카메라 · 점프 버튼");
    setText("netStatus", "서버 없음 (연습)");
    return;
  }
  const left = room.phaseEndsAt === null ? 0 : Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000));
  const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
  setText("hudRound", `라운드 ${room.round} · ${PHASE_NAME[room.phase]}`);
  setText("hudTimer", room.phase === "COUNTDOWN" ? `${left}` : `${mm}:${ss}`);
  const me = room.players.find((p) => p.id === myId);
  if (me) {
    const atk = me.team === room.attackingTeam;
    const enemy = me.team === "A" ? "B" : "A";
    setText("hudRole", atk ? `⚔ 공격팀 — ${enemy}팀 집을 부수세요` : `🛡 수비팀 — ${me.team}팀 집을 지키세요`);
  }
  const ns = $("netStatus");
  const bad = !net.connected || net.rtt > CONFIG.PING_WARN_MS;
  setText("netStatus", net.connected ? `${bad ? "⚠ " : ""}ping ${Math.round(net.rtt)}ms` : "⚠ 연결 끊김");
  ns.classList.toggle("bad", bad);
}
function setText(id: string, t: string) { const el = $(id); if (el.textContent !== t) el.textContent = t; }

let toastTimer = 0;
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), 2500);
}

// ---------- 앱이 백그라운드로 가면 즉시 정지 ----------
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    input.reset();
    if (lastSentA !== -1) { net.send({ t: "move", a: -1, s: ++seq }); lastSentSeq = seq; lastSentA = -1; }
  }
});

// ---------- 게임 루프 ----------
let lastFrame = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const t = performance.now();
  const dt = Math.min(0.1, (t - lastFrame) / 1000);
  lastFrame = t;
  const now = net.serverNow();

  input.enabled = !!myId && !!room && room.phase !== "LOBBY";
  input.update(dt);
  const cam = input.consumeCamera();
  world.yaw += cam.yaw;
  world.pitch += cam.pitch;

  const me = myId ? actors.get(myId) : undefined;
  if (me && (net.connected || OFFLINE)) {
    // 1) 이동 의도 전송: 바뀔 때만, 최소 간격 유지 (서버가 이동 불가 단계에서도 의도를 기억함)
    const want = desiredAngle();
    if (want !== lastSentA && t - lastMoveSendAt >= CONFIG.MOVE_SEND_INTERVAL_MS) {
      net.send({ t: "move", a: want, s: ++seq });
      lastSentSeq = seq;
      lastSentA = want;
      lastMoveSendAt = t;
    }
    // 2) 내 캐릭터 예측: 입력을 즉시 반영
    const effA = movable() ? want : -1;
    me.cur = simulate(me.cur, now);
    if (me.cur.a !== effA) me.cur = withAngle(me.cur, effA, now);
    // 3) 점프 (1회 = 메시지 1개)
    if (input.consumeJump() && movable()) {
      const j = withJump(me.cur, now);
      if (j) {
        me.cur = j;
        net.send({ t: "jump", s: ++seq });
        lastSentSeq = seq;
      }
    }
  } else {
    input.consumeJump();
  }

  // 4) 모든 캐릭터 진행 + 보정 오차 줄이기 + 그리기
  const decay = Math.exp((-dt * 1000) / CONFIG.CORRECTION_SMOOTH_MS);
  const w = window.innerWidth, h = window.innerHeight;
  for (const [id, a] of actors) {
    if (id !== myId) a.cur = simulate(a.cur, now);
    a.off.x *= decay; a.off.y *= decay; a.off.z *= decay;
    if (a.cur.a >= 0) a.face = angleToRad(a.cur.a);
    const x = a.cur.x + a.off.x, y = a.cur.y + a.off.y, z = Math.max(0, a.cur.z + a.off.z);
    const p = room?.players.find((pp) => pp.id === id);
    a.view.update(x, y, z, a.face, groundHeightAt(x, y, z), p?.conn === "RECONNECTING");
    if (id === myId) world.updateCamera(x, y, z);
  }
  if (!me) world.updateCamera(24, 14 - 8, 0); // 입장 전: 맵 가운데를 비춤
  world.render();
  for (const a of actors.values()) a.view.placeLabel(world.camera, w, h);
  renderHud(now);
}
world.yaw = Math.PI / 2; // 입장 전 카메라는 북쪽을 바라봄

// 혼자 연습 모드: 입장 화면 없이 A팀 시작 위치에서 바로 움직일 수 있는 상태로 시작
if (OFFLINE) {
  myId = "me";
  world.yaw = 0; // 동쪽(상대 팀 집 방향)을 바라보며 시작
  $("join").classList.add("hidden");
  const sp = SPAWNS.A[0]!;
  applyRoomState({
    room: "연습", phase: "ATTACK", round: 1, attackingTeam: "A", phaseEndsAt: null,
    players: [{ id: "me", nickname: "연습", team: "A", conn: "CONNECTED", ready: true, body: makeBody(sp.x, sp.y, net.serverNow()), seq: 0 }],
  });
}
requestAnimationFrame(frame);

// 개발 모드에서만: 자동 테스트/디버깅용으로 상태 노출
if (import.meta.env.DEV) (window as any).__game = { actors, world, get myId() { return myId; } };
