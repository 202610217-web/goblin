// 기기 기능: 화면 꺼짐 방지, 진동, 전체 화면 (지원 안 되면 조용히 무시)

let wakeLock: { release(): Promise<void> } | null = null;

/** 게임 중 화면이 꺼지지 않게 요청 (Screen Wake Lock API) */
export async function keepScreenOn(on: boolean) {
  try {
    if (on && !wakeLock && document.visibilityState === "visible" && "wakeLock" in navigator) {
      wakeLock = await (navigator as any).wakeLock.request("screen");
      (wakeLock as any).addEventListener?.("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}

const VIB_KEY = "vibrate";
export function vibrationEnabled(): boolean {
  try { return localStorage.getItem(VIB_KEY) !== "off"; } catch { return true; }
}
export function setVibration(on: boolean) {
  try { localStorage.setItem(VIB_KEY, on ? "on" : "off"); } catch { /* 무시 */ }
}
/** 짧게 진동 (지원 기기 + 설정 켜짐일 때만) */
export function vibrate(pattern: number | readonly number[]) {
  if (!vibrationEnabled()) return;
  try { navigator.vibrate?.(pattern as number | number[]); } catch { /* 무시 */ }
}

export const fullscreenSupported = () => !!document.fullscreenEnabled;
export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: "hide" } as FullscreenOptions);
  } catch { /* 무시 */ }
}
/** 홈 화면에 추가해서 실행 중인지 */
export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches || (navigator as any).standalone === true;
