import { describe, expect, it } from "vitest";
import { isOriginAllowed, makeOriginPolicy } from "../src/origin";

describe("Origin 검사", () => {
  const strict = makeOriginPolicy("http://localhost:5173, https://me.github.io/", "false");
  const lan = makeOriginPolicy("http://localhost:5173", "true");

  it("허용 목록은 통과 (끝 슬래시 무시)", () => {
    expect(isOriginAllowed("http://localhost:5173", strict)).toBe(true);
    expect(isOriginAllowed("https://me.github.io", strict)).toBe(true);
  });
  it("목록 밖, Origin 없음은 거부", () => {
    expect(isOriginAllowed("https://evil.com", strict)).toBe(false);
    expect(isOriginAllowed(null, strict)).toBe(false);
    expect(isOriginAllowed("http://192.168.0.5:5173", strict)).toBe(false);
  });
  it("LAN 허용 시 사설 IP의 http만 통과", () => {
    expect(isOriginAllowed("http://192.168.0.5:5173", lan)).toBe(true);
    expect(isOriginAllowed("http://10.0.0.2:5173", lan)).toBe(true);
    expect(isOriginAllowed("http://172.20.1.1:5173", lan)).toBe(true);
    expect(isOriginAllowed("http://172.32.1.1:5173", lan)).toBe(false);
    expect(isOriginAllowed("http://8.8.8.8:5173", lan)).toBe(false);
    expect(isOriginAllowed("http://192.168.0.5.evil.com", lan)).toBe(false);
  });
});
