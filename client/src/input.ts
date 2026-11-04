// 입력 추상화: 터치(조이스틱/버튼/카메라 드래그)와 키보드가 같은 상태를 채운다.
// 게임 코드는 이 상태(moveX/moveY, actionHeld, consumeJump/consumeAttack/consumeCamera)만 읽는다.
import { CONFIG } from "./config";

export class Input {
  /** 이동 스틱 (-1~1, y=앞). 8방향으로 양자화된 값 */
  moveX = 0;
  moveY = 0;
  /** [행동] 버튼(꾹 누르기)을 누르고 있는지 (터치 또는 K 키) */
  actionHeld = false;
  /** false면 이동/행동/타격/점프 입력을 막는다 (카메라 회전은 항상 가능) */
  enabled = true;
  /** Tab 키 / 점수판 토글 요청 */
  onToggleScoreboard: () => void = () => {};

  private yawDelta = 0;
  private pitchDelta = 0;
  private jumpQueued = false;
  private attackQueued = false;
  private touchAction = false;

  // 터치 상태 (각 컨트롤은 처음 잡은 포인터 id만 추적)
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private touchStick = { x: 0, y: 0 };
  private camId: number | null = null;
  private camLast = { x: 0, y: 0 };
  private keys = new Set<string>();

  constructor(
    private touchLayer: HTMLElement,
    private stickBase: HTMLElement,
    private stickKnob: HTMLElement,
    buttons: { jump: HTMLElement; attack: HTMLElement; action: HTMLElement },
  ) {
    touchLayer.addEventListener("pointerdown", (e) => this.onDown(e));
    touchLayer.addEventListener("pointermove", (e) => this.onMove(e));
    touchLayer.addEventListener("pointerup", (e) => this.onUp(e));
    touchLayer.addEventListener("pointercancel", (e) => this.onUp(e));

    bindButton(buttons.jump, () => { if (this.enabled) this.jumpQueued = true; }, () => {});
    bindButton(buttons.attack, () => { if (this.enabled) this.attackQueued = true; }, () => {});
    // 행동 버튼: 손가락이 버튼 밖으로 미끄러져도 누른 상태 유지, 실제로 뗄 때만 해제
    bindButton(buttons.action, () => { this.touchAction = true; }, () => { this.touchAction = false; });

    // 키보드 (개발/테스트용 보조 입력): WASD 이동, Space 점프, J 타격, K 행동, Tab 점수판, Q/E/방향키 카메라
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (!e.repeat) {
        if (k === " " && this.enabled) this.jumpQueued = true;
        if (k === "j" && this.enabled) this.attackQueued = true;
        if (k === "tab") this.onToggleScoreboard();
      }
      this.keys.add(k);
      if (k === " " || k === "tab" || k.startsWith("arrow")) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.reset());
    window.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** 입력 모두 해제 (백그라운드 전환 등) */
  reset() {
    this.keys.clear();
    this.stickId = null;
    this.camId = null;
    this.touchStick = { x: 0, y: 0 };
    this.touchAction = false;
    this.actionHeld = false;
    this.stickBase.style.display = "none";
    this.jumpQueued = false;
    this.attackQueued = false;
  }

  /** 매 프레임 호출: 키보드/터치를 합쳐 상태 갱신 */
  update(dt: number) {
    let x = this.touchStick.x;
    let y = this.touchStick.y;
    const k = this.keys;
    const kx = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
    const ky = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0);
    if (kx !== 0 || ky !== 0) { x = kx; y = ky; }
    const q = quantize8(x, y);
    this.moveX = this.enabled ? q.x : 0;
    this.moveY = this.enabled ? q.y : 0;
    this.actionHeld = this.enabled && (this.touchAction || k.has("k"));
    const rot = (k.has("arrowleft") || k.has("q") ? 1 : 0) - (k.has("arrowright") || k.has("e") ? 1 : 0);
    const tilt = (k.has("arrowup") ? 1 : 0) - (k.has("arrowdown") ? 1 : 0);
    this.yawDelta += rot * CONFIG.CAMERA_KEY_SPEED * dt;
    this.pitchDelta += tilt * CONFIG.CAMERA_KEY_SPEED * 0.5 * dt;
  }

  consumeJump(): boolean {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  consumeAttack(): boolean {
    const a = this.attackQueued;
    this.attackQueued = false;
    return a;
  }

  consumeCamera(): { yaw: number; pitch: number } {
    const r = { yaw: this.yawDelta, pitch: this.pitchDelta };
    this.yawDelta = 0;
    this.pitchDelta = 0;
    return r;
  }

  // ---- 터치/마우스: 왼쪽 절반 = 조이스틱, 오른쪽 절반 = 카메라 드래그 ----
  private onDown(e: PointerEvent) {
    e.preventDefault();
    const leftHalf = e.clientX < window.innerWidth / 2;
    if (leftHalf && this.stickId === null && this.enabled) {
      // 누른 자리에 조이스틱이 나타난다 (플로팅)
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickBase.style.display = "block";
      this.stickBase.style.left = `${e.clientX}px`;
      this.stickBase.style.top = `${e.clientY}px`;
      this.setKnob(0, 0);
    } else if ((!leftHalf || !this.enabled) && this.camId === null) {
      this.camId = e.pointerId;
      this.camLast = { x: e.clientX, y: e.clientY };
    } else return;
    this.touchLayer.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (e.pointerId === this.stickId) {
      const R = CONFIG.JOYSTICK_RADIUS;
      let dx = e.clientX - this.stickOrigin.x;
      let dy = e.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      this.setKnob(dx, dy);
      const m = Math.min(1, len / R);
      this.touchStick = m < CONFIG.JOYSTICK_DEADZONE ? { x: 0, y: 0 } : { x: dx / R, y: -dy / R };
    } else if (e.pointerId === this.camId) {
      this.yawDelta -= (e.clientX - this.camLast.x) * CONFIG.CAMERA_DRAG_SENSITIVITY;
      this.pitchDelta += (e.clientY - this.camLast.y) * CONFIG.CAMERA_DRAG_SENSITIVITY;
      this.camLast = { x: e.clientX, y: e.clientY };
    }
  }

  private onUp(e: PointerEvent) {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.touchStick = { x: 0, y: 0 }; // 손을 떼면 즉시 정지
      this.stickBase.style.display = "none";
    } else if (e.pointerId === this.camId) {
      this.camId = null;
    }
  }

  private setKnob(dx: number, dy: number) {
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}

/**
 * 버튼 하나: 처음 잡은 포인터만 추적하고(멀티터치), 포인터 캡처로 손가락이 밖으로 나가도 유지.
 * 실제로 손을 뗄 때(pointerup/pointercancel)만 onUp.
 */
function bindButton(el: HTMLElement, onDown: () => void, onUp: () => void) {
  let id: number | null = null;
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (id !== null) return;
    id = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    el.classList.add("pressed");
    onDown();
  });
  const release = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    el.classList.remove("pressed");
    onUp();
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("lostpointercapture", release);
}

/** 스틱 값을 8방향 단위 벡터(또는 0)로 */
function quantize8(x: number, y: number): { x: number; y: number } {
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const a = Math.round(Math.atan2(y, x) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: Math.cos(a), y: Math.sin(a) };
}
