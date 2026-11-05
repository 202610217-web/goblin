// 클라이언트 UI/연출 수치 (게임 규칙 수치는 서버 constants.ts, 이동 물리는 shared/world.ts)
export const CONFIG = {
  /** 렌더링 해상도 배율 상한 (성능) */
  MAX_DPR: 2,
  /** 자동 화질 조절: 이 fps보다 낮으면 해상도 배율을 STEP만큼 낮춘다 (최소 MIN_DPR) */
  FPS_TARGET: 45,
  DPR_STEP: 0.25,
  MIN_DPR: 1,
  /** 카메라 시야각(도) */
  CAMERA_FOV: 60,
  /** 3인칭 카메라 기본 내려다보는 각(라디안). 거리/높이/어깨 위치/각도 범위는 조준 판정과 같아야 해서 shared/aim.ts */
  CAMERA_PITCH_DEFAULT: 0.42,
  /** 벽에 가릴 때: 벽에서 띄우는 거리(m), 상자 두께 여유(m), 가장 가까이 당기는 비율, 다시 멀어지는 시간(초) */
  CAMERA_WALL_MARGIN: 0.25,
  CAMERA_WALL_PAD: 0.2,
  CAMERA_MIN_RATIO: 0.06,
  CAMERA_EASE_OUT_S: 0.25,
  /** 카메라 거리 비율이 이보다 작으면 내 캐릭터를 숨김 */
  CAMERA_FADE_RATIO: 0.3,
  /** 화면 드래그 1px당 카메라 회전(라디안), 키보드 회전 속도(라디안/초) */
  CAMERA_DRAG_SENSITIVITY: 0.006,
  CAMERA_KEY_SPEED: 2.4,
  /** 조이스틱: 최대 반경(px), 데드존(0~1) */
  JOYSTICK_RADIUS: 60,
  JOYSTICK_DEADZONE: 0.25,
  /** 캐릭터가 이동 방향으로 도는 빠르기 (클수록 빨리 돎, 1/초) */
  TURN_SPEED: 14,
  /** 이동 메시지 최소 간격 (초당 최대 5회) */
  MOVE_SEND_INTERVAL_MS: 200,
  /** ping 간격 (20초 이하) */
  PING_INTERVAL_MS: 15_000,
  /** 핑 표시에 쓰는 최근 표본 수 (중간값) */
  RTT_SAMPLES: 8,
  /** 이 이상 ping 지연이면 경고 표시 */
  PING_WARN_MS: 250,
  /** 서버 보정 오차를 부드럽게 줄이는 시간 상수 (ms) */
  CORRECTION_SMOOTH_MS: 120,
  /** 이 거리 이상 차이 나면 부드럽게 하지 않고 바로 이동 (m) */
  SNAP_DISTANCE: 3,
  /** 내 기기로 연 방: 경기가 끝나고 이 시간이 지나면 방 서버를 끈다 (그 안에 다시 하기를 누르면 계속) */
  HOST_CLOSE_AFTER_MATCH_MS: 30_000,
  /** 기기 직접 연결: 이 시간 안에 연결되지 않으면 연결 중계(Cloudflare)로 바꾼다 (ms) */
  P2P_CONNECT_TIMEOUT_MS: 4_000,
  /** 자동 재접속 대기 시간 (지수 백오프, 마지막 값 반복) */
  RECONNECT_DELAYS_MS: [1000, 2000, 4000, 8000],
  /** 진동 패턴 (ms): 맞았을 때, 기절했을 때 */
  VIBRATE_HIT: 40,
  VIBRATE_DOWN: [120, 60, 120],
  /** 라운드 종료 배너 / 안내 문구 표시 시간 */
  TOAST_MS: 2500,
  /** 남은 시간이 이 이하이면 타이머를 빨갛게 */
  TIMER_URGENT_S: 10,
  /** 맞았을 때 캐릭터가 하얗게 번쩍이는 시간, 타격 동작 시간 */
  HIT_FLASH_MS: 180,
  /** 쿨다운이 끝나기 조금 전에 누른 타격은 기억했다가 끝나는 순간 보낸다 (ms) */
  ATTACK_BUFFER_MS: 300,
  /** 행동 버튼: 서버 확인 전에 진행률을 미리 채우는 최대 시간 (ms) */
  ACTION_PREDICT_MS: 2000,
  SWING_MS: 200,
  /** 팀 색 */
  TEAM_COLOR: { A: 0xe05555, B: 0x4f7fe0 } as const,
} as const;
