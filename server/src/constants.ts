// 서버 게임 로직 상수는 모두 이 파일에 모은다.
// (1단계: 방/접속 관련 값만. 게임 규칙 수치는 이후 단계에서 추가)

/** 방 코드: 4~6자리 영문 대문자/숫자 */
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,6}$/;

/** 방당 최대 인원 */
export const MAX_PLAYERS = 4;
/** 팀당 최대 인원 */
export const MAX_PER_TEAM = 2;
/** 한 방에 동시에 열려 있을 수 있는 소켓 수 (입장 전 대기 소켓 포함, 남용 방지) */
export const MAX_SOCKETS_PER_ROOM = 8;

/** 닉네임 최대 길이(글자 수) */
export const NICKNAME_MAX_LENGTH = 12;

/** 재접속 대기 시간 (ms). 이 안에 같은 토큰으로 돌아오면 같은 자리로 복귀 */
export const RECONNECT_GRACE_MS = 30_000;

/** 세션 토큰 길이 (바이트). hex로 바꾸면 2배 글자 수 */
export const SESSION_TOKEN_BYTES = 32;

/** 클라이언트 메시지 최대 크기 (바이트) */
export const MAX_MESSAGE_BYTES = 1024;

/** 연결별 전체 메시지 레이트 리밋: 1초 창 안에 허용하는 메시지 수 */
export const MSG_RATE_LIMIT_PER_SEC = 10;

/** ping 자동 응답 문자열 (클라이언트는 "ping"을 보내면 "pong"을 받는다) */
export const PING_MESSAGE = "ping";
export const PONG_MESSAGE = "pong";

// ---------- 2단계: 단계(페이즈) 시간 ----------
/** 준비 단계(COUNTDOWN) 시간 */
export const COUNTDOWN_MS = 10_000;
/** 공격 단계(ATTACK) 시간 */
export const ATTACK_MS = 120_000;
/** 수리 단계(REPAIR) 시간 */
export const REPAIR_MS = 60_000;
/** 라운드 결과 표시(ROUND_END) 시간 */
export const ROUND_END_MS = 5_000;
/** 1라운드 공격팀 (공수 교대 규칙은 5단계에서 추가) */
export const FIRST_ATTACKING_TEAM = "A" as const;

// ---------- 2단계: 맵 / 이동 ----------
/** 맵 크기 (월드 좌표, 화면 가상 해상도 1280x720보다 크게 잡아 카메라가 따라다닌다) */
export const MAP_WIDTH = 1920;
export const MAP_HEIGHT = 1080;
/** 캐릭터 반지름(사각형이면 반 변). 맵 경계 판정에 사용 */
export const PLAYER_RADIUS = 24;
/** 이동 속도 (월드 좌표/초) */
export const PLAYER_SPEED = 260;

/** 팀별 집 위치(중심)와 크기. A팀 집은 왼쪽, B팀 집은 오른쪽 */
export const HOUSE_SIZE = 160;
export const HOUSES = {
  A: { x: 200, y: 540 },
  B: { x: 1720, y: 540 },
} as const;

/** 팀별 시작 위치 (팀 안에서 0번, 1번 자리) */
export const SPAWNS = {
  A: [{ x: 380, y: 440 }, { x: 380, y: 640 }],
  B: [{ x: 1540, y: 440 }, { x: 1540, y: 640 }],
} as const;

/** 연결별 이동 메시지 레이트 리밋 (초당) */
export const MOVE_RATE_LIMIT_PER_SEC = 5;
/** 이동 상태를 storage에 저장하는 최소 간격 (쓰기 횟수 절약) */
export const MOVE_PERSIST_INTERVAL_MS = 1_000;
