// 게임 진입점: 입장 → 로비 → 게임 화면 (이동/점프/타격/집 작업/치유/관전) → 라운드/경기 종료
import { type Body, angleToRad, groundHeightAt, makeBody, radToAngle, simulate, withAngle, withCrouch, withJump } from "../../shared/sim";
import { SPAWNS, type TeamId } from "../../shared/world";
import { Minimap } from "./minimap";
import { setHighQuality } from "./graphics";
import { damageDirection, damageNumber, feed, hitMarker } from "./hudfx";
import { findAimTarget } from "../../shared/aim";
// 서버와 같은 메시지 형식/규칙 수치를 그대로 쓴다 (타입은 빌드 때 지워진다)
import type { Phase, PublicPlayer, RoomStateMessage, ServerMessage } from "../../server/src/protocol";
import { canStartMatch } from "../../server/src/phase";
import { CLASSES, KILL_TARGET } from "../../shared/classes";
import { CONFIG } from "./config";
import { Input } from "./input";
import { Net } from "./net";
import { PlayerView, World3D } from "./world3d";
import { HostRoomProxy } from "./host/hostProxy";
import { P2PHost } from "./p2p";
import { fullscreenSupported, isStandalone, keepScreenOn, setVibration, toggleFullscreen, vibrate, vibrationEnabled } from "./device";

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

/** 화면에 그리는 플레이어 */
interface Actor {
  id: string;
  view: PlayerView;
  team: TeamId;
  /** 현재 시각까지 진행한 물리 상태 (내 캐릭터는 예측 상태) */
  body: Body;
  /** 서버 보정 오차 (점점 0으로 줄여서 부드럽게 보정) */
  off: { x: number; y: number; z: number };
  face: number;
  /** 서버가 보낸 최신 정보 */
  info: PublicPlayer;
  /** 마지막으로 받은 서버 위치의 시각 (빠른 통로는 순서가 없어서, 더 오래된 위치는 무시) */
  serverT: number;
}

const world = new World3D($("stage"));
const input = new Input($("touch"), $("stickBase"), $("stickKnob"), { jump: $("jumpBtn"), attack: $("attackBtn"), crouch: $("crouchBtn") });
const net = new Net(SERVER_URL);

let myId: string | null = null;
/** "내 기기로 방 만들기"를 했을 때: 이 기기 안의 방 서버와 연결 중계 */
let p2pHost: P2PHost | null = null;
/** 내 기기로 연 방(또는 그 방의 손님): 경기가 끝난 뒤 방이 닫히는 시각 (performance.now 기준) */
let matchCloseAt: number | null = null;
let matchCloseTimer = 0;
let roomCode = "";
let room: RoomStateMessage | null = null;
const actors = new Map<string, Actor>();

// 입력 전송 상태
let seq = 0;
let lastSentSeq = 0;
let lastSentA = -2;
let lastMoveSendAt = 0;
/** 이동 의도가 마지막으로 바뀐 서버 기준 시각 (화면 예측에 쓴 시각 = 서버에 보내는 시각) */
let prevWant = -2;
let wantChangedAt = 0;
/** 지금 누르고 있는 행동 (버튼을 뗄 때 같은 종류의 stop을 보낸다) */
let localAttackAt = -Infinity;
/** 핑 측정용: 입력 순번별로 보낸 시각, 타격 보낸 시각 */
const sentAt = new Map<number, number>();
let attackSentAt = 0;
/** 서버 판정 전에 미리 번쩍이게 한 상대 */
let predictedHit: string | null = null;
/** 핑 진단: 내가 들어온 Cloudflare 위치 → 방 서버 위치 */
let route = "";
/** 쿨다운 중에 누른 타격을 이 시각까지 기억 (서버 시각) */
let attackBufferedUntil = -Infinity;

const tokenKey = () => `token:${roomCode}`;
const movable = () => room?.phase === "PLAY";
const canWalk = movable;
const me = () => (myId ? actors.get(myId) : undefined);
const myInfo = () => me()?.info;
const myNormal = () => myInfo()?.combat.state === "NORMAL";
const inGame = () => !!room && room.phase !== "LOBBY";
/** 이 플레이어의 직업 수치 */
const classOf = (p?: PublicPlayer) => CLASSES[p?.cls ?? "KNIGHT"];

// ---------- 입장 화면 ----------
const roomInput = $<HTMLInputElement>("roomInput");
const nickInput = $<HTMLInputElement>("nickInput");
try { nickInput.value = localStorage.getItem("nickname") ?? ""; } catch { /* 무시 */ }
roomInput.value = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});
// 가상 키보드가 올라와도 입력창이 보이도록
for (const el of [roomInput, nickInput]) el.addEventListener("focus", () => setTimeout(() => el.scrollIntoView({ block: "center" }), 300));
/** 방 코드: 들어가기는 입력한 코드, 만들기는 새 코드 (헷갈리는 글자 0/O, 1/I 뺌) */
function readRoomCode(make: boolean): string | null {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = make ? Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("") : roomInput.value.trim().toUpperCase();
  if (!make && !code) { showJoinError("친구에게 받은 방 코드를 넣어 주세요"); roomInput.focus(); return null; }
  if (!/^[A-Z0-9]{4,6}$/.test(code)) { showJoinError("방 코드는 4~6자리 영문/숫자예요"); return null; }
  try { localStorage.setItem("nickname", nickInput.value.trim()); } catch { /* 무시 */ }
  (document.activeElement as HTMLElement | null)?.blur();
  return code;
}

// 입장: 방에 호스트 기기가 있으면 그 기기에 직접 연결, 없으면 Cloudflare 방
$("joinBtn").onclick = () => {
  const code = readRoomCode(false);
  if (!code) return;
  roomCode = code;
  stopHosting();
  net.reset();
  showJoinError("연결 중...");
  net.connect(code);
};

// 내 기기로 방 만들기: 이 기기가 게임 서버가 된다
$("hostBtn").onclick = () => {
  const code = readRoomCode(true);
  if (!code) return;
  roomCode = code;
  stopHosting();
  net.reset();
  // 게임 서버는 Web Worker에서 돈다 (화면 그리기와 따로)
  const hostRoom = new HostRoomProxy(code, { DEBUG_COMMANDS: import.meta.env.DEV ? "true" : "false" });
  p2pHost = new P2PHost(SERVER_URL, code, hostRoom);
  p2pHost.onerror = (message) => goToJoin(message);
  p2pHost.start();
  net.useHost(hostRoom);
  showJoinError("방을 여는 중...");
  net.connect(code);
};

function stopHosting() {
  p2pHost?.stop();
  p2pHost = null;
}
function showJoinError(t: string) { $("joinError").textContent = t; }
if (!fullscreenSupported() && !isStandalone()) $("a2hsHint").classList.remove("hidden");

/**
 * 내 기기로 연 방: 경기가 끝나면 결과를 잠깐 보여 준 뒤 방 서버를 끈다 (기기 자원 반납).
 * 그 안에 누가 "다시 하기"를 눌러 로비로 돌아가면 계속한다.
 */
function updateMatchClose(s: RoomStateMessage) {
  const hosted = net.mode === "host" || net.mode === "p2p";
  if (hosted && s.phase === "MATCH_END") {
    if (matchCloseAt !== null) return;
    matchCloseAt = performance.now() + CONFIG.HOST_CLOSE_AFTER_MATCH_MS;
    if (net.mode === "host") matchCloseTimer = window.setTimeout(() => p2pHost?.stop(4411), CONFIG.HOST_CLOSE_AFTER_MATCH_MS);
  } else if (matchCloseAt !== null) {
    matchCloseAt = null;
    clearTimeout(matchCloseTimer);
  }
}

/** 처음 화면으로 돌아간다 (방 가득 참, 자리 만료, 나가기 등) */
function goToJoin(message: string) {
  net.stop();
  stopHosting();
  matchCloseAt = null;
  clearTimeout(matchCloseTimer);
  myId = null;
  room = null;
  for (const a of actors.values()) a.view.dispose(world.scene);
  actors.clear();
  $("reconnecting").classList.add("hidden");
  $("join").classList.remove("hidden");
  showJoinError(message);
  renderScreens();
  keepScreenOn(false);
}

// ---------- 로비 ----------
document.querySelectorAll<HTMLButtonElement>("[data-team]").forEach((b) => {
  b.onclick = () => net.send({ t: "set_team", team: b.dataset.team });
});
$("readyBtn").onclick = () => net.send({ t: "set_ready", ready: !myInfo()?.ready });
$("leaveBtn").onclick = () => {
  net.send({ t: "leave" });
  // 호스트가 나가면 방이 닫힌다 (손님들에게 알림이 간다)
  try { sessionStorage.removeItem(tokenKey()); } catch { /* 무시 */ }
  goToJoin("");
};
const vib = $<HTMLInputElement>("vibrateToggle");
vib.checked = vibrationEnabled();
vib.onchange = () => { setVibration(vib.checked); if (vib.checked) vibrate(CONFIG.VIBRATE_HIT); };
$("giveUpBtn").onclick = () => goToJoin("");
// 고화질 그래픽 (기본: 컴퓨터 켬, 폰·패드 끔. 기기에 저장)
const gfx = $<HTMLInputElement>("gfxToggle");
gfx.checked = world.light.high;
// 체크 표시가 먼저 그려진 뒤(두 프레임 뒤)에 바꾼다: 셰이더를 만드는 동안 체크박스가 늦게 바뀌어 보이지 않게
gfx.onchange = () => { setHighQuality(gfx.checked); requestAnimationFrame(() => requestAnimationFrame(() => world.light.setQuality(gfx.checked))); };
// 혼자 연습: 빈자리를 더미로 채우기 / 빼기 / 인원이 모자라도 바로 시작
$("addBotsBtn").onclick = () => net.send({ t: "add_bots" });
$("removeBotsBtn").onclick = () => net.send({ t: "remove_bots" });
$("practiceBtn").onclick = () => net.send({ t: "start_practice" });
$("startBtn").onclick = () => net.send({ t: "start_game" });
document.querySelectorAll<HTMLButtonElement>("[data-map]").forEach((b) => {
  b.onclick = () => {
    // 서버 응답을 기다리지 않고 바로 눌린 것처럼 보여 준다 (응답이 오면 renderLobby가 다시 맞춘다)
    document.querySelectorAll("[data-map]").forEach((x) => x.classList.toggle("on", x === b));
    net.send({ t: "set_map", map: b.dataset.map });
  };
});
// 직업 카드: 수치는 CLASSES 한 곳에서 (체력·사거리·속도 막대, 가장 큰 값 기준)
// 직업 아이콘: 선 아이콘 (Figma 터치 버튼과 같은 굵기)
const svgIcon = (d: string) => `<svg class="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const CLASS_ICON: Record<string, string> = {
  KNIGHT: svgIcon('<path d="M14.5 17.5L3 6V3H6L17.5 14.5"/><path d="M13 19L19 13"/><path d="M16 16L20 20"/><path d="M19 21L21 19"/>'),
  ARCHER: svgIcon('<path d="M6 3C14 6 14 18 6 21"/><path d="M6 3V21"/><path d="M6 12H20"/><path d="M17 9L20 12L17 15"/>'),
  JAVELIN: svgIcon('<path d="M4 20L17 7"/><path d="M14 4H20V10"/><path d="M14 4L20 10"/>'),
  GOBLIN: svgIcon('<path d="M5 19L14 10"/><path d="M14 10L19 5L18 9L14 10Z"/><path d="M7 13L11 17"/>'),
};
const CLASS_DESC: Record<string, string> = { KNIGHT: "검과 방패 · 근접 · 빠른 발", ARCHER: "활 · 빠른 화살", JAVELIN: "창 · 느리지만 강한 한 방", GOBLIN: "단검 · 앉으면 은신 10초(쿨 15초) · 등 뒤 1.5배" };
document.querySelectorAll<HTMLButtonElement>("[data-cls]").forEach((b) => {
  const c = CLASSES[b.dataset.cls as keyof typeof CLASSES];
  const all = Object.values(CLASSES);
  const bar = (name: string, v: number, max: number, color: string) =>
    `<span>${name}</span><div class="stat" style="color:${color}"><i style="width:${Math.round((v / max) * 100)}%"></i></div>`;
  b.innerHTML = `${CLASS_ICON[b.dataset.cls!]} ${c.name}<small>${CLASS_DESC[b.dataset.cls!]} · 한 방 ${c.damage}</small><div class="stats">` +
    bar("체력", c.maxHp, Math.max(...all.map((x) => x.maxHp)), "#4ade80") +
    bar("사거리", c.range, Math.max(...all.map((x) => x.range)), "#60a5fa") +
    bar("속도", c.speed, Math.max(...all.map((x) => x.speed)), "#fbbf24") + "</div>";
  b.onclick = () => {
    document.querySelectorAll("[data-cls]").forEach((x) => x.classList.toggle("on", x === b)); // 바로 표시
    net.send({ t: "set_class", cls: b.dataset.cls });
  };
});
$("rematchBtn").onclick = () => net.send({ t: "rematch" });

// 점수판 열기/닫기 (버튼 / Tab 키)
let scoreboardOpen = false;
function toggleScoreboard(open = !scoreboardOpen) {
  scoreboardOpen = open && inGame();
  $("scoreboard").classList.toggle("hidden", !scoreboardOpen);
  if (scoreboardOpen) renderScoreboard();
}
$("scoreBtn").onclick = () => toggleScoreboard();
$("scoreClose").onclick = () => toggleScoreboard(false);
$("matchScoreBtn").onclick = () => toggleScoreboard();
input.onToggleScoreboard = () => toggleScoreboard();

// 전체 화면 (지원 기기만)
if (fullscreenSupported()) $("fullscreenBtn").onclick = () => toggleFullscreen();

// 개발 모드: 강제 단계 전환 등 (서버 DEBUG_COMMANDS=true 필요)
if (import.meta.env.DEV && !OFFLINE) {
  const dbg = $("debug");
  dbg.classList.remove("hidden");
  const add = (text: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "secondary";
    b.textContent = text;
    b.onclick = fn;
    dbg.appendChild(b);
  };
  for (const ph of ["LOBBY", "COUNTDOWN", "PLAY", "MATCH_END"]) add(ph, () => net.send({ t: "debug_phase", phase: ph }));
  add("14:3", () => net.send({ t: "debug_score", A: 14, B: 3 }));
}

// ---------- 네트워크 ----------
net.onOpen = () => {
  let token: string | undefined;
  try { token = sessionStorage.getItem(tokenKey()) ?? undefined; } catch { /* 무시 */ }
  net.send({ t: "join", nickname: nickInput.value, token });
};
net.onClose = (code, willRetry, delay) => {
  if (code === 4410) { goToJoin("호스트가 방을 닫았어요."); return; }
  if (code === 4411) { goToJoin("경기가 끝나서 방이 닫혔어요. 다시 하려면 방을 새로 만들어 주세요."); return; }
  if (!myId && code === 4408) {
    showJoinError("호스트 기기와 직접 연결하지 못했어요. 같은 와이파이에 연결해 보거나, 다른 사람이 방을 만들어 보세요.");
    return;
  }
  if (myId && willRetry) {
    $("reconnecting").classList.remove("hidden");
    $("reconnectInfo").textContent = `${Math.round(delay / 1000)}초 후 다시 시도해요`;
  } else if (!myId) {
    showJoinError(code === 1006 ? "서버에 연결할 수 없어요. 방 코드와 인터넷 연결을 확인해 주세요." : `연결이 끊겼어요 (${code})`);
  }
};
net.onMessage = (m) => {
  switch (m.t) {
    case "welcome":
      myId = m.playerId;
      // 기기 직접 연결이면 연결 종류를, Cloudflare면 "들어온 위치→방 서버 위치"를 보여 준다
      route = net.label || (m.edge && m.roomColo ? `${m.edge}→${m.roomColo}` : "");
      try { sessionStorage.setItem(tokenKey(), m.token); } catch { /* 무시 */ }
      net.autoReconnect = true; // 이제부터 끊기면 자동 재접속
      lastSentA = -2; // 접속 직후 현재 입력을 다시 보낸다
      $("join").classList.add("hidden");
      $("reconnecting").classList.add("hidden");
      if (m.resumed) toast("다시 연결됐어요");
      break;
    case "room_state":
      applyRoomState(m as RoomStateMessage);
      break;
    case "move":
      onMove(m.id, m.body, m.s);
      break;
    case "swing":
      onSwing(m.by, m.target, m.damage);
      break;
    case "shot":
      onShot(m as Extract<ServerMessage, { t: "shot" }>);
      break;
    case "notice":
      toast(m.message);
      break;
    case "error":
      onServerError(m.code, m.message);
      break;
  }
};

function onServerError(code: string, message: string) {
  if (!myId) {
    // 입장 실패 (방 가득 참, 게임 진행 중 등)
    net.stop();
    showJoinError(message);
    return;
  }
  switch (code) {
    case "replaced":
      goToJoin("다른 화면에서 같은 자리로 접속해서 이 화면은 연결을 끊었어요");
      break;
    case "room_full":
    case "game_in_progress":
      // 재접속했는데 자리가 이미 없어짐 (30초 초과)
      try { sessionStorage.removeItem(tokenKey()); } catch { /* 무시 */ }
      goToJoin(`재접속 시간이 지나 자리가 없어졌어요. ${message}`);
      break;
    case "rate_limited":
      break;
    case "cannot_attack":
      if (!message.includes("쿨다운")) toast(message);
      break;
    default:
      toast(message);
  }
}

/** 처치 알림: "누가 → 누구" (죽은 순간만) */
function announceStates(prev: RoomStateMessage, next: RoomStateMessage) {
  const name = (id?: string) => {
    const p = next.players.find((x) => x.id === id);
    return p ? (p.id === myId ? "나" : p.nickname) : "?";
  };
  for (const p of next.players) {
    const before = prev.players.find((x) => x.id === p.id)?.combat.state;
    if (before === "NORMAL" && p.combat.state === "DEAD") feed($("feed"), `${name(lastHitBy.get(p.id))} → ${name(p.id)}`, "dead");
  }
}

let prevPhase: Phase | null = null;
/** 상대 진영 쪽(A팀 = 동쪽, B팀 = 서쪽)으로 카메라를 돌린다 */
const faceEnemySide = (team: TeamId) => { world.yaw = team === "A" ? 0 : Math.PI; world.pitch = CONFIG.CAMERA_PITCH_DEFAULT; };
function applyRoomState(s: RoomStateMessage) {
  const prevMe = myInfo();
  if (room) announceStates(room, s);
  // 단계가 바뀌었거나 내 상태(사망 등)가 바뀌었으면 서버 위치를 꼭 따른다
  const forceMe = !room || s.phase !== room.phase;
  const myTeam = s.players.find((p) => p.id === myId)?.team;
  // 경기 시작 전(로비·준비)에 상대 진영 쪽을 보게
  if (myTeam && (s.phase === "COUNTDOWN" || s.phase === "LOBBY") && (room?.phase !== s.phase || !room)) faceEnemySide(myTeam);
  room = s;

  // 사라진 플레이어 정리
  for (const [id, a] of actors) {
    if (!s.players.some((p) => p.id === id)) { a.view.dispose(world.scene); actors.delete(id); }
  }
  for (const p of s.players) {
    let a = actors.get(p.id);
    if (!a || a.team !== p.team) {
      a?.view.dispose(world.scene);
      a = { id: p.id, view: new PlayerView(world.scene, p.team, p.nickname, p.id === myId), team: p.team, body: p.body, off: { x: 0, y: 0, z: 0 }, face: 0, info: p, serverT: p.body.t };
      actors.set(p.id, a);
    }
    a.info = p;
    a.view.setWeapon(p.cls);
    a.view.setNickname(p.id === myId ? `${p.nickname} (나)` : `${p.bot ? "[봇] " : ""}${p.nickname}`);
    if (p.id !== myId) {
      if (p.body.t >= a.serverT) { a.serverT = p.body.t; reconcile(a, p.body, false); }
    }
    else if (forceMe || p.seq >= lastSentSeq || p.combat.state !== prevMe?.combat.state) reconcile(a, p.body, true);
    // (아직 서버에 안 간 내 입력이 있으면 덮어쓰지 않는다 — 곧 오는 move 응답으로 맞춘다)
  }

  // 진동: 내가 맞았을 때 / 죽었을 때. 부활하면 상대 진영 쪽을 보게
  const now = myInfo();
  if (prevMe && now && s.phase === "PLAY") {
    if (now.combat.state === "DEAD" && prevMe.combat.state === "NORMAL") vibrate(CONFIG.VIBRATE_DOWN);
    else if (now.combat.hp < prevMe.combat.hp) vibrate(CONFIG.VIBRATE_HIT);
    if (now.combat.state === "NORMAL" && prevMe.combat.state === "DEAD") faceEnemySide(now.team);
  }
  if (s.phase !== prevPhase) {
    keepScreenOn(s.phase !== "LOBBY" && s.phase !== "MATCH_END");
    if (s.phase === "MATCH_END" || s.phase === "LOBBY") toggleScoreboard(false);
    prevPhase = s.phase;
  }
  world.setMap(s.map ?? "CLASSIC");
  updateMatchClose(s);
  renderLobby();
  renderScreens();
  renderEndScreens();
  if (scoreboardOpen) renderScoreboard();
}

function onMove(id: string, body: Body, s: number) {
  const a = actors.get(id);
  if (!a) return;
  if (id !== myId) {
    if (body.t < a.serverT) return; // 순서가 뒤바뀌어 늦게 온 옛 위치
    a.serverT = body.t;
  }
  if (id === myId) {
    // 내 입력이 서버에서 처리되어 돌아온 시간 = 왕복 시간 표본
    const t0 = sentAt.get(s);
    if (t0 !== undefined) net.addRttSample(performance.now() - t0);
    for (const k of sentAt.keys()) if (k <= s) sentAt.delete(k);
  }
  if (id === myId && s < lastSentSeq) return; // 더 새 입력이 아직 서버로 가는 중이면 보정하지 않는다
  reconcile(a, body, id === myId);
}

/** 궁수가 쐈다: 활 당기는 동작 + 화살 그리기 (맞았는지는 나중에 swing으로 온다) */
function onShot(m: Extract<ServerMessage, { t: "shot" }>) {
  const t = performance.now();
  if (m.by !== myId) actors.get(m.by)?.view.swing(t);
  else if (attackSentAt) { net.addRttSample(t - attackSentAt); attackSentAt = 0; }
  world.addArrow(m.by, m.origin, m.dir, m.at, m.speed, m.range, actors.get(m.by)?.info.cls === "JAVELIN");
}

/** 마지막으로 그 사람을 때린 사람 (처치 알림용) */
const lastHitBy = new Map<string, string>();

function onSwing(by: string, target: string | null, damage: number) {
  const t = performance.now();
  if (target) {
    lastHitBy.set(target, by);
    const victim = actors.get(target);
    if (victim) damageNumber(victim.view.label, damage); // 서버가 계산한 값 (고블린 뒤치기는 1.5배)
    if (by === myId) hitMarker($("crosshair"));
    const m = me(), atk = actors.get(by);
    if (target === myId && m && atk) {
      const rel = Math.atan2(atk.body.y - m.body.y, atk.body.x - m.body.x) - world.yaw;
      damageDirection($("dmgLayer"), Math.atan2(Math.sin(rel), Math.cos(rel)));
    }
  }
  if (classOf(actors.get(by)?.info).ranged) {
    // 화살이 맞음: 화살을 지우고 맞은 사람만 번쩍
    world.removeArrow(by);
    if (target) actors.get(target)?.view.flash(t);
    return;
  }
  if (by !== myId) actors.get(by)?.view.swing(t); // 내 동작은 누르는 순간 이미 보여줬다
  else if (attackSentAt) { net.addRttSample(t - attackSentAt); attackSentAt = 0; }
  // 내가 때린 건 이미 번쩍였으면 다시 하지 않는다
  if (target && !(by === myId && target === predictedHit)) actors.get(target)?.view.flash(t);
  if (by === myId) predictedHit = null;
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

/** 내 캐릭터가 지금 실제로 움직일 수 있는 방향 (불가능하면 -1) */
function effectiveAngle(): number {
  return canWalk() && myNormal() ? desiredAngle() : -1;
}

/** 서버 상태를 받아 현재 시각까지 진행하고, 화면 위치가 튀지 않게 오차를 off에 넣는다 */
function reconcile(a: Actor, body: Body, isMe: boolean) {
  const now = net.serverNow();
  let nb = simulate(body, now);
  if (isMe) {
    const effA = effectiveAngle();
    if (nb.a !== effA) nb = withAngle(nb, effA, now); // 아직 서버에 안 간 내 입력은 바로 반영
  }
  const ox = a.body.x + a.off.x - nb.x;
  const oy = a.body.y + a.off.y - nb.y;
  const oz = a.body.z + a.off.z - nb.z;
  if (Math.hypot(ox, oy, oz) > CONFIG.SNAP_DISTANCE) a.off = { x: 0, y: 0, z: 0 };
  else a.off = { x: ox, y: oy, z: oz };
  a.body = nb;
}

/** 하던 것을 모두 멈춘다 (앱이 백그라운드로 갈 때) */
function stopEverything() {
  input.reset();
  if (lastSentA !== -1 && myId) { net.send({ t: "move", a: -1, s: ++seq }); lastSentSeq = seq; lastSentA = -1; }
}

// ---------- 앱이 백그라운드로 가면 즉시 정지, 돌아오면 재접속 ----------
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopEverything();
    keepScreenOn(false);
  } else {
    if (myId && !OFFLINE) net.reconnectNow();
    keepScreenOn(inGame() && room?.phase !== "MATCH_END");
  }
});
window.addEventListener("pagehide", stopEverything);

// ---------- 화면 ----------
function renderLobby() {
  if (!room) return;
  $("lobbyRoom").textContent = room.room;
  for (const t of ["A", "B"] as TeamId[]) {
    const box = $(`team${t}`);
    box.replaceChildren(...room.players.filter((p) => p.team === t).map((p) => {
      const d = document.createElement("div");
      // 이름 + 작은 글자 태그 (방장 / 봇 / 준비 / 재접속)
      const tags = [p.owner && "방장", p.bot && "봇", p.ready && "준비", p.conn === "RECONNECTING" && "재접속 중"].filter(Boolean) as string[];
      d.innerHTML = `<span class="pn"></span>${tags.map((t) => `<i class="tag${t === "준비" ? " ok" : ""}">${t}</i>`).join("")}`;
      (d.firstChild as HTMLElement).textContent = p.nickname;
      if (p.id === myId) d.className = "me";
      if (p.ready) d.classList.add("ready");
      return d;
    }));
  }
  // 팀 이동 버튼은 내가 없는 팀에만
  document.querySelectorAll<HTMLButtonElement>("[data-team]").forEach((b) => b.classList.toggle("hidden", b.dataset.team === myInfo()?.team));
  const bots = room.players.filter((p) => p.bot).length;
  $("addBotsBtn").classList.toggle("hidden", room.players.length >= 4);
  $("removeBotsBtn").classList.toggle("hidden", bots === 0);
  // 게임 시작 / 연습 시작 / 맵 선택은 방장만
  const owner = !!myInfo()?.owner;
  const map = room.map ?? "CLASSIC";
  document.querySelectorAll<HTMLButtonElement>("[data-map]").forEach((b) => {
    b.classList.toggle("on", b.dataset.map === map);
    b.disabled = !owner;
  });
  const startBtn = $<HTMLButtonElement>("startBtn");
  startBtn.classList.toggle("hidden", !owner);
  $("practiceBtn").classList.toggle("hidden", !owner);
  startBtn.disabled = !canStartMatch(room.players);
  const n = room.players.length, inA = room.players.filter((p) => p.team === "A").length;
  setText("startHint", !owner ? "방장이 게임을 시작해요"
    : n < 4 ? `4명이 있어야 시작할 수 있어요 (지금 ${n}명)`
    : inA !== 2 ? "2대2로 팀을 나눠 주세요"
    : !startBtn.disabled ? "" : "모두 준비해야 시작할 수 있어요");
  const ready = !!myInfo()?.ready;
  const btn = $("readyBtn");
  btn.textContent = ready ? "준비 취소" : "준비";
  btn.classList.toggle("on", ready);
}

function renderScreens() {
  const game = !!myId && inGame();
  $("lobby").classList.toggle("hidden", !myId || inGame());
  for (const id of ["hud", "scoreBtn", "teamPanelMine"]) $(id).classList.toggle("hidden", !game);
  $("fullscreenBtn").classList.toggle("hidden", !fullscreenSupported() || !myId);
  $("touch").classList.toggle("hidden", !game || room?.phase === "MATCH_END" || room?.phase === "CLASS_SELECT");
  renderClassSelect();
}

/** 직업 선택: 내 선택 강조 + 우리 팀 선택 표시 */
function renderClassSelect() {
  const mine = myInfo();
  const show = !!mine && room?.phase === "CLASS_SELECT";
  $("classSelect").classList.toggle("hidden", !show);
  if (!show) return;
  document.querySelectorAll<HTMLButtonElement>("[data-cls]").forEach((b) => b.classList.toggle("on", b.dataset.cls === mine.cls));
  setText("classTeam", "우리 팀  " + room!.players.filter((p) => p.team === mine.team)
    .map((p) => `${p.id === myId ? "나" : p.nickname} ${CLASSES[p.cls].name}`).join("   "));
}

const PHASE_NAME: Record<Phase, string> = {
  LOBBY: "로비", CLASS_SELECT: "직업 선택", COUNTDOWN: "준비", PLAY: "경기 중", MATCH_END: "경기 종료",
};

function renderHud(now: number) {
  if (!room || !inGame()) return;
  if (OFFLINE) {
    setText("hudRound", "혼자 연습 모드");
    setText("hudTimer", "자유 이동");
    setText("netStatus", "서버 없음 (연습)");
  } else {
    const left = room.phaseEndsAt === null ? 0 : Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000));
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
    setText("hudRound", room.phase === "PLAY" || room.phase === "COUNTDOWN" ? `${room.practice ? "연습 · " : ""}먼저 ${KILL_TARGET}킬` : PHASE_NAME[room.phase]);
    setText("hudTimer", room.phase === "MATCH_END" ? (room.matchWinner ? `${room.matchWinner}팀 승리` : "끝") : room.phase === "PLAY" ? `${mm}:${ss}` : `${left}`);
    if (room.phase === "CLASS_SELECT") setText("classLeft", String(left));
    $("hudTimer").classList.toggle("urgent", movable() && left <= CONFIG.TIMER_URGENT_S);
    const bad = !net.connected || net.unstable || net.rtt > CONFIG.PING_WARN_MS;
    setText("netStatus", net.connected ? `${bad ? "불안정 · " : ""}ping ${Math.round(net.rtt)}ms${route ? " · " + route : ""} · ${Math.round(fps)}fps` : "연결 끊김");
    $("netStatus").classList.toggle("bad", bad);
  }
  // 팀 킬 수
  setText("scoreA", String(room.score.A));
  setText("scoreB", String(room.score.B));
  renderTeamPanels(now);
}

/** 미니맵: 우리 팀 위치·방향만 (상대 위치는 숨김) */
const minimap = new Minimap($<HTMLCanvasElement>("minimap"));
function renderMinimap() {
  const mine = myInfo();
  const show = !!room && !!mine && inGame() && room.phase !== "MATCH_END";
  $("minimap").classList.toggle("hidden", !show);
  if (!show) return;
  const dots = [...actors.values()].filter((a) => a.team === mine!.team).map((a) => ({
    x: a.body.x, y: a.body.y, face: a.id === myId ? world.yaw : a.face, team: a.team, me: a.id === myId,
  }));
  minimap.draw(room!.map ?? "CLASSIC", dots);
}

/** 왼쪽 위 = 우리 팀 체력만 (상대 체력은 보일 때 머리 위에만) */
let panelKey = "";
function renderTeamPanels(now: number) {
  const mine = myInfo();
  if (!room || !mine) return;
  const parts: string[] = [];
  for (const p of room.players) if (p.team === mine.team) parts.push(`${p.id}:${p.combat.hp}:${p.combat.state}:${p.conn}:${statusText(p, now)}`);
  const key = parts.join("|");
  if (key === panelKey) return; // 바뀐 게 없으면 다시 그리지 않는다
  panelKey = key;
  const row = (p: PublicPlayer) => {
    const d = document.createElement("div");
    d.className = "tp" + (p.combat.state !== "NORMAL" ? " down" : "");
    const st = statusText(p, now);
    d.innerHTML = `<div class="nm"><span></span><span class="st"></span></div><div class="hpbar${p.combat.hp <= classOf(p).maxHp * 0.3 ? " low" : ""}"><div style="width:${(p.combat.hp / classOf(p).maxHp) * 100}%"></div></div>`;
    (d.querySelector(".nm span") as HTMLElement).textContent = p.id === myId ? `${p.nickname} (나)` : p.nickname;
    (d.querySelector(".st") as HTMLElement).textContent = st || `${p.combat.hp}`;
    return d;
  };
  $("teamPanelMine").replaceChildren(...room.players.filter((p) => p.team === mine.team).map(row));
}

function statusText(p: PublicPlayer, now: number): string {
  if (p.conn === "RECONNECTING") return "재접속 중";
  if (p.combat.state === "DEAD") return p.combat.respawnAt && movable() ? `부활 ${Math.max(0, Math.ceil((p.combat.respawnAt - now) / 1000))}초` : "사망";
  if (now < (p.combat.stealthUntil ?? 0)) return `은신 ${Math.ceil((p.combat.stealthUntil! - now) / 1000)}초`;
  if (p.id === myId && now < (p.combat.stealthReadyAt ?? 0)) return `은신 대기 ${Math.ceil((p.combat.stealthReadyAt! - now) / 1000)}초`;
  return "";
}

function renderScoreboard() {
  if (!room) return;
  const now = net.serverNow();
  const rows = [...room.players].sort((a, b) => a.team.localeCompare(b.team) || b.combat.kills - a.combat.kills).map((p) => {
    const tr = document.createElement("tr");
    tr.className = p.team + (p.id === myId ? " me" : "");
    const cells = [`${p.team}팀`, p.id === myId ? `${p.nickname} (나)` : p.nickname, String(p.combat.kills), String(p.combat.deaths), statusText(p, now) || "생존"];
    for (const c of cells) { const td = document.createElement("td"); td.textContent = c; tr.appendChild(td); }
    return tr;
  });
  $("scoreboardBody").replaceChildren(...rows);
}

/** 경기 종료 화면 */
function renderEndScreens() {
  const mine = myInfo();
  const end = $("matchEnd");
  if (room?.phase === "MATCH_END" && mine) {
    end.classList.remove("hidden");
    const r = room.matchEndReason;
    if (r === "player_left") {
      setText("matchTitle", "경기 종료");
      setText("matchSub", "플레이어가 나가서 경기가 끝났어요. 다시 하기를 누르면 로비로 돌아가요.");
    } else {
      const w = room.matchWinner;
      setText("matchTitle", !w ? "무승부" : w === mine.team ? "승리" : "패배");
      setText("matchSub", r === "score" ? `${w}팀이 먼저 ${KILL_TARGET}킬` : "10분이 끝났어요");
    }
    setText("matchScore", `A ${room.score.A} : ${room.score.B} B`);
  } else end.classList.add("hidden");
}

/** 오른쪽 아래 버튼: 타격 쿨다운 */
function renderButtons(now: number) {
  const mine = myInfo();
  if (!mine) return;
  $("touch").classList.toggle("spectate", inGame() && mine.combat.state !== "NORMAL");
  const cooldown = classOf(mine).cooldownMs;
  const readyAt = Math.max(mine.combat.attackReadyAt, localAttackAt + cooldown);
  const cd = Math.max(0, readyAt - now);
  $("attackBtn").classList.toggle("cooling", cd > 0 || !movable());
  setText("attackLabel", cd > 0 ? (cd / 1000).toFixed(1) : mine.cls === "JAVELIN" ? "던지기" : mine.cls === "GOBLIN" ? "찌르기" : classOf(mine).ranged ? "쏘기" : "타격");
  $("attackCd").style.height = `${(cd / cooldown) * 100}%`;
}

/** 죽었을 때: 부활까지 남은 초 + 누구에게 당했는지 */
function renderDownOverlay(now: number) {
  const mine = myInfo();
  const el = $("downOverlay");
  if (!mine || !movable() || mine.combat.state === "NORMAL") { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const by = actors.get(lastHitBy.get(mine.id) ?? "")?.info.nickname;
  setText("downTitle", "처치당했어요");
  setText("downCount", String(Math.max(0, Math.ceil(((mine.combat.respawnAt ?? now) - now) / 1000))));
  setText("downHint", by ? `${by}에게 · 곧 우리 팀 시작 위치에서 부활해요` : "곧 우리 팀 시작 위치에서 부활해요");
}

function setText(id: string, t: string) { const el = $(id); if (el.textContent !== t) el.textContent = t; }

let toastTimer = 0;
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), CONFIG.TOAST_MS);
}

// ---------- 게임 루프 ----------
const enemyBuf: Actor[] = []; // 조준 판정용 (매 프레임 새 배열을 만들지 않는다)
let lastFrame = performance.now();
/** 화면 그리기 속도 (초당 프레임 수) 측정과 자동 화질 조절 */
let fps = 60;
let fpsCheckAt = performance.now() + 3000;
function frame() {
  requestAnimationFrame(frame);
  const t = performance.now();
  const dt = Math.min(0.1, (t - lastFrame) / 1000);
  if (t > lastFrame) fps += ((1000 / (t - lastFrame)) - fps) * 0.05;
  lastFrame = t;
  // 2초마다: 느리면 해상도를 조금 낮춘다 (고해상도 패드에서 끊김 방지)
  if (t > fpsCheckAt) {
    fpsCheckAt = t + 2000;
    if (fps < CONFIG.FPS_TARGET && world.pixelRatio > CONFIG.MIN_DPR && !document.hidden) {
      world.setPixelRatio(Math.max(CONFIG.MIN_DPR, world.pixelRatio - CONFIG.DPR_STEP));
    }
  }
  const now = net.serverNow();
  const m = me();

  input.enabled = !!m && inGame() && myNormal();
  input.update(dt);
  const cam = input.consumeCamera();
  world.yaw += cam.yaw;
  world.pitch += cam.pitch;

  if (m && (net.connected || OFFLINE)) {
    // 1) 이동 의도 전송: 바뀔 때만, 최소 간격 유지 (서버가 이동 불가 단계에서도 의도를 기억함)
    const want = desiredAngle();
    if (want !== prevWant) { prevWant = want; wantChangedAt = now; }
    if (want !== lastSentA && t - lastMoveSendAt >= CONFIG.MOVE_SEND_INTERVAL_MS) {
      // at = 화면에서 방향을 바꾼 시각. 서버가 같은 시각으로 계산해서 위치가 어긋나지 않는다
      net.send({ t: "move", a: want, s: ++seq, at: wantChangedAt });
      sentAt.set(seq, t);
      lastSentSeq = seq;
      lastSentA = want;
      lastMoveSendAt = t;
    }
    // 2) 내 캐릭터 예측: 입력을 즉시 반영
    const effA = effectiveAngle();
    m.body = simulate(m.body, now);
    if (m.body.a !== effA) m.body = withAngle(m.body, effA, now);
    // 4) 점프 (1회 = 메시지 1개)
    if (input.consumeJump() && canWalk() && myNormal()) {
      const j = withJump(m.body, now);
      if (j) {
        m.body = j;
        net.send({ t: "jump", s: ++seq, at: now });
        sentAt.set(seq, t);
        lastSentSeq = seq;
      }
    }
    // 4-1) 앉기/일어서기 전환 (점프와 같은 방식: 바로 보여 주고 서버에 같은 시각으로)
    if (input.consumeCrouch() && canWalk() && myNormal()) {
      const on = !m.body.k;
      m.body = withCrouch(m.body, on, now);
      net.send({ t: "crouch", on, s: ++seq, at: now });
      sentAt.set(seq, t);
      lastSentSeq = seq;
    }
    $("crouchBtn").classList.toggle("on", !!m.body.k);
    // 5) 타격 (1회 = 메시지 1개). 원거리는 조준점(카메라) 방향, 근접은 캐릭터가 바라보는 방향으로. 판정은 서버가 같은 방향으로 한다
    if (input.consumeAttack()) attackBufferedUntil = now + CONFIG.ATTACK_BUFFER_MS;
    if (now <= attackBufferedUntil) {
      const ranged = classOf(m.info).ranged;
      const readyAt = Math.max(m.info.combat.attackReadyAt, localAttackAt + classOf(m.info).cooldownMs);
      if (movable() && myNormal() && now >= readyAt) {
        const yaw = ranged ? world.yaw : m.face;
        net.send({ t: "attack", yaw, pitch: world.pitch });
        // 서버 판정을 기다리지 않고, 맞을 상대를 바로 번쩍이게 한다 (체력은 서버 결과로 바뀜)
        const predicted = ranged ? null : findAimTarget(m.body, yaw, world.pitch, enemyBuf); // 화살은 날아간 뒤 판정
        if (predicted) { predicted.view.flash(t); predictedHit = predicted.id; }
        attackSentAt = t;
        localAttackAt = now;
        attackBufferedUntil = -Infinity;
        m.view.swing(t);
      }
    }
  } else {
    input.consumeJump();
    input.consumeCrouch();
    input.consumeAttack();
  }

  // 6) 모든 캐릭터 진행 + 보정 오차 줄이기 + 그리기
  const decay = Math.exp((-dt * 1000) / CONFIG.CORRECTION_SMOOTH_MS);
  const w = window.innerWidth, h = window.innerHeight;
  const watch = m;
  enemyBuf.length = 0;
  for (const [id, a] of actors) {
    if (id !== myId) a.body = simulate(a.body, now);
    a.off.x *= decay; a.off.y *= decay; a.off.z *= decay;
    if (a.body.a >= 0) { // 이동 방향으로 부드럽게 돌기 (한 번에 확 꺾이지 않게, 가까운 쪽으로)
      const d = angleToRad(a.body.a) - a.face;
      a.face += Math.atan2(Math.sin(d), Math.cos(d)) * (1 - Math.exp(-dt * CONFIG.TURN_SPEED));
    }
    const x = a.body.x + a.off.x, y = a.body.y + a.off.y, z = Math.max(0, a.body.z + a.off.z);
    const c = a.info.combat;
    const state = c.state === "NORMAL" ? 0 : 2;
    // 은신: 상대 눈에는 안 보이고, 우리 팀(나 포함)에게는 반투명
    // shortcut: 숨기기는 화면에서만 (위치는 상대에게도 전송됨), 조작한 클라이언트를 막아야 하면 서버가 위치 전송을 거른다
    const stealth = state === 0 && now < (c.stealthUntil ?? 0);
    const enemy = !!m && a.team !== m.team;
    a.view.hidden = stealth && enemy;
    // 상대 이름표·체력은 엄폐물에 가리지 않고 보일 때만
    a.view.labelHidden = enemy && !world.canSee(x, y, z + 1.4);
    a.view.update(x, y, z, a.face, groundHeightAt(x, y, z), state, now < c.invulnUntil, a.info.conn === "RECONNECTING" || stealth, t, !!a.body.k);
    a.view.setStatus(c.hp / classOf(a.info).maxHp, inGame() ? statusText(a.info, now) : "");
    if (a === watch) {
      world.ranged = classOf(a.info).ranged;
      a.view.nearCamera = world.updateCamera(x, y, z, dt) < CONFIG.CAMERA_FADE_RATIO;
    }
    else a.view.nearCamera = false;
    if (m && a.team !== m.team && c.state === "NORMAL" && now >= c.invulnUntil && !stealth) enemyBuf.push(a);
  }
  if (!watch) world.updateCamera(24, 14 - 8, 0); // 입장 전: 맵 가운데를 비춤
  world.updateArrows(now);
  world.render();
  for (const a of actors.values()) a.view.placeLabel(world.camera, w, h);

  // 조준점: 맞힐 수 있는 상대를 가리키면 빨갛게
  const ch = $("crosshair");
  const showCh = !!m && movable() && myNormal();
  ch.classList.toggle("hidden", !showCh);
  if (showCh) ch.classList.toggle("target", !classOf(m!.info).ranged && !!findAimTarget(m!.body, m!.face, world.pitch, enemyBuf)); // 근접: 바라보는 쪽에 맞을 상대가 있으면 빨갛게

  renderHud(now);
  renderMinimap();
  renderButtons(now);
  // 경기 후 방이 닫히기까지 남은 시간
  const note = $("matchCloseNote");
  if (matchCloseAt !== null && room?.phase === "MATCH_END") {
    const left = Math.max(0, Math.ceil((matchCloseAt - t) / 1000));
    setText("matchCloseNote", `⏱ 방이 ${left}초 뒤에 닫혀요. 다시 하기를 누르면 이 방에서 계속해요.`);
    note.classList.remove("hidden");
  } else note.classList.add("hidden");
  renderDownOverlay(now);
}
world.yaw = Math.PI / 2; // 입장 전 카메라는 북쪽을 바라봄

// 혼자 연습 모드: 입장 화면 없이 A팀 시작 위치에서 바로 움직일 수 있는 상태로 시작
if (OFFLINE) {
  myId = "me";
  world.yaw = 0; // 동쪽(상대 진영)을 바라보며 시작
  $("join").classList.add("hidden");
  const sp = SPAWNS.A[0]!;
  const t0 = net.serverNow();
  applyRoomState({
    t: "room_state", room: "연습", phase: "PLAY", phaseEndsAt: null,
    map: "CLASSIC", score: { A: 0, B: 0 }, matchWinner: null, matchEndReason: null, practice: true,
    serverTime: t0,
    players: [{
      id: "me", nickname: "연습", team: "A", conn: "CONNECTED", reconnectDeadline: null, ready: true,
      body: makeBody(sp.x, sp.y, t0), seq: 0,
      combat: { hp: CLASSES.KNIGHT.maxHp, state: "NORMAL", respawnAt: null, invulnUntil: 0, kills: 0, deaths: 0, attackReadyAt: 0 },
      bot: false, cls: "KNIGHT", owner: true,
    }],
  });
}
requestAnimationFrame(frame);

// 개발 모드에서만: 자동 테스트/디버깅용으로 상태 노출
if (import.meta.env.DEV) (window as any).__game = { actors, world, net, get myId() { return myId; }, get room() { return room; } };
