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
/** 경기 시작 때 직업 선택(CLASS_SELECT) 시간 */
export const CLASS_SELECT_MS = 5_000;
/** 준비 단계(COUNTDOWN) 시간 */
export const COUNTDOWN_MS = 10_000;
/** NEON DISTRICT 준비 시간: 이동 가능 + 결계 작동 (끝나는 순간 결계가 모두 사라지고 공격 단계 시작) */
export const PREP_MS = 15_000;
/** 공격 단계(ATTACK) 시간 */
export const ATTACK_MS = 120_000;
/** 수리 단계(REPAIR) 시간 */
export const REPAIR_MS = 60_000;
/** 라운드 결과 표시(ROUND_END) 시간 */
export const ROUND_END_MS = 5_000;
/** 1라운드 공격팀 (공수 교대 규칙은 5단계에서 추가) */
export const FIRST_ATTACKING_TEAM = "A" as const;

// ---------- 이동 ----------
// 맵 구조와 이동 물리 수치(속도, 중력, 점프, 계단 높이 등)는 클라이언트와 똑같이 써야 하므로
// shared/world.ts 에 있다. 여기서는 그대로 다시 내보낸다.
export { PHYS, HOUSES, SPAWNS, BOXES } from "../../shared/world";

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

// ---------- 3단계: 집 작업 (꾹 누르기) ----------
/** 부수기 작업 시간 (혼자 0% → 100%) */
export const BREAK_TIME_MS = 4_000;
/** 수리 작업 시간 */
export const REPAIR_TIME_MS = 4_000;
/** 체크포인트 비율: 버튼을 떼면 이보다 낮으면 0, 이상이면 이 값으로 되돌아감 */
export const WORK_CHECKPOINT = 0.5;
/** 같은 팀 2명 이상이 동시에 누를 때 속도 배수 (1.0 = 1명과 같음) */
export const WORK_MULTI_SPEED = 1.0;
/** 작업 가능 거리는 클라이언트도 알아야 해서 shared/world.ts에 있다 */
export { HOUSE_WORK_DISTANCE, HOUSE_WORK_MAX_FOOT_Z } from "../../shared/world";

// ---------- 4단계: 전투 (체력 / 기절 / 사망 / 치유) ----------
/** 최대 체력 */
export const MAX_HP = 100;
/** 타격 1회 데미지 */
export const HIT_DAMAGE = 25;
/** 타격 쿨다운 */
export const ATTACK_COOLDOWN_MS = 1_000;
/** 기절 후 사망까지 */
export const DOWN_TO_DEATH_MS = 20_000;
/** 치유에 걸리는 시간 (계속 누르고 있어야 함) */
export const REVIVE_TIME_MS = 3_000;
/** 치유 후 체력 비율 */
export const REVIVE_HP_RATIO = 0.3;
/** 부활 후 무적 시간 */
export const REVIVE_INVULN_MS = 1_500;
/** 타격 사거리, 치유 거리, 높이 차이, 카메라(조준) 수치는 화면과 같아야 해서 shared/aim.ts에 있다 */
export { AIM } from "../../shared/aim";

// ---------- 5단계: 점수 규칙 ----------
/** 한 팀이 연속으로 공격하는 라운드 수 (이후 공수 교대) */
export const ROUNDS_PER_TURN = 3;
/** 먼저 이 점수에 도달하면 승리 */
export const WIN_SCORE = 6;
/** 듀스(WIN_SCORE-1 동점 이후)에서는 이 점수 차가 나야 승리 */
export const DEUCE_LEAD = 2;
/** true면 듀스 동안 매 라운드 공수 교대 */
export const DEUCE_SWAP_EVERY_ROUND = true;

// ---------- 연습용 더미 ----------
/** 더미 타격 간격 (사람의 1초보다 길게 해서 이길 수 있게) */
export const BOT_ATTACK_COOLDOWN_MS = 1_500;
/** 더미가 생각하는 간격: 평소 / 상대가 가까이 있을 때 */
export const BOT_THINK_MS = 1_000;
export const BOT_THINK_NEAR_MS = 400;
/** 상대를 쫓아가기 시작하는 거리: 지키는 더미 / 수리를 막으러 간 공격팀 더미 (집 작업하러 가는 더미는 쫓지 않음) */
export const BOT_CHASE_RANGE_DEFENDER = 6;
export const BOT_CHASE_RANGE_ATTACKER = 3;

// ---------- 지연 보정 ----------
/**
 * 이동/점프 입력을 "화면에서 누른 시각"으로 처리할 때 허용하는 최대 과거 시간.
 * 화면 예측과 서버 계산이 같은 시각을 쓰게 되어 내 캐릭터가 뒤로 당겨지지 않는다.
 * (너무 크면 입력 시각을 속여 이득을 볼 수 있으므로 0.5초로 제한)
 */
export const MAX_INPUT_REWIND_MS = 500;
