// KayKit Adventurers(CC0) 캐릭터를 게임용으로 줄여 client/public/chars/ 에 넣는다.
//   git clone --depth 1 https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0.git kaykit
//   npm i --no-save @gltf-transform/core@4 @gltf-transform/functions@4
//   node tools/kaykit_chars.mjs kaykit/addons/kaykit_character_pack_adventures/Characters/gltf client/public/chars
// 게임에서 쓰는 동작 13개와 직업 장비만 남긴다 (기사 = 한손검+방패, 궁수 = 양손 석궁, 창병 = 무기 없음 → 코드가 창을 쥐어 줌)
import { NodeIO } from "@gltf-transform/core";
import { dedup, prune, quantize, resample, weld } from "@gltf-transform/functions";

const io = new NodeIO();
const [src, out] = process.argv.slice(2);
const KEEP_ANIMS = ["Idle", "Walking_A", "Running_A", "Jump_Idle", "Jump_Land", "1H_Melee_Attack_Slice_Diagonal", "2H_Ranged_Shoot", "Throw",
  "Hit_A", "Lie_Idle", "Death_A", "1H_Melee_Attack_Chop", "PickUp"];
const DROP_NODES = {
  Knight: ["1H_Sword_Offhand", "2H_Sword", "Rectangle_Shield", "Round_Shield", "Spike_Shield"],
  Rogue_Hooded: ["Knife_Offhand", "1H_Crossbow", "Knife", "Throwable"],
  Barbarian: ["1H_Axe_Offhand", "Barbarian_Round_Shield", "1H_Axe", "2H_Axe", "Mug"],
};
const orphans = (root) => { for (const a of root.listAccessors()) if (a.listParents().every((p) => p.propertyType === "Root")) a.dispose(); };
for (const [name, drop] of Object.entries(DROP_NODES)) {
  const file = `${out}/${name.toLowerCase()}.glb`;
  const doc = await io.read(`${src}/${name}.glb`);
  const root = doc.getRoot();
  for (const a of root.listAnimations()) if (!KEEP_ANIMS.includes(a.getName())) a.dispose();
  for (const n of root.listNodes()) if (drop.includes(n.getName())) n.dispose();
  await doc.transform(resample(), prune(), dedup(), weld(), quantize());
  await io.write(file, doc);
  // 지운 동작이 쓰던 데이터는 다시 읽어야 고아로 보여서 한 번 더 정리
  const again = await io.read(file);
  orphans(again.getRoot());
  await io.write(file, again);
  console.log(name, "→", file);
}
