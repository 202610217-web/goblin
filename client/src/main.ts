// 게임 진입점: 입장 → 로비 → 게임 화면 (이동/점프/타격/집 작업/치유/관전) → 라운드/경기 종료
import { type Body, angleToRad, groundHeightAt, makeBody, radToAngle, simulate, withAngle, withJump } from "../../shared/sim";
import { HOUSES, PHYS, SPAWNS, type TeamId, isNearHouse } from "../../shared/world";
import { AIM, findAimTarget, inReach } from "../../shared/aim";
// 서버와 같은 메시지 형식/규칙 수치를 그대로 쓴다 (타입은 빌드 때 지워진다)
import type { Phase, PublicPlayer, RoomStateMessage, RoundEndReason, WorkInfo } from "../../server/src/protocol";
import { ATTACK_COOLDOWN_MS, MAX_HP, REVIVE_TIME_MS } from "../../server/src/constants";
import { CONFIG } from "./config";
import { Input } from "./input";
import { Net } from "./net";
import { PlayerView, World3D } from "./world3d";
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
}

const world = new World3D($("stage"));
const input = new Input($("touch"), $("stickBase"), $("stickKnob"), { jump: $("jumpBtn"), attack: $("attackBtn"), action: $("actionBtn") });
const net = new Net(SERVER_URL);

let myId: string | null = null;
let roomCode = "";
let room: RoomStateMessage | null = null;
let work: WorkInfo | null = null;
const actors = new Map<string, Actor>();

// 입력 전송 상태
let seq = 0;
let lastSentSeq = 0;
let lastSentA = -2;
let lastMoveSendAt = 0;
/** 지금 누르고 있는 행동 (버튼을 뗄 때 같은 종류의 stop을 보낸다) */
let activeAction: "hold" | "revive" | null = null;
let localAttackAt = -Infinity;
/** 쿨다운 중에 누른 타격을 이 시각까지 기억 (서버 시각) */
let attackBufferedUntil = -Infinity;

const tokenKey = () => `token:${roomCode}`;
const movable = () => room?.phase === "ATTACK" || room?.phase === "REPAIR";
const me = () => (myId ? actors.get(myId) : undefined);
const myInfo = () => me()?.info;
const myNormal = () => myInfo()?.combat.state === "NORMAL";
/** 작업 중이거나 치유 중인지 (서버 상태 + 방금 누른 것) */
const myBusy = () => activeAction !== null || !!(myId && work?.holders.includes(myId)) || !!myInfo()?.combat.revive;
const inGame = () => !!room && room.phase !== "LOBBY";

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
$("joinBtn").onclick = () => {
  const code = roomInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) return showJoinError("방 코드는 4~6자리 영문/숫자예요");
  try { localStorage.setItem("nickname", nickInput.value.trim()); } catch { /* 무시 */ }
  roomCode = code;
  showJoinError("연결 중...");
  (document.activeElement as HTMLElement | null)?.blur();
  net.connect(code);
};
function showJoinError(t: string) { $("joinError").textContent = t; }
if (!fullscreenSupported() && !isStandalone()) $("a2hsHint").classList.remove("hidden");

/** 처음 화면으로 돌아간다 (방 가득 참, 자리 만료, 나가기 등) */
function goToJoin(message: string) {
  net.stop();
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
  try { sessionStorage.removeItem(tokenKey()); } catch { /* 무시 */ }
  goToJoin("");
};
const vib = $<HTMLInputElement>("vibrateToggle");
vib.checked = vibrationEnabled();
vib.onchange = () => { setVibration(vib.checked); if (vib.checked) vibrate(CONFIG.VIBRATE_HIT); };
$("giveUpBtn").onclick = () => goToJoin("");
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
      break;
    case "swing":
      onSwing(m.by, m.target);
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

let prevPhase: Phase | null = null;
let lastRoundKey = "";
function applyRoomState(s: RoomStateMessage) {
  const prevMe = myInfo();
  room = s;
  work = s.work;
  const myTeam = s.players.find((p) => p.id === myId)?.team;
  // 라운드 시작(준비 단계) 때 카메라를 상대 진영 쪽으로 돌린다
  const roundKey = `${s.round}:${myTeam}:${s.phase === "COUNTDOWN" || s.phase === "LOBBY"}`;
  if (myTeam && (s.phase === "COUNTDOWN" || s.phase === "LOBBY") && roundKey !== lastRoundKey) {
    world.yaw = myTeam === "A" ? 0 : Math.PI;
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
      a = { id: p.id, view: new PlayerView(world.scene, p.team, p.nickname, p.id === myId), team: p.team, body: p.body, off: { x: 0, y: 0, z: 0 }, face: 0, info: p };
      actors.set(p.id, a);
    }
    a.info = p;
    a.view.setNickname(p.id === myId ? `${p.nickname} (나)` : p.nickname);
    reconcile(a, p.body, p.id === myId);
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
  renderLobby();
  renderScreens();
  renderEndScreens();
  if (scoreboardOpen) renderScoreboard();
}

function onMove(id: string, body: Body, s: number) {
  const a = actors.get(id);
  if (!a) return;
  if (id === myId && s < lastSentSeq) return; // 더 새 입력이 아직 서버로 가는 중이면 보정하지 않는다
  reconcile(a, body, id === myId);
}

function onSwing(by: string, target: string | null) {
  const t = performance.now();
  if (by !== myId) actors.get(by)?.view.swing(t); // 내 동작은 누르는 순간 이미 보여줬다
  if (target) actors.get(target)?.view.flash(t);
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
  return movable() && myNormal() && !myBusy() ? desiredAngle() : -1;
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
  const target = other(room.attackingTeam); // 부수기/수리 대상 = 수비팀 집
  if (!isNearHouse(target, m.body.x, m.body.y, m.body.z)) return null;
  const attacker = m.team === room.attackingTeam;
  if (room.phase === "ATTACK" && attacker) return "break";
  if (room.phase === "REPAIR" && !attacker) return "repair";
  return null;
}

function handleAction() {
  if (input.actionHeld && activeAction === null) {
    const act = availableAction();
    if (act === "revive") { net.send({ t: "revive_start" }); activeAction = "revive"; }
    else if (act) { net.send({ t: "hold_start" }); activeAction = "hold"; }
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
      d.textContent = `${p.nickname}${p.ready ? " ✔" : ""}${p.conn === "RECONNECTING" ? " (재접속 중)" : ""}`;
      if (p.id === myId) d.className = "me";
      if (p.ready) d.classList.add("ready");
      return d;
    }));
  }
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
  $("touch").classList.toggle("hidden", !game || room?.phase === "MATCH_END");
}

const PHASE_NAME: Record<Phase, string> = {
  LOBBY: "로비", COUNTDOWN: "준비", ATTACK: "공격 단계", REPAIR: "수리 단계", ROUND_END: "라운드 종료", MATCH_END: "경기 종료",
};
const REASON_TEXT: Record<RoundEndReason, string> = {
  break_timeout: "시간 안에 집을 부수지 못했어요",
  repair_success: "집 수리 성공",
  repair_fail: "집 수리 실패",
  attackers_wiped: "공격팀 전멸",
  defenders_wiped: "수비팀 전멸",
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
    setText("hudRound", `라운드 ${room.round} · ${PHASE_NAME[room.phase]}`);
    setText("hudTimer", room.phase === "MATCH_END" ? `${room.matchWinner ?? "-"}${room.matchWinner ? "팀 승리" : ""}` : room.phase === "COUNTDOWN" || room.phase === "ROUND_END" ? `${left}` : `${mm}:${ss}`);
    $("hudTimer").classList.toggle("urgent", movable() && left <= CONFIG.TIMER_URGENT_S);
    if (room.phase === "MATCH_END") setText("hudRole", "");
    else if (mine) {
      const atk = mine.team === room.attackingTeam;
      const enemy = other(mine.team);
      setText("hudRole", atk ? `⚔ 공격팀 — ${enemy}팀 집을 부수세요` : `🛡 수비팀 — ${mine.team}팀 집을 지키세요`);
    }
    const bad = !net.connected || net.unstable || net.rtt > CONFIG.PING_WARN_MS;
    setText("netStatus", net.connected ? `${bad ? "⚠ 불안정 · " : ""}ping ${Math.round(net.rtt)}ms` : "⚠ 연결 끊김");
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
    const p = Math.min(1, work.progress + Math.max(0, now - work.since) * work.rate);
    wb.classList.remove("hidden");
    wb.classList.toggle("repair", work.kind === "REPAIR");
    setText("workLabel", `${work.kind === "BREAK" ? "집 부수기" : "집 수리"} ${Math.floor(p * 100)}%${work.holders.length ? " · 작업 중" : ""}`);
    $("workFill").style.width = `${p * 100}%`;
    $("workCheckpoint").style.left = `${work.checkpoint * 100}%`;
  } else wb.classList.add("hidden");
  renderTeamPanels(now);
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
    d.innerHTML = `<div class="nm"><span></span><span class="st"></span></div><div class="hpbar${p.combat.hp <= MAX_HP * 0.3 ? " low" : ""}"><div style="width:${(p.combat.hp / MAX_HP) * 100}%"></div></div>`;
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
      (banner.querySelector("small") as HTMLElement).textContent = `${room.roundEnd.winner}팀 +1 · ${REASON_TEXT[room.roundEnd.reason]} · ${room.score.A} : ${room.score.B}`;
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

/** 오른쪽 아래 버튼들 (타격 쿨다운, 행동 라벨/진행률 링) */
const RING = 289; // 2πr (r=46)
function renderButtons(now: number) {
  const mine = myInfo();
  if (!mine) return;
  const touch = $("touch");
  const spectating = inGame() && mine.combat.state !== "NORMAL";
  touch.classList.toggle("spectate", spectating);

  // 타격: 쿨다운 동안 어둡게 + 남은 시간
  const readyAt = Math.max(mine.combat.attackReadyAt, localAttackAt + ATTACK_COOLDOWN_MS);
  const cd = Math.max(0, readyAt - now);
  $("attackBtn").classList.toggle("cooling", cd > 0 || !movable());
  setText("attackLabel", cd > 0 ? (cd / 1000).toFixed(1) : "타격");
  $("attackCd").style.height = `${(cd / ATTACK_COOLDOWN_MS) * 100}%`;

  // 행동: 하고 있는 것 > 할 수 있는 것 > 비활성
  const btn = $("actionBtn");
  let label = "행동", cls = "disabled", progress = 0;
  if (activeAction === "revive" || mine.combat.revive) {
    label = "치유 중"; cls = "revive";
    const r = mine.combat.revive;
    if (r) progress = 1 - Math.max(0, r.endsAt - now) / REVIVE_TIME_MS;
  } else if (activeAction === "hold" || (myId && work?.holders.includes(myId))) {
    label = work?.kind === "REPAIR" ? "수리 중" : "부수는 중"; cls = "";
    if (work) progress = Math.min(1, work.progress + Math.max(0, now - work.since) * work.rate);
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
function frame() {
  requestAnimationFrame(frame);
  const t = performance.now();
  const dt = Math.min(0.1, (t - lastFrame) / 1000);
  lastFrame = t;
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
    if (want !== lastSentA && t - lastMoveSendAt >= CONFIG.MOVE_SEND_INTERVAL_MS) {
      net.send({ t: "move", a: want, s: ++seq });
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
    if (input.consumeJump() && movable() && myNormal() && !myBusy()) {
      const j = withJump(m.body, now);
      if (j) {
        m.body = j;
        net.send({ t: "jump", s: ++seq });
        lastSentSeq = seq;
      }
    }
    // 5) 타격 (1회 = 메시지 1개). 판정은 서버가 같은 조준 광선으로 한다
    if (input.consumeAttack()) attackBufferedUntil = now + CONFIG.ATTACK_BUFFER_MS;
    if (now <= attackBufferedUntil) {
      const readyAt = Math.max(m.info.combat.attackReadyAt, localAttackAt + ATTACK_COOLDOWN_MS);
      if (movable() && myNormal() && !myBusy() && now >= readyAt) {
        net.send({ t: "attack", yaw: world.yaw, pitch: world.pitch });
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
    a.view.setStatus(c.hp / MAX_HP, inGame() ? statusText(a.info, now) : "");
    if (a === watch) world.updateCamera(x, y, z);
    if (m && a.team !== m.team && c.state === "NORMAL" && now >= c.invulnUntil) enemyBuf.push(a);
  }
  if (!watch) world.updateCamera(24, 14 - 8, 0); // 입장 전: 맵 가운데를 비춤
  world.render();
  for (const a of actors.values()) a.view.placeLabel(world.camera, w, h);

  // 조준점: 맞힐 수 있는 상대를 가리키면 빨갛게
  const ch = $("crosshair");
  const showCh = !!m && movable() && myNormal();
  ch.classList.toggle("hidden", !showCh);
  if (showCh) ch.classList.toggle("target", !!findAimTarget(m!.body, world.yaw, world.pitch, enemyBuf));

  renderHud(now);
  renderButtons(now);
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
    roundEnd: null, score: { A: 0, B: 0 }, history: [], matchPoint: [], deuce: false, matchWinner: null, matchEndReason: null,
    serverTime: t0,
    players: [{
      id: "me", nickname: "연습", team: "A", conn: "CONNECTED", reconnectDeadline: null, ready: true,
      body: makeBody(sp.x, sp.y, t0), seq: 0,
      combat: { hp: MAX_HP, state: "NORMAL", deathAt: null, invulnUntil: 0, downs: 0, deaths: 0, revive: null, attackReadyAt: 0 },
    }],
  });
}
requestAnimationFrame(frame);

// 개발 모드에서만: 자동 테스트/디버깅용으로 상태 노출
if (import.meta.env.DEV) (window as any).__game = { actors, world, net, get myId() { return myId; }, get room() { return room; }, get work() { return work; } };
