// Shared interactive three.js mesh viewer used by the STL + 3MF renderers.
// Dynamically imports three + OrbitControls so the ~600KB only loads when a 3D
// file is actually previewed. The caller supplies the geometry (each format
// builds it differently); everything else — scene, lights, camera, orbit +
// auto-rotate, and disposal — is shared here.
import type * as THREE_NS from "three";

export async function mountMeshPreview(
  el: HTMLDivElement,
  buildGeometry: (THREE: typeof THREE_NS) => THREE_NS.BufferGeometry | Promise<THREE_NS.BufferGeometry>,
): Promise<() => void> {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

  const geom = await buildGeometry(THREE);
  geom.computeVertexNormals();
  geom.center();
  geom.computeBoundingSphere();
  const radius = geom.boundingSphere?.radius || 1;

  const W = el.clientWidth || 480;
  const H = 480;
  const scene = new THREE.Scene();
  // If the geometry carries per-vertex colours (a multi-colour STEP/IGES
  // assembly), render them on a white base; otherwise use the cobble material.
  const hasVertexColors = !!geom.getAttribute("color");
  const material = new THREE.MeshStandardMaterial({
    color: hasVertexColors ? 0xffffff : 0x8b7355,
    vertexColors: hasVertexColors,
    roughness: 0.6,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geom, material);
  scene.add(mesh);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 1, 1);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(45, W / H, radius / 100, radius * 100);
  camera.position.set(radius * 2, radius * 1.6, radius * 2);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(W, H);
  el.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.4;

  let raf = 0;
  const loop = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  return () => {
    cancelAnimationFrame(raf);
    controls.dispose();
    renderer.dispose();
    geom.dispose();
    material.dispose();
    if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
  };
}
