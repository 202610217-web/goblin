import { describe, expect, it } from "vitest";
import { type Score, type Turn, addPoint, isDeuce, matchPointTeams, matchWinner, nextTurn, roundWinner } from "../src/score";
import { wipeWinner, newCombat, applyHit } from "../src/combat";

const S = (A: number, B: number): Score => ({ A, B });

describe("라운드 승자 (점수 판정 함수)", () => {
  it("부수기 실패 → 수비팀", () => expect(roundWinner("break_timeout", "A")).toBe("B"));
  it("수리 성공 → 수비팀", () => expect(roundWinner("repair_success", "A")).toBe("B"));
  it("수리 실패 → 공격팀", () => expect(roundWinner("repair_fail", "A")).toBe("A"));
  it("공격팀 전멸 → 수비팀, 수비팀 전멸 → 공격팀", () => {
    expect(roundWinner("attackers_wiped", "B")).toBe("A");
    expect(roundWinner("defenders_wiped", "B")).toBe("B");
  });
  it("전멸 판정과 연결: ATTACK 중 공격팀 전멸이면 수비팀 승점", () => {
    const D = applyHit({ ...newCombat(), hp: 25 }, 0);
    const N = newCombat();
    const w = wipeWinner("ATTACK", "A", { A: [D, D], B: [N, N] });
    expect(w).toBe(roundWinner("attackers_wiped", "A"));
    const w2 = wipeWinner("REPAIR", "A", { A: [N, N], B: [D, D] });
    expect(w2).toBe(roundWinner("defenders_wiped", "A"));
  });
});

describe("경기 종료 / 매치포인트 / 듀스", () => {
  it("6:0 ~ 6:4 는 종료", () => {
    for (let b = 0; b <= 4; b++) expect(matchWinner(S(6, b))).toBe("A");
    expect(matchWinner(S(2, 6))).toBe("B");
  });
  it("5:4 는 진행 중, A 매치포인트", () => {
    expect(matchWinner(S(5, 4))).toBeNull();
    expect(matchPointTeams(S(5, 4))).toEqual(["A"]);
    expect(isDeuce(S(5, 4))).toBe(false);
  });
  it("5:5 는 듀스, 매치포인트 없음", () => {
    expect(isDeuce(S(5, 5))).toBe(true);
    expect(matchWinner(S(5, 5))).toBeNull();
    expect(matchPointTeams(S(5, 5))).toEqual([]);
  });
  it("6:5 는 진행 중 (2점 차 필요), A 매치포인트", () => {
    expect(matchWinner(S(6, 5))).toBeNull();
    expect(matchPointTeams(S(6, 5))).toEqual(["A"]);
  });
  it("6:6 는 진행 중, 매치포인트 없음", () => {
    expect(matchWinner(S(6, 6))).toBeNull();
    expect(matchPointTeams(S(6, 6))).toEqual([]);
  });
  it("7:5 는 A 승리, 상한 없이 계속 (12:10 도 가능)", () => {
    expect(matchWinner(S(7, 5))).toBe("A");
    expect(matchWinner(S(11, 10))).toBeNull();
    expect(matchWinner(S(10, 12))).toBe("B");
  });
  it("0:0, 4:4 는 매치포인트 없음 / 4:5 는 B 매치포인트", () => {
    expect(matchPointTeams(S(0, 0))).toEqual([]);
    expect(matchPointTeams(S(4, 4))).toEqual([]);
    expect(matchPointTeams(S(4, 5))).toEqual(["B"]);
  });
  it("이미 끝난 경기에는 매치포인트 없음", () => {
    expect(matchPointTeams(S(6, 2))).toEqual([]);
  });
  it("점수 더하기", () => expect(addPoint(S(1, 2), "B")).toEqual(S(1, 3)));
});

describe("공수 교대", () => {
  /** 점수 흐름대로 라운드를 진행하며 각 라운드의 공격팀 기록 */
  function attackers(winners: ("A" | "B")[], deuceSwap = true): string {
    let turn: Turn = { attackingTeam: "A", roundsInTurn: 0 };
    let score = S(0, 0);
    let out = "";
    for (const w of winners) {
      out += turn.attackingTeam;
      score = addPoint(score, w);
      turn = nextTurn(turn, score, deuceSwap);
    }
    return out;
  }
  it("3라운드마다 교대: AAA BBB AAA", () => {
    expect(attackers(["A", "B", "A", "B", "A", "B", "A", "B", "A"])).toBe("AAABBBAAA");
  });
  it("교대 시점: 3라운드 후에 바뀐다", () => {
    let t: Turn = { attackingTeam: "A", roundsInTurn: 0 };
    t = nextTurn(t, S(1, 0)); expect(t).toEqual({ attackingTeam: "A", roundsInTurn: 1 });
    t = nextTurn(t, S(2, 0)); expect(t).toEqual({ attackingTeam: "A", roundsInTurn: 2 });
    t = nextTurn(t, S(2, 1)); expect(t).toEqual({ attackingTeam: "B", roundsInTurn: 0 });
  });
  it("듀스(5:5)부터는 매 라운드 교대", () => {
    // A A B B A A B B A B → 5:5 (10라운드), 이후 B, A 교대로 이김
    const w: ("A" | "B")[] = ["A", "A", "B", "B", "A", "A", "B", "B", "A", "B", "A", "B", "A"];
    // 라운드 1~3 A, 4~6 B, 7~9 A, 10 B(새 차례 1번째), 5:5 이후 매 라운드 교대
    expect(attackers(w)).toBe("AAABBBAAABABA");
  });
  it("듀스 교대 플래그를 끄면 듀스에서도 3라운드마다", () => {
    const w: ("A" | "B")[] = ["A", "A", "B", "B", "A", "A", "B", "B", "A", "B", "A", "B", "A"];
    expect(attackers(w, false)).toBe("AAABBBAAABBBA");
  });
});
