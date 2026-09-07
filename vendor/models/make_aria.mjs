import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import sharp from 'sharp';

const [,, inPath, outPath, presetName='tan'] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inPath);
const root = doc.getRoot();

// 1) no glasses
for (const node of root.listNodes()) if (/glasses/i.test(node.getName())) node.dispose();
for (const mesh of root.listMeshes()) if (/glasses/i.test(mesh.getName())) mesh.dispose();

// recolor helpers: per-channel linear (multiply, offset) on the base color texture
async function recolor(tex, mul, off) {
  const { data, info } = await sharp(Buffer.from(tex.getImage())).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) for (let c = 0; c < 3; c++) { const v = data[i + c] * mul[c] + off[c]; data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v; }
  const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).png().toBuffer();
  tex.setImage(new Uint8Array(out)); tex.setMimeType('image/png');
}
const PRESETS = {
  tan:   { skinMul: [0.96, 0.80, 0.64], skinOff: [0, -4, -8], hairMul: [2.1, 1.35, 0.95], hairOff: [48, 22, 8], topMul: [0.22, 0.2, 0.2], topOff: [10, 9, 10] },
  tan2:  { skinMul: [0.92, 0.84, 0.74], skinOff: [0, -2, -6], hairMul: [1.75, 1.12, 0.78], hairOff: [30, 12, 4], topMul: [0.16, 0.15, 0.16], topOff: [6, 6, 8] },
};
const P = PRESETS[presetName];
for (const mat of root.listMaterials()) {
  const n = mat.getName(); const tex = mat.getBaseColorTexture(); if (!tex) continue;
  if (/skin|body/i.test(n)) await recolor(tex, P.skinMul, P.skinOff);
  else if (/hair/i.test(n)) await recolor(tex, P.hairMul, P.hairOff);
  else if (/outfit_top/i.test(n)) await recolor(tex, P.topMul, P.topOff);
}
await doc.transform(prune());
await io.write(outPath, doc);
console.log('wrote', outPath);
