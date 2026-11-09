// Poly Haven 모델(client/public/ph/<이름>/<이름>.gltf)의 삼각형 수를 줄인다 (화면에서 작게 보이는데 너무 정밀해서 프레임을 먹음).
//   npm i --no-save @gltf-transform/core@4 @gltf-transform/functions@4 meshoptimizer@0.22
//   node tools/simplify_models.mjs client/public/ph
// 비율 = 남길 삼각형 비율 (외곽 모양은 유지, error = 모델 크기 대비 허용 오차)
import { NodeIO } from "@gltf-transform/core";
import { prune, simplify, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";

const RATIO = { street_lamp_01: 0.08, exterior_aircon_unit: 0.1, rock_07: 0.06, rock_09: 0.06, wooden_crate_02: 0.25, shrub_03: 0.5 };
const io = new NodeIO();
const dir = process.argv[2];
const tris = (doc) => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute("POSITION").getCount()) / 3, 0);
for (const [name, ratio] of Object.entries(RATIO)) {
  const file = `${dir}/${name}/${name}.gltf`;
  const doc = await io.read(file);
  const before = tris(doc);
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.004 }), prune());
  await io.write(file, doc);
  console.log(name, before, "→", tris(doc));
}
