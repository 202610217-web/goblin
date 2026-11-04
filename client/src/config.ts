// 클라이언트 UI/연출 수치 (게임 규칙 수치는 서버 constants.ts, 이동 물리는 shared/world.ts)
export const CONFIG = {
  /** 렌더링 해상도 배율 상한 (성능) */
  MAX_DPR: 2,
  /** 카메라 시야각(도) */
  CAMERA_FOV: 60,
  /** 3인칭 카메라: 캐릭터 뒤 거리, 바라보는 높이, 기본/최소/최대 내려다보는 각(라디안) */
  CAMERA_DISTANCE: 6.5,
  CAMERA_TARGET_HEIGHT: 1.5,
  CAMERA_PITCH_DEFAULT: 0.42,
  CAMERA_PITCH_MIN: 0.08,
  CAMERA_PITCH_MAX: 1.2,
  /** 화면 드래그 1px당 카메라 회전(라디안), 키보드 회전 속도(라디안/초) */
  CAMERA_DRAG_SENSITIVITY: 0.006,
  CAMERA_KEY_SPEED: 2.4,
  /** 조이스틱: 최대 반경(px), 데드존(0~1) */
  JOYSTICK_RADIUS: 60,
  JOYSTICK_DEADZONE: 0.25,
  /** 이동 메시지 최소 간격 (초당 최대 5회) */
  MOVE_SEND_INTERVAL_MS: 200,
  /** ping 간격 (20초 이하) */
  PING_INTERVAL_MS: 15_000,
  /** 이 이상 ping 지연이면 경고 표시 */
  PING_WARN_MS: 250,
  /** 서버 보정 오차를 부드럽게 줄이는 시간 상수 (ms) */
  CORRECTION_SMOOTH_MS: 120,
  /** 이 거리 이상 차이 나면 부드럽게 하지 않고 바로 이동 (m) */
  SNAP_DISTANCE: 3,
  /** 팀 색 */
  TEAM_COLOR: { A: 0xe05555, B: 0x4f7fe0 } as const,
} as const;
