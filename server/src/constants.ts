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

// ---------- 단계(페이즈) 시간 ----------
/** 경기 시작 때 직업 선택(CLASS_SELECT) 시간 */
export const CLASS_SELECT_MS = 5_000;
/** 시작 전 준비(COUNTDOWN) 시간: 제자리에서 기다림 */
export const COUNTDOWN_MS = 5_000;
/** 경기(PLAY) 제한 시간. 끝나면 킬이 많은 팀 승리, 같으면 무승부 */
export const MATCH_MS = 600_000;
/** 먼저 이 킬 수에 닿은 팀이 승리 (화면에도 보여야 해서 shared에 있음) */
export { KILL_TARGET } from "../../shared/classes";

// ---------- 이동 ----------
// 맵 구조와 이동 물리 수치(속도, 중력, 점프, 계단 높이 등)는 클라이언트와 똑같이 써야 하므로
// shared/world.ts 에 있다. 여기서는 그대로 다시 내보낸다.
export { PHYS, SPAWNS, BOXES } from "../../shared/world";

/** 연결별 이동 메시지(move) 레이트 리밋 (초당) */
export const MOVE_RATE_LIMIT_PER_SEC = 5;
/** 연결별 점프 메시지(jump) 레이트 리밋 (초당). 땅에 있을 때만 점프되므로 실제로는 더 적다 */
export const JUMP_RATE_LIMIT_PER_SEC = 3;
/**
 * 자주 바뀌는 상태(이동, 체력, 작업/치유 시작·중단)를 storage에 모아서 저장하는 간격.
 * 무료 플랜은 "쓴 행 수"가 하루 10만 개로 가장 빠듯해서, 바뀔 때마다가 아니라 이 간격마다 1번만 쓴다.
 * (단계 전환/입장/퇴장은 바로 저장. Durable Object는 약 10초 이상 조용해야 잠들기 때문에 그 전에 저장된다)
 */
export const STATE_FLUSH_MS = 5_000;

// ---------- 전투 ----------
/** 최대 체력 (직업이 없을 때 기본값. 직업별 체력은 shared/classes.ts) */
export const MAX_HP = 100;
/** 타격 1회 데미지 (기본값) */
export const HIT_DAMAGE = 25;
/** 타격 쿨다운 (기본값) */
export const ATTACK_COOLDOWN_MS = 1_000;
/** 죽은 뒤 부활까지 */
export const RESPAWN_MS = 3_000;
/** 부활 직후 무적 시간 */
export const RESPAWN_INVULN_MS = 2_000;
/** 타격 사거리, 높이 차이, 카메라(조준) 수치는 화면과 같아야 해서 shared/aim.ts에 있다 */
export { AIM } from "../../shared/aim";

// ---------- 연습용 더미 ----------
/** 더미 타격 간격 (사람의 1초보다 길게 해서 이길 수 있게) */
export const BOT_ATTACK_COOLDOWN_MS = 1_500;
/** 더미가 생각하는 간격: 평소 / 상대가 가까이 있을 때 */
export const BOT_THINK_MS = 1_000;
export const BOT_THINK_NEAR_MS = 400;
/** 더미가 상대를 보고 쫓아가기 시작하는 거리 (m) */
export const BOT_CHASE_RANGE = 14;

// ---------- 지연 보정 ----------
/**
 * 이동/점프 입력을 "화면에서 누른 시각"으로 처리할 때 허용하는 최대 과거 시간.
 * 화면 예측과 서버 계산이 같은 시각을 쓰게 되어 내 캐릭터가 뒤로 당겨지지 않는다.
 * (너무 크면 입력 시각을 속여 이득을 볼 수 있으므로 0.5초로 제한)
 */
export const MAX_INPUT_REWIND_MS = 500;
