// 게임 진입점: 입장 → 로비 → 게임 화면 (이동/점프/타격/집 작업/치유/관전) → 라운드/경기 종료
import { type Body, angleToRad, groundHeightAt, makeBody, radToAngle, simulate, withAngle, withJump } from "../../shared/sim";
import { HOUSES, MAPS, PHYS, SITES, SPAWNS, type SiteId, type TeamId, isNearHouse, isNearSite } from "../../shared/world";
import { Minimap } from "./minimap";
import { AIM, findAimTarget, inReach } from "../../shared/aim";
// 서버와 같은 메시지 형식/규칙 수치를 그대로 쓴다 (타입은 빌드 때 지워진다)
import type { Phase, PublicPlayer, RoomStateMessage, RoundEndReason, ServerMessage, WorkInfo } from "../../server/src/protocol";
import { BREAK_TIME_MS, REPAIR_TIME_MS, REVIVE_TIME_MS } from "../../server/src/constants";
import { canStartMatch } from "../../server/src/phase";
import { CLASSES } from "../../shared/classes";
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
const other = (t: TeamId): TeamId => (t === "A" ? "B" : "A");

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
const input = new Input($("touch"), $("stickBase"), $("stickKnob"), { jump: $("jumpBtn"), attack: $("attackBtn"), action: $("actionBtn") });
const net = new Net(SERVER_URL);

let myId: string | null = null;
/** "내 기기로 방 만들기"를 했을 때: 이 기기 안의 방 서버와 연결 중계 */
let p2pHost: P2PHost | null = null;
/** 내 기기로 연 방(또는 그 방의 손님): 경기가 끝난 뒤 방이 닫히는 시각 (performance.now 기준) */
let matchCloseAt: number | null = null;
let matchCloseTimer = 0;
let roomCode = "";
let room: RoomStateMessage | null = null;
let work: WorkInfo | null = null;
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
let activeAction: "hold" | "revive" | null = null;
/** 행동 버튼을 누른 서버 시각 (서버 확인 전까지 진행률을 미리 채우는 데 사용) */
let actionPressedAt = 0;
/** 서버가 거절했으면 손을 뗄 때까지 다시 시도하지 않는다 */
let actionLatched = false;
/** 이번에 누른 행동을 서버가 한 번이라도 확인했는지 (확인 뒤에는 서버 값만 쓴다) */
let actionAcked = false;

/** 서버 확인 전 잠깐 동안만 미리 채운다 */
function predicting(now: number): boolean {
  return !actionAcked && myNormal() && movable() && now - actionPressedAt < CONFIG.ACTION_PREDICT_MS;
}
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
const movable = () => room?.phase === "ATTACK" || room?.phase === "REPAIR";
/** 걸을 수 있는지: 전투 단계 + NEON 준비 시간(결계 안에서 이동) */
const canWalk = () => movable() || (room?.phase === "COUNTDOWN" && room.map === "NEON");
const SITE_IDS: SiteId[] = ["A", "B"];
const me = () => (myId ? actors.get(myId) : undefined);
const myInfo = () => me()?.info;
const myNormal = () => myInfo()?.combat.state === "NORMAL";
/** 작업 중이거나 치유 중인지 (서버 상태 + 방금 누른 것) */
const myBusy = () => activeAction !== null || !!(myId && work?.holders.includes(myId)) || !!myInfo()?.combat.revive;
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
$("randomRoom").onclick = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  roomInput.value = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};
/** 입력한 방 코드 확인 (없으면 새로 만든다) */
function readRoomCode(makeIfEmpty: boolean): string | null {
  if (makeIfEmpty && !roomInput.value.trim()) ($("randomRoom") as HTMLButtonElement).click();
  const code = roomInput.value.trim().toUpperCase();
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
  work = null;
  activeAction = null;
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
// 혼자 연습: 빈자리를 더미로 채우기 / 빼기 / 인원이 모자라도 바로 시작
$("addBotsBtn").onclick = () => net.send({ t: "add_bots" });
$("removeBotsBtn").onclick = () => net.send({ t: "remove_bots" });
$("practiceBtn").onclick = () => net.send({ t: "start_practice" });
$("startBtn").onclick = () => net.send({ t: "start_game" });
document.querySelectorAll<HTMLButtonElement>("[data-map]").forEach((b) => {
  b.onclick = () => net.send({ t: "set_map", map: b.dataset.map });
});
document.querySelectorAll<HTMLButtonElement>("[data-cls]").forEach((b) => {
  b.onclick = () => net.send({ t: "set_class", cls: b.dataset.cls });
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
  for (const ph of ["LOBBY", "COUNTDOWN", "ATTACK", "REPAIR", "ROUND_END"]) add(ph, () => net.send({ t: "debug_phase", phase: ph }));
  add("집 앞", () => {
    if (!room) return;
    if (room.map === "NEON") { const b = SITES.A; net.send({ t: "debug_teleport", x: b.x0 - 0.9, y: (b.y0 + b.y1) / 2 }); return; }
    const h = HOUSES[other(room.attackingTeam)];
    const side = h.x < PHYS.MAP_X / 2 ? 1 : -1; // 집의 맵 가운데 쪽 벽 앞
    net.send({ t: "debug_teleport", x: h.x + side * (h.size / 2 + 0.6), y: h.y });
  });
  add("5:4", () => net.send({ t: "debug_score", A: 5, B: 4 }));
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
      activeAction = null;
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
    case "work":
      work = m.work;
      if (room) room.sites = m.sites;
      break;
    case "swing":
      onSwing(m.by, m.target);
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
    case "cannot_work":
    case "cannot_revive":
      // 미리 보여 주던 진행률을 되돌리고, 손을 뗄 때까지 다시 시도하지 않는다
      activeAction = null;
      actionLatched = true;
      toast(message);
      break;
    default:
      toast(message);
  }
}

let prevPhase: Phase | null = null;
let lastRoundKey = "";
function applyRoomState(s: RoomStateMessage) {
  const prevMe = myInfo();
  // 단계/라운드가 바뀌었거나 내 상태(기절 등)가 바뀌었으면 서버 위치를 꼭 따른다
  const forceMe = !room || s.phase !== room.phase || s.round !== room.round;
  room = s;
  work = s.work;
  const myTeam = s.players.find((p) => p.id === myId)?.team;
  // 라운드 시작(준비 단계) 때 카메라를 상대 진영 쪽으로 돌린다
  const roundKey = `${s.round}:${myTeam}:${s.phase === "COUNTDOWN" || s.phase === "LOBBY"}`;
  if (myTeam && (s.phase === "COUNTDOWN" || s.phase === "LOBBY") && roundKey !== lastRoundKey) {
    // NEON은 역할 기준 (공격 스폰 = 서쪽 → 동쪽을 봄, 수비 스폰 = 동쪽 → 서쪽을 봄)
    world.yaw = s.map === "NEON" ? (myTeam === s.attackingTeam ? 0 : Math.PI) : myTeam === "A" ? 0 : Math.PI;
    world.pitch = CONFIG.CAMERA_PITCH_DEFAULT;
  }
  lastRoundKey = roundKey;

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
    a.view.setNickname(p.id === myId ? `${p.nickname} (나)` : `${p.bot ? "🤖 " : ""}${p.nickname}`);
    if (p.id !== myId) {
      if (p.body.t >= a.serverT) { a.serverT = p.body.t; reconcile(a, p.body, false); }
    }
    else if (forceMe || p.seq >= lastSentSeq || p.combat.state !== prevMe?.combat.state) reconcile(a, p.body, true);
    // (아직 서버에 안 간 내 입력이 있으면 덮어쓰지 않는다 — 곧 오는 move 응답으로 맞춘다)
  }

  // 진동: 내가 맞았을 때 / 기절했을 때
  const now = myInfo();
  if (prevMe && now && s.phase !== "COUNTDOWN") {
    if (now.combat.state === "DOWNED" && prevMe.combat.state === "NORMAL") vibrate(CONFIG.VIBRATE_DOWN);
    else if (now.combat.hp < prevMe.combat.hp) vibrate(CONFIG.VIBRATE_HIT);
  }
  // 내 작업/치유가 서버에서 끝났으면(기절, 단계 종료 등) 표시만 정리. 버튼을 뗄 때 stop은 그대로 보낸다
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
  world.addArrow(m.by, m.origin, m.dir, m.at);
}

function onSwing(by: string, target: string | null) {
  const t = performance.now();
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
  return canWalk() && myNormal() && !myBusy() ? desiredAngle() : -1;
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

// ---------- 행동 버튼: 상황에 따라 치유 > 부수기/수리 ----------
type ActionKind = "revive" | "break" | "repair";
function availableAction(): ActionKind | null {
  const m = me();
  if (!room || !m || !movable() || !myNormal()) return null;
  // 근처에 기절한 팀원이 있으면 치유 우선
  for (const a of actors.values()) {
    if (a.id !== m.id && a.team === m.team && a.info.combat.state === "DOWNED" &&
        inReach(m.body, a.body, AIM.REVIVE_RANGE, AIM.REVIVE_MAX_HEIGHT_DIFF)) return "revive";
  }
  const target = other(room.attackingTeam); // 부수기/수리 대상 = 수비팀 집 (NEON은 A/B 사이트 건물)
  const near = room.map === "NEON"
    ? SITE_IDS.some((s) => isNearSite(s, m.body.x, m.body.y, m.body.z))
    : isNearHouse(target, m.body.x, m.body.y, m.body.z);
  if (!near) return null;
  const attacker = m.team === room.attackingTeam;
  if (room.phase === "ATTACK" && attacker) return "break";
  if (room.phase === "REPAIR" && !attacker) return "repair";
  return null;
}

function handleAction() {
  if (actionLatched) {
    if (!input.actionHeld) actionLatched = false;
    return;
  }
  if (input.actionHeld && activeAction === null) {
    const act = availableAction();
    if (act === "revive") { net.send({ t: "revive_start" }); activeAction = "revive"; }
    else if (act) { net.send({ t: "hold_start" }); activeAction = "hold"; }
    if (act) { actionPressedAt = net.serverNow(); actionAcked = false; }
  } else if (!input.actionHeld && activeAction !== null) {
    net.send({ t: activeAction === "revive" ? "revive_stop" : "hold_stop" });
    activeAction = null;
  }
}

/** 하던 것을 모두 멈춘다 (앱이 백그라운드로 갈 때) */
function stopEverything() {
  input.reset();
  if (activeAction) { net.send({ t: activeAction === "revive" ? "revive_stop" : "hold_stop" }); activeAction = null; }
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
  $("lobbyRoom2").textContent = room.room;
  for (const t of ["A", "B"] as TeamId[]) {
    const box = $(`team${t}`);
    box.replaceChildren(...room.players.filter((p) => p.team === t).map((p) => {
      const d = document.createElement("div");
      d.textContent = `${p.owner ? "👑 " : ""}${p.bot ? "🤖 " : ""}${p.nickname}${p.ready ? " ✔" : ""}${p.conn === "RECONNECTING" ? " (재접속 중)" : ""}`;
      if (p.id === myId) d.className = "me";
      if (p.ready) d.classList.add("ready");
      return d;
    }));
  }
  // 연결 방식 안내
  const notice = $("connNotice");
  if (net.mode === "host") {
    notice.textContent = "📡 이 기기가 방 서버예요. 게임 중에 화면을 끄거나 다른 앱으로 가면 모두 멈춰요. 친구는 방 코드로 입장하면 돼요.";
  } else if (net.mode === "p2p") {
    notice.textContent = `📡 호스트 기기에 연결됨 (${net.label})`;
  } else notice.textContent = "";
  notice.classList.toggle("hidden", !notice.textContent);
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
  setText("mapHint", (owner ? "" : `방장이 고른 맵: ${MAPS[map].name} · `) + (map === "NEON"
    ? "4배 넓은 도시 · 공격팀은 A 또는 B 건물 하나를 부수면 승리, 수비팀은 2분 버티면 승리 · 준비 15초(결계)"
    : "원래 방식 · 상대 팀 집을 부수고, 수리를 막으면 승리"));
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
  for (const id of ["hud", "scoreBtn", "teamPanelMine", "teamPanelEnemy"]) $(id).classList.toggle("hidden", !game);
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
  setText("classTeam", room!.players.filter((p) => p.team === mine.team)
    .map((p) => `${p.id === myId ? "나" : p.nickname}: ${CLASSES[p.cls].name}`).join(" · "));
}

const PHASE_NAME: Record<Phase, string> = {
  LOBBY: "로비", CLASS_SELECT: "직업 선택", COUNTDOWN: "준비", ATTACK: "공격 단계", REPAIR: "수리 단계", ROUND_END: "라운드 종료", MATCH_END: "경기 종료",
};
const REASON_TEXT: Record<RoundEndReason, string> = {
  break_timeout: "시간 안에 집을 부수지 못했어요",
  repair_success: "집 수리 성공",
  repair_fail: "집 수리 실패",
  attackers_wiped: "공격팀 전멸",
  defenders_wiped: "수비팀 전멸",
  site_destroyed: "사이트 건물 파괴",
};

let historyLen = -1;
function renderHud(now: number) {
  if (!room || !inGame()) return;
  const mine = myInfo();
  if (OFFLINE) {
    setText("hudRound", "혼자 연습 모드");
    setText("hudTimer", "자유 이동");
    setText("hudRole", "왼쪽: 이동 · 오른쪽 드래그: 카메라 · 점프 버튼");
    setText("netStatus", "서버 없음 (연습)");
  } else {
    const left = room.phaseEndsAt === null ? 0 : Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000));
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
    const phaseName = room.phase === "COUNTDOWN" && room.map === "NEON" ? "준비 시간" : PHASE_NAME[room.phase];
    setText("hudRound", `${room.practice ? "연습 · " : ""}라운드 ${room.round} · ${phaseName}`);
    setText("hudTimer", room.phase === "MATCH_END" ? `${room.matchWinner ?? "-"}${room.matchWinner ? "팀 승리" : ""}` : room.phase === "COUNTDOWN" || room.phase === "ROUND_END" || room.phase === "CLASS_SELECT" ? `${left}` : `${mm}:${ss}`);
    if (room.phase === "CLASS_SELECT") setText("classLeft", String(left));
    $("hudTimer").classList.toggle("urgent", movable() && left <= CONFIG.TIMER_URGENT_S);
    if (room.phase === "MATCH_END") setText("hudRole", "");
    else if (mine) {
      const atk = mine.team === room.attackingTeam;
      const enemy = other(mine.team);
      const prep = room.phase === "COUNTDOWN";
      if (room.map === "NEON") {
        setText("hudRole", `${room.attackingTeam}팀 공격 · ${other(room.attackingTeam)}팀 수비 — ` + (atk
          ? (prep ? "⚔ 결계가 풀리면 A 또는 B 건물을 부수세요" : "⚔ A 또는 B 건물 하나를 부수면 승리")
          : (prep ? "🛡 준비 시간: A/B 사이트로 가서 자리를 잡으세요" : "🛡 시간이 끝날 때까지 A·B 건물을 지키세요")));
      } else setText("hudRole", atk ? `⚔ 공격팀 — ${enemy}팀 집을 부수세요` : `🛡 수비팀 — ${mine.team}팀 집을 지키세요`);
    }
    const bad = !net.connected || net.unstable || net.rtt > CONFIG.PING_WARN_MS;
    setText("netStatus", net.connected ? `${bad ? "⚠ 불안정 · " : ""}ping ${Math.round(net.rtt)}ms${route ? " · " + route : ""} · ${Math.round(fps)}fps` : "⚠ 연결 끊김");
    $("netStatus").classList.toggle("bad", bad);
  }
  // 점수, 매치포인트, 듀스, 라운드 기록
  setText("scoreA", String(room.score.A));
  setText("scoreB", String(room.score.B));
  $("mpA").classList.toggle("hidden", !room.matchPoint.includes("A"));
  $("mpB").classList.toggle("hidden", !room.matchPoint.includes("B"));
  $("deuceBadge").classList.toggle("hidden", !room.deuce || room.phase === "MATCH_END");
  if (room.history.length !== historyLen) {
    historyLen = room.history.length;
    $("history").replaceChildren(...room.history.map((h) => {
      const i = document.createElement("i");
      i.className = h.winner;
      i.title = `라운드 ${h.round}: ${h.winner}팀 승 (${REASON_TEXT[h.reason]})`;
      return i;
    }));
  }
  // 집 작업 진행률 (서버가 준 값으로 부드럽게 채움, 체크포인트 표시)
  const wb = $("workBar");
  if (work && work.kind && movable()) {
    const p = workProgress(now);
    wb.classList.remove("hidden");
    wb.classList.toggle("repair", work.kind === "REPAIR");
    setText("workLabel", `${work.kind === "BREAK" ? "집 부수기" : "집 수리"} ${Math.floor(p * 100)}%${work.holders.length ? " · 작업 중" : ""}`);
    $("workFill").style.width = `${p * 100}%`;
    $("workCheckpoint").style.left = `${work.checkpoint * 100}%`;
  } else wb.classList.add("hidden");
  renderSiteBars(now);
  renderTeamPanels(now);
}

/** NEON: A/B 건물 체력 (= 100% - 부수기 진행률, 서버 값으로 부드럽게 계산) */
function renderSiteBars(now: number) {
  const box = $("siteBars");
  const sites = room?.map === "NEON" ? room.sites : null;
  box.classList.toggle("hidden", !sites || room?.phase === "MATCH_END");
  if (!sites) return;
  for (const id of SITE_IDS) {
    const w = sites[id];
    const p = Math.min(1, w.progress + Math.max(0, now - w.since) * w.rate);
    const hp = Math.max(0, Math.round((1 - p) * 100));
    $(`siteFill${id}`).style.width = `${hp}%`;
    setText(`siteHp${id}`, hp === 0 ? "파괴" : `${hp}%`);
    const el = box.querySelector(`.site.${id}`)!;
    el.classList.toggle("hit", w.holders.length > 0);
    el.classList.toggle("dead", hp === 0);
  }
}

/** 미니맵: 우리 팀 위치·방향만 (상대 위치는 숨김) */
const minimap = new Minimap($<HTMLCanvasElement>("minimap"));
function renderMinimap(now: number) {
  const mine = myInfo();
  const show = !!room && !!mine && inGame() && room.phase !== "MATCH_END";
  $("minimap").classList.toggle("hidden", !show);
  if (!show) return;
  const dots = [...actors.values()].filter((a) => a.team === mine!.team).map((a) => ({
    x: a.body.x, y: a.body.y, face: a.id === myId ? world.yaw : a.face, team: a.team, me: a.id === myId,
  }));
  minimap.draw(room!.map ?? "CLASSIC", dots, room!.barrierUntil !== null && now < room!.barrierUntil);
}

/** 왼쪽 위 = 우리 팀, 오른쪽 위 = 상대 팀 체력 */
let panelKey = "";
function renderTeamPanels(now: number) {
  const mine = myInfo();
  if (!room || !mine) return;
  const parts: string[] = [];
  for (const p of room.players) parts.push(`${p.id}:${p.team}:${p.combat.hp}:${p.combat.state}:${p.conn}:${p.combat.deathAt ? Math.ceil((p.combat.deathAt - now) / 1000) : ""}`);
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
  $("teamPanelEnemy").replaceChildren(...room.players.filter((p) => p.team !== mine.team).map(row));
}

function statusText(p: PublicPlayer, now: number): string {
  if (p.conn === "RECONNECTING") return "재접속 중";
  if (p.combat.state === "DEAD") return "사망";
  if (p.combat.state === "DOWNED") {
    // 라운드가 끝나면 사망 타이머도 멈추므로 카운트다운 대신 "기절"만 표시
    if (!movable() || p.combat.deathAt === null) return "기절";
    return `기절 ${Math.max(0, Math.ceil((p.combat.deathAt - now) / 1000))}초`;
  }
  if (p.combat.revive) return "치유 중";
  if (work?.holders.includes(p.id)) return "작업 중";
  return "";
}

function renderScoreboard() {
  if (!room) return;
  const now = net.serverNow();
  const rows = [...room.players].sort((a, b) => a.team.localeCompare(b.team)).map((p) => {
    const tr = document.createElement("tr");
    tr.className = p.team + (p.id === myId ? " me" : "");
    const cells = [`${p.team}팀`, p.id === myId ? `${p.nickname} (나)` : p.nickname, String(p.combat.hp), String(p.combat.downs), String(p.combat.deaths), statusText(p, now) || "정상"];
    for (const c of cells) { const td = document.createElement("td"); td.textContent = c; tr.appendChild(td); }
    return tr;
  });
  $("scoreboardBody").replaceChildren(...rows);
}

/** 라운드 종료 배너, 경기 종료 화면 */
function renderEndScreens() {
  const banner = $("roundBanner");
  const mine = myInfo();
  if (room?.phase === "ROUND_END") {
    banner.classList.remove("hidden", "A", "B");
    if (room.roundEnd && mine) {
      const won = room.roundEnd.winner === mine.team;
      banner.classList.add(room.roundEnd.winner);
      banner.innerHTML = `${won ? "라운드 승리!" : "라운드 패배"}<small></small>`;
      const why = room.roundEnd.site ? `${room.roundEnd.site} 사이트 건물 파괴` : REASON_TEXT[room.roundEnd.reason];
      (banner.querySelector("small") as HTMLElement).textContent = `${room.roundEnd.winner}팀 +1 · ${why} · ${room.score.A} : ${room.score.B}`;
    } else banner.textContent = "라운드 종료";
  } else banner.classList.add("hidden");

  const end = $("matchEnd");
  if (room?.phase === "MATCH_END" && mine) {
    end.classList.remove("hidden");
    if (room.matchEndReason === "player_left") {
      setText("matchTitle", "경기 종료");
      setText("matchSub", "플레이어가 나가서 경기가 끝났어요. 다시 하기를 누르면 로비로 돌아가요.");
    } else {
      const won = room.matchWinner === mine.team;
      setText("matchTitle", won ? `🏆 ${mine.team}팀 승리!` : `${room.matchWinner}팀 승리`);
      setText("matchSub", won ? "축하해요! 다시 하기를 누르면 로비로 돌아가요." : "아쉬워요. 다시 하기를 누르면 로비로 돌아가요.");
    }
    setText("matchScore", `A ${room.score.A} : ${room.score.B} B`);
  } else end.classList.add("hidden");
}

/**
 * 지금 집 작업 진행률 (0~1). 서버 값으로 계산하되, 내가 방금 눌렀는데 아직 서버가 확인하지 않았으면
 * 누른 시각부터 혼자 작업 속도로 미리 채운다 (서버 대답이 오면 서버 값으로 바뀐다).
 */
function workProgress(now: number): number {
  if (!work || !work.kind) return 0;
  const server = Math.min(1, work.progress + Math.max(0, now - work.since) * work.rate);
  const confirmed = !!myId && work.holders.includes(myId);
  if (confirmed) actionAcked = true;
  if (activeAction !== "hold" || confirmed || work.holders.length > 0 || !predicting(now)) return server;
  const ms = work.kind === "BREAK" ? BREAK_TIME_MS : REPAIR_TIME_MS;
  return Math.min(1, work.progress + Math.max(0, now - actionPressedAt) / ms);
}

/** 오른쪽 아래 버튼들 (타격 쿨다운, 행동 라벨/진행률 링) */
const RING = 289; // 2πr (r=46)
function renderButtons(now: number) {
  const mine = myInfo();
  if (!mine) return;
  const touch = $("touch");
  const spectating = inGame() && mine.combat.state !== "NORMAL";
  touch.classList.toggle("spectate", spectating);

  // 타격: 쿨다운 동안 어둡게 + 남은 시간
  const cooldown = classOf(mine).cooldownMs;
  const readyAt = Math.max(mine.combat.attackReadyAt, localAttackAt + cooldown);
  const cd = Math.max(0, readyAt - now);
  $("attackBtn").classList.toggle("cooling", cd > 0 || !movable());
  setText("attackLabel", cd > 0 ? (cd / 1000).toFixed(1) : classOf(mine).ranged ? "쏘기" : "타격");
  $("attackCd").style.height = `${(cd / cooldown) * 100}%`;

  // 행동: 하고 있는 것 > 할 수 있는 것 > 비활성
  const btn = $("actionBtn");
  let label = "행동", cls = "disabled", progress = 0;
  if (activeAction === "revive" || mine.combat.revive) {
    label = "치유 중"; cls = "revive";
    const r = mine.combat.revive;
    // 서버 확인 전에는 누른 시각부터 미리 채운다
    if (r) actionAcked = true;
    progress = r ? 1 - Math.max(0, r.endsAt - now) / REVIVE_TIME_MS
      : predicting(now) ? Math.min(1, Math.max(0, now - actionPressedAt) / REVIVE_TIME_MS) : 0;
  } else if (activeAction === "hold" || (myId && work?.holders.includes(myId))) {
    label = work?.kind === "REPAIR" ? "수리 중" : "부수는 중"; cls = "";
    progress = workProgress(now);
  } else {
    const act = availableAction();
    if (act === "revive") { label = "치유"; cls = "revive"; }
    else if (act === "break") { label = "부수기"; cls = ""; }
    else if (act === "repair") { label = "수리"; cls = ""; }
  }
  setText("actionLabel", label);
  btn.classList.toggle("disabled", cls === "disabled");
  btn.classList.toggle("revive", cls === "revive");
  $("actionRing").style.strokeDashoffset = String(RING * (1 - progress));
}

/** 기절/사망 시 큰 카운트다운과 관전 안내 */
function renderDownOverlay(now: number, watching: Actor | undefined) {
  const mine = myInfo();
  const el = $("downOverlay");
  if (!mine || !movable() || mine.combat.state === "NORMAL") { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const who = watching && watching.id !== myId ? `관전 중: ${watching.info.nickname}` : "";
  if (mine.combat.state === "DOWNED") {
    setText("downTitle", "기절!");
    setText("downCount", String(Math.max(0, Math.ceil(((mine.combat.deathAt ?? now) - now) / 1000))));
    setText("downHint", `팀원이 3초 동안 치유해 주면 살아나요 ${who ? "· " + who : ""}`);
  } else {
    setText("downTitle", "사망");
    setText("downCount", "");
    setText("downHint", `이번 라운드가 끝날 때까지 기다려요 ${who ? "· " + who : ""}`);
  }
}

/** 기절/사망하면 살아있는 팀원 시점으로 */
function spectateTarget(): Actor | undefined {
  const m = me();
  if (!m || m.info.combat.state === "NORMAL" || !movable()) return m;
  let fallback: Actor | undefined;
  for (const a of actors.values()) {
    if (a.id === m.id || a.team !== m.team) continue;
    if (a.info.combat.state === "NORMAL") return a;
    fallback = a;
  }
  return fallback ?? m;
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
    // 2) 행동 버튼 (누를 때 start, 뗄 때 stop 각 1번)
    handleAction();
    // 3) 내 캐릭터 예측: 입력을 즉시 반영
    const effA = effectiveAngle();
    m.body = simulate(m.body, now);
    if (m.body.a !== effA) m.body = withAngle(m.body, effA, now);
    // 4) 점프 (1회 = 메시지 1개)
    if (input.consumeJump() && canWalk() && myNormal() && !myBusy()) {
      const j = withJump(m.body, now);
      if (j) {
        m.body = j;
        net.send({ t: "jump", s: ++seq, at: now });
        sentAt.set(seq, t);
        lastSentSeq = seq;
      }
    }
    // 5) 타격 (1회 = 메시지 1개). 판정은 서버가 같은 조준 광선으로 한다
    if (input.consumeAttack()) attackBufferedUntil = now + CONFIG.ATTACK_BUFFER_MS;
    if (now <= attackBufferedUntil) {
      const ranged = classOf(m.info).ranged;
      const readyAt = Math.max(m.info.combat.attackReadyAt, localAttackAt + classOf(m.info).cooldownMs);
      if (movable() && myNormal() && !myBusy() && now >= readyAt) {
        net.send({ t: "attack", yaw: world.yaw, pitch: world.pitch });
        // 서버 판정을 기다리지 않고, 조준점에 걸린 상대를 바로 번쩍이게 한다 (체력은 서버 결과로 바뀜)
        const predicted = ranged ? null : findAimTarget(m.body, world.yaw, world.pitch, enemyBuf); // 화살은 날아간 뒤 판정
        if (predicted) { predicted.view.flash(t); predictedHit = predicted.id; }
        attackSentAt = t;
        localAttackAt = now;
        attackBufferedUntil = -Infinity;
        m.view.swing(t);
      }
    }
  } else {
    input.consumeJump();
    input.consumeAttack();
  }

  // 6) 모든 캐릭터 진행 + 보정 오차 줄이기 + 그리기
  const decay = Math.exp((-dt * 1000) / CONFIG.CORRECTION_SMOOTH_MS);
  const w = window.innerWidth, h = window.innerHeight;
  const watch = spectateTarget();
  enemyBuf.length = 0;
  for (const [id, a] of actors) {
    if (id !== myId) a.body = simulate(a.body, now);
    a.off.x *= decay; a.off.y *= decay; a.off.z *= decay;
    if (a.body.a >= 0) a.face = angleToRad(a.body.a);
    const x = a.body.x + a.off.x, y = a.body.y + a.off.y, z = Math.max(0, a.body.z + a.off.z);
    const c = a.info.combat;
    const state = c.state === "NORMAL" ? 0 : c.state === "DOWNED" ? 1 : 2;
    a.view.update(x, y, z, a.face, groundHeightAt(x, y, z), state, now < c.invulnUntil, a.info.conn === "RECONNECTING", t);
    a.view.setStatus(c.hp / classOf(a.info).maxHp, inGame() ? statusText(a.info, now) : "");
    if (a === watch) {
      world.ranged = classOf(a.info).ranged;
      a.view.nearCamera = world.updateCamera(x, y, z, dt) < CONFIG.CAMERA_FADE_RATIO;
    }
    else a.view.nearCamera = false;
    if (m && a.team !== m.team && c.state === "NORMAL" && now >= c.invulnUntil) enemyBuf.push(a);
  }
  if (!watch) world.updateCamera(24, 14 - 8, 0); // 입장 전: 맵 가운데를 비춤
  world.updateArrows(now);
  world.setBarriers(!!room && room.barrierUntil !== null && now < room.barrierUntil); // 서버 시각 기준으로 동시에 사라짐
  world.render();
  for (const a of actors.values()) a.view.placeLabel(world.camera, w, h);

  // 조준점: 맞힐 수 있는 상대를 가리키면 빨갛게
  const ch = $("crosshair");
  const showCh = !!m && movable() && myNormal();
  ch.classList.toggle("hidden", !showCh);
  if (showCh) ch.classList.toggle("target", !classOf(m!.info).ranged && !!findAimTarget(m!.body, world.yaw, world.pitch, enemyBuf));

  renderHud(now);
  renderMinimap(now);
  renderButtons(now);
  // 경기 후 방이 닫히기까지 남은 시간
  const note = $("matchCloseNote");
  if (matchCloseAt !== null && room?.phase === "MATCH_END") {
    const left = Math.max(0, Math.ceil((matchCloseAt - t) / 1000));
    setText("matchCloseNote", `⏱ 방이 ${left}초 뒤에 닫혀요. 다시 하기를 누르면 이 방에서 계속해요.`);
    note.classList.remove("hidden");
  } else note.classList.add("hidden");
  renderDownOverlay(now, watch);
}
world.yaw = Math.PI / 2; // 입장 전 카메라는 북쪽을 바라봄

// 혼자 연습 모드: 입장 화면 없이 A팀 시작 위치에서 바로 움직일 수 있는 상태로 시작
if (OFFLINE) {
  myId = "me";
  world.yaw = 0; // 동쪽(상대 팀 집 방향)을 바라보며 시작
  $("join").classList.add("hidden");
  const sp = SPAWNS.A[0]!;
  const t0 = net.serverNow();
  applyRoomState({
    t: "room_state", room: "연습", phase: "ATTACK", round: 1, attackingTeam: "A", phaseEndsAt: null,
    work: { kind: null, progress: 0, since: t0, holders: [], rate: 0, completesAt: null, checkpoint: 0.5 },
    roundEnd: null, map: "CLASSIC", sites: null, barrierUntil: null, score: { A: 0, B: 0 }, history: [], matchPoint: [], deuce: false, matchWinner: null, matchEndReason: null, practice: true,
    serverTime: t0,
    players: [{
      id: "me", nickname: "연습", team: "A", conn: "CONNECTED", reconnectDeadline: null, ready: true,
      body: makeBody(sp.x, sp.y, t0), seq: 0,
      combat: { hp: CLASSES.KNIGHT.maxHp, state: "NORMAL", deathAt: null, invulnUntil: 0, downs: 0, deaths: 0, revive: null, attackReadyAt: 0 },
      bot: false, cls: "KNIGHT", owner: true,
    }],
  });
}
requestAnimationFrame(frame);

// 개발 모드에서만: 자동 테스트/디버깅용으로 상태 노출
if (import.meta.env.DEV) (window as any).__game = { actors, world, net, get myId() { return myId; }, get room() { return room; }, get work() { return work; } };
