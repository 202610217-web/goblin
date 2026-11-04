import { describe, expect, it } from "vitest";
import { nextDeadlineAt, removeDeadline, splitDue, upsertDeadline } from "../src/deadlines";

describe("마감 시각 목록", () => {
  it("가장 가까운 시각을 고른다", () => {
    let l = upsertDeadline([], { kind: "reconnect", key: "a", at: 300 });
    l = upsertDeadline(l, { kind: "reconnect", key: "b", at: 100 });
    expect(nextDeadlineAt(l)).toBe(100);
    expect(nextDeadlineAt([])).toBeNull();
  });
  it("같은 대상은 교체, 제거 가능", () => {
    let l = upsertDeadline([], { kind: "reconnect", key: "a", at: 300 });
    l = upsertDeadline(l, { kind: "reconnect", key: "a", at: 500 });
    expect(l).toHaveLength(1);
    expect(nextDeadlineAt(l)).toBe(500);
    expect(removeDeadline(l, "reconnect", "a")).toHaveLength(0);
  });
  it("지난 마감과 남은 마감을 나눈다", () => {
    const l = [
      { kind: "reconnect" as const, key: "a", at: 200 },
      { kind: "reconnect" as const, key: "b", at: 100 },
      { kind: "reconnect" as const, key: "c", at: 900 },
    ];
    const { due, rest } = splitDue(l, 200);
    expect(due.map((d) => d.key)).toEqual(["b", "a"]);
    expect(rest.map((d) => d.key)).toEqual(["c"]);
  });
});
