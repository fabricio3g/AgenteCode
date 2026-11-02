import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Loaded only by the 3D panel. Render on input/resize; no idle animation loop. */
export async function mountModelViewer(host: HTMLElement, base64: string, focusNames: string[]) {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(gltf.scene);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7a736a, 2));
  const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(5, 10, 7); scene.add(key);
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const name of focusNames) {
    const object = gltf.scene.getObjectByName(name);
    if (object) box.union(new THREE.Box3().setFromObject(object));
  }
  if (box.isEmpty()) box.setFromObject(gltf.scene);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.1, box.getSize(new THREE.Vector3()).length() / 2);
  const camera = new THREE.PerspectiveCamera(45, 1, Math.max(0.001, radius / 1000), Math.max(1000, radius * 100));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = false;
  controls.listenToKeyEvents(host);
  const render = () => renderer.render(scene, camera);
  const fit = () => {
    const aspect = Math.max(0.1, host.clientWidth / Math.max(1, host.clientHeight));
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(22.5)) / Math.min(1, aspect);
    camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance * 1.1));
    controls.target.copy(center); controls.update(); render();
  };
  const resize = () => {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); render();
  };
  controls.addEventListener('change', render);
  const observer = new ResizeObserver(resize); observer.observe(host);
  resize(); fit();
  return {
    fit,
    dispose() {
      observer.disconnect(); controls.dispose();
      gltf.scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
        for (const material of materials) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
          material.dispose();
        }
      });
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    }
  };
}
