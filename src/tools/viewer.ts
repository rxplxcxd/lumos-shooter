// Dev tool: renders contact sheets of GLB assets (side / top / 3-4 view) so
// orientation, scale and materials can be verified. Open /viewer.html?files=vehicles/tank,vehicles/jeep
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const params = new URLSearchParams(location.search);
const files = (params.get('files') || '').split(',').filter(Boolean);
const node = params.get('node'); // optional: render named children of a kit
const hide = (params.get('hide') || '').split(',').filter(Boolean);
const W = 360, H = 200;
document.documentElement.style.setProperty('--cols', params.get('cols') || '3');
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('./draco/');
loader.setDRACOLoader(draco);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W * 3, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;

function frame(obj: THREE.Object3D) {
  const box = new THREE.Box3();
  obj.updateMatrixWorld(true);
  obj.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) box.expandByObject(o, true); });
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  return { size, c, r: Math.max(size.x, size.y, size.z) };
}

async function renderOne(label: string, obj: THREE.Object3D) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x3a4350);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(3, 6, 4); scene.add(dl);
  scene.add(obj);
  const { size, c, r } = frame(obj);
  // +Z arrow (red) shows the asset's +Z axis, +X arrow (yellow)
  scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), c.clone().setY(c.y - size.y / 2), r * 0.8, 0xff3030, r * 0.15, r * 0.08));
  scene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), c.clone().setY(c.y - size.y / 2), r * 0.5, 0xffd000, r * 0.1, r * 0.06));
  const aspect = W / H;
  const mk = (pos: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) => {
    const s = r * 0.62;
    const cam = new THREE.OrthographicCamera(-s * aspect, s * aspect, s, -s, -r * 10, r * 10);
    cam.up.copy(up); cam.position.copy(c).add(pos.multiplyScalar(r)); cam.lookAt(c); return cam;
  };
  const cams = [mk(new THREE.Vector3(1, 0, 0)), mk(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)), mk(new THREE.Vector3(1, 0.7, 1).normalize())];
  renderer.setScissorTest(true);
  cams.forEach((cam, i) => { renderer.setViewport(i * W, 0, W, H); renderer.setScissor(i * W, 0, W, H); renderer.render(scene, cam); });
  const tile = document.createElement('div'); tile.className = 'tile';
  const img = document.createElement('canvas'); img.width = W * 3; img.height = H;
  img.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
  const l = document.createElement('div'); l.className = 'l';
  l.textContent = `${label}  ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`;
  tile.append(img, l); document.getElementById('grid')!.append(tile);
}

(async () => {
  for (const f of files) {
    try {
      const gltf = await loader.loadAsync(`./assets/${f}.glb`);
      for (const h of hide) { const o = gltf.scene.getObjectByName(h); if (o) o.visible = false; }
      if (node) {
        const names = node === '*' ? gltf.scene.children.map((c) => c.name) : node.split('|');
        for (const n of names) { const o = gltf.scene.getObjectByName(n); if (o) await renderOne(`${f}:${n}`, o.clone()); }
      } else await renderOne(f + (gltf.animations.length ? ` [${gltf.animations.length} anim]` : ''), gltf.scene);
    } catch (e) { console.error(f, e); const d = document.createElement('div'); d.textContent = `${f}: ERROR ${e}`; document.getElementById('grid')!.append(d); }
  }
  document.body.dataset.done = '1';
})();
