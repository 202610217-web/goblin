import { defineConfig } from "vitest/config";

// 순수 함수 단위 테스트용 (Workers 런타임 없이 Node에서 실행)
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
