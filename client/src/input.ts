// 입력 추상화: 터치(조이스틱/버튼/카메라 드래그)와 키보드가 같은 상태를 채운다.
// 게임 코드는 이 상태만 읽는다.
import { CONFIG } from "./config";

export class Input {
  /** 이동 스틱 (-1~1, y=앞). 8방향으로 양자화된 값 */
  moveX = 0;
  moveY = 0;
  /** 카메라 회전 누적량 (읽으면 0으로) */
  private yawDelta = 0;
  private pitchDelta = 0;
  private jumpQueued = false;
  enabled = true;

  // 터치 상태 (각 컨트롤은 처음 잡은 포인터 id만 추적)
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private touchStick = { x: 0, y: 0 };
  private camId: number | null = null;
  private camLast = { x: 0, y: 0 };
  private keys = new Set<string>();

  constructor(private touchLayer: HTMLElement, private stickBase: HTMLElement, private stickKnob: HTMLElement, jumpBtn: HTMLElement) {
    touchLayer.addEventListener("pointerdown", (e) => this.onDown(e));
    touchLayer.addEventListener("pointermove", (e) => this.onMove(e));
    touchLayer.addEventListener("pointerup", (e) => this.onUp(e));
    touchLayer.addEventListener("pointercancel", (e) => this.onUp(e));

    // 점프 버튼: 누르는 순간 1회
    jumpBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      jumpBtn.setPointerCapture(e.pointerId);
      jumpBtn.classList.add("pressed");
      if (this.enabled) this.jumpQueued = true;
    });
    const release = () => jumpBtn.classList.remove("pressed");
    jumpBtn.addEventListener("pointerup", release);
    jumpBtn.addEventListener("pointercancel", release);

    // 키보드 (개발용 보조 입력)
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (k === " " && !this.keys.has(" ") && this.enabled) this.jumpQueued = true;
      this.keys.add(k);
      if (k === " " || k.startsWith("arrow")) e.preventDefault();
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
    this.stickBase.style.display = "none";
    this.jumpQueued = false;
  }

  /** 매 프레임 호출: 키보드/터치를 합쳐 이동 값 갱신 */
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

  consumeCamera(): { yaw: number; pitch: number } {
    const r = { yaw: this.yawDelta, pitch: this.pitchDelta };
    this.yawDelta = 0;
    this.pitchDelta = 0;
    return r;
  }

  // ---- 터치/마우스 ----
  private onDown(e: PointerEvent) {
    e.preventDefault();
    const leftHalf = e.clientX < window.innerWidth / 2;
    if (leftHalf && this.stickId === null) {
      // 왼쪽 절반: 누른 자리에 조이스틱이 나타난다 (플로팅)
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickBase.style.display = "block";
      this.stickBase.style.left = `${e.clientX}px`;
      this.stickBase.style.top = `${e.clientY}px`;
      this.setKnob(0, 0);
    } else if (!leftHalf && this.camId === null) {
      // 오른쪽 절반: 카메라 회전 드래그
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

/** 스틱 값을 8방향 단위 벡터(또는 0)로 */
function quantize8(x: number, y: number): { x: number; y: number } {
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const a = Math.round(Math.atan2(y, x) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: Math.cos(a), y: Math.sin(a) };
}
