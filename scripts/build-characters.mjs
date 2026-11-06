// Builds character assets from Quaternius "Universal Animation Library 1+2" and
// "Universal Base Characters" (CC0, itch.io):
//   characters/anims.glb       – skeleton + curated animation clips (no mesh)
//   characters/<name>.glb      – skinned meshes (LOD0) and <name>_lod1.glb (simplified)
// Usage: node scripts/build-characters.mjs <UAL1.glb> <UAL2.glb> <outDir> <name>=<mesh.gltf|glb> ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, resample, textureCompress, draco, simplify, mergeDocuments } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const KEEP = new Set(`Crouch_Fwd_Loop Crouch_Idle_Loop Dance_Loop Death01 Driving_Loop Fixing_Kneeling Hit_Chest Hit_Head Idle_Loop Interact
Jog_Fwd_Loop Jump_Land Jump_Loop Jump_Start PickUp_Table Pistol_Aim_Down Pistol_Aim_Neutral Pistol_Aim_Up Pistol_Idle_Loop Pistol_Reload
Pistol_Shoot Punch_Cross Punch_Jab Roll Sprint_Loop Swim_Fwd_Loop Swim_Idle_Loop Walk_Loop Sitting_Idle_Loop
ClimbUp_1m Consume Hit_Knockback LayToIdle Melee_Hook OverhandThrow Slide_Exit Slide_Loop Slide_Start Walk_Carry_Loop Yes
Zombie_Idle_Loop Zombie_Scratch Zombie_Walk_Fwd_Loop Idle_FoldArms_Loop NinjaJump_Idle_Loop
Idle_Talking_Loop Idle_TalkingPhone_Loop Idle_No_Loop Idle_Rail_Loop Idle_Rail_Call Idle_Torch_Loop Walk_Formal_Loop Hit_Head Push_Loop
Chest_Open NinjaJump_Start NinjaJump_Land Punch_Cross Sitting_Talking_Loop Sitting_Enter Sitting_Exit`.split(/\s+/));

const [ual1, ual2, outDir, ...meshes] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
await MeshoptSimplifier.ready;

// ---- animations: UAL1 skeleton + clips from UAL1 & UAL2 retargeted by node name
const a = await io.read(ual1);
const b = await io.read(ual2);
const nodeByName = new Map(a.getRoot().listNodes().map((n) => [n.getName(), n]));
for (const anim of b.getRoot().listAnimations()) {
  if (!KEEP.has(anim.getName())) continue;
  const na = a.createAnimation(anim.getName());
  for (const ch of anim.listChannels()) {
    const tgt = nodeByName.get(ch.getTargetNode()?.getName());
    const s = ch.getSampler(); if (!tgt || !s) continue;
    const inp = a.createAccessor().setArray(s.getInput().getArray().slice()).setType(s.getInput().getType());
    const out = a.createAccessor().setArray(s.getOutput().getArray().slice()).setType(s.getOutput().getType());
    const ns = a.createAnimationSampler().setInput(inp).setOutput(out).setInterpolation(s.getInterpolation());
    na.addSampler(ns).addChannel(a.createAnimationChannel().setTargetNode(tgt).setTargetPath(ch.getTargetPath()).setSampler(ns));
  }
}
const killAnim = (an) => { an.listChannels().forEach((c) => c.dispose()); an.listSamplers().forEach((sm) => { sm.dispose(); }); an.dispose(); };
for (const anim of a.getRoot().listAnimations()) if (!KEEP.has(anim.getName())) killAnim(anim);
// Bone translations/scales are constant in these clips except for root/pelvis -> drop them (huge size win)
for (const anim of a.getRoot().listAnimations()) for (const ch of anim.listChannels()) {
  const n = ch.getTargetNode()?.getName(); const p = ch.getTargetPath();
  if (p === 'scale' || (p === 'translation' && n !== 'pelvis' && n !== 'root')) { const sm = ch.getSampler(); ch.dispose(); if (sm) { sm.dispose(); } }
}
for (const m of a.getRoot().listMeshes()) m.dispose();
for (const n of a.getRoot().listNodes()) if (n.getSkin()) n.setSkin(null);
for (const s of a.getRoot().listSkins()) s.dispose();
// drop finger/scale channels that never change to keep the file tiny
await a.transform(resample({ tolerance: 1e-4 }), dedup(), prune());
await io.write(path.join(outDir, 'anims.glb'), a);
console.log('anims.glb', (fs.statSync(path.join(outDir, 'anims.glb')).size / 1024).toFixed(0) + 'KB', a.getRoot().listAnimations().length, 'clips');

// ---- skinned meshes (+ LOD1)
for (const spec of meshes) {
  const [name, file] = spec.split('=');
  for (const [suffix, ratio, tex] of [['', 0, 1024], ['_lod1', 0.22, 256]]) {
    const doc = await io.read(file);
    for (const an of doc.getRoot().listAnimations()) { an.listChannels().forEach((c) => c.dispose()); an.listSamplers().forEach((sm) => { sm.dispose(); }); an.dispose(); }
    const t = [dedup(), weld(), prune()];
    if (ratio) t.push(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.05, lockBorder: false }));
    t.push(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [tex, tex], quality: 80 }), draco());
    await doc.transform(...t);
    const dst = path.join(outDir, `${name}${suffix}.glb`);
    await io.write(dst, doc);
    console.log(path.basename(dst), (fs.statSync(dst).size / 1024).toFixed(0) + 'KB');
  }
}
