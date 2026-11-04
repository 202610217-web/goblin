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
