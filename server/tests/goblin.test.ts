import { describe, expect, it } from "vitest";
import { buildGoblin, triangleCount } from "../../client/src/goblin/body";
import { defineSkin } from "../../client/src/goblin/skin";

const PARTS = ["head", "torso", "armL", "armR", "handL", "handR", "legL", "legR", "footL", "footR", "earL", "earR"];

describe("고블린 베이스 바디", () => {
  it("파츠 12개가 분리돼 있고 키는 약 1.2m, 로우폴리 1,500~3,000 삼각형", () => {
    const g = buildGoblin();
    expect(Object.keys(g.parts).sort()).toEqual([...PARTS].sort());
    g.root.updateMatrixWorld(true);
    // three는 client 패키지에만 있어서, 이미 있는 Box3 인스턴스를 빌려 쓴다
    const skull = g.parts.head.getObjectByName("skull") as any;
    skull.geometry.computeBoundingBox();
    const box = skull.geometry.boundingBox.clone().makeEmpty().expandByObject(g.root);
    expect(box.min.y).toBeCloseTo(0, 2);
    expect(box.max.y).toBeGreaterThan(1.1);
    expect(box.max.y).toBeLessThan(1.25);
    const n = triangleCount(g.root);
    expect(n).toBeGreaterThanOrEqual(1500);
    expect(n).toBeLessThanOrEqual(3000);
  });
  it("스킨은 바꾼 것만 덮어씌운다 (색·장비), 나머지 옷은 기본 그대로", () => {
    const hat = () => Object.assign(buildGoblin().parts.footL.clone(false), { name: "hat" });
    const skin = defineSkin({ name: "red", colors: { skin: 0xaa3333 }, equipment: { head: hat } });
    const g = buildGoblin(skin);
    const skull = g.parts.head.getObjectByName("skull") as any;
    expect(skull.material.color.getHex()).toBe(0xaa3333);
    expect(g.parts.head.getObjectByName("hat")).toBeDefined();
    expect(g.parts.torso.getObjectByName("tunic")).toBeDefined(); // 기본 옷 유지
    expect(skin.colors.cloth).toBe(0x7a5432);
  });
});
