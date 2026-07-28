import * as THREE from 'three';

/*
 * Geometric specular anti-aliasing + texture filtering upgrades.
 *
 * Procedural normal maps are extremely high frequency by nature — every pore,
 * scratch and corrugation rib is real detail in the map. Under minification
 * that detail aliases the specular lobe, which is what produces the crawling
 * rainbow shimmer on things like corrugated steel and gravel. Turning the
 * normal maps down would fix the shimmer but flatten the surfaces.
 *
 * The correct fix is to widen the specular lobe by exactly as much as the
 * normal is varying within the pixel footprint: Kaplanyan et al.'s
 * "Filtering Distributions of Normals" / Tokuyoshi's normal-variance approach.
 * We estimate the variance from the screen-space derivative of the shading
 * normal and fold it into roughness.
 *
 * This is injected into MeshStandardMaterial rather than replacing it, so all
 * of Three's lighting, IBL and shadow code is untouched.
 */

const SPEC_AA_CHUNK = /* glsl */`
#include <normal_fragment_maps>
{
  // Variance of the shading normal across this pixel's footprint.
  vec3 dNdx = dFdx( normal );
  vec3 dNdy = dFdy( normal );
  float variance = SPEC_AA_STRENGTH * ( dot( dNdx, dNdx ) + dot( dNdy, dNdy ) );
  // Convert the normal variance into an equivalent roughness widening and
  // combine in variance space (roughness^2), not in roughness.
  float kernelRoughness2 = min( 2.0 * variance, SPEC_AA_CLAMP );
  float r2 = roughnessFactor * roughnessFactor + kernelRoughness2;
  roughnessFactor = sqrt( clamp( r2, 0.0, 1.0 ) );
}
`;

const PATCHED = new WeakSet();

/**
 * Inject geometric specular AA into a MeshStandardMaterial/MeshPhysicalMaterial.
 * @param {THREE.Material} mat
 * @param {{strength?: number, clamp?: number}} o
 */
export function applySpecularAA(mat, o = {}) {
  if (!mat || PATCHED.has(mat)) return mat;
  if (!mat.isMeshStandardMaterial) return mat;   // covers Physical too

  const strength = (o.strength ?? 0.5).toFixed(3);
  const clampMax = (o.clamp ?? 0.28).toFixed(3);

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    if (shader.fragmentShader.includes('SPEC_AA_STRENGTH')) return;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      SPEC_AA_CHUNK
        .replace(/SPEC_AA_STRENGTH/g, strength)
        .replace(/SPEC_AA_CLAMP/g, clampMax)
    );
  };
  // Changing onBeforeCompile requires a new program cache key, or Three will
  // reuse an already-compiled program and silently ignore the injection.
  const baseKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${baseKey ? baseKey() : ''}|specAA${strength}_${clampMax}`;
  mat.needsUpdate = true;
  PATCHED.add(mat);
  return mat;
}

const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
  'alphaMap', 'emissiveMap', 'bumpMap', 'displacementMap', 'clearcoatNormalMap',
];

/**
 * Push every texture on a material to maximum anisotropic filtering and make
 * sure trilinear mips are on. Grazing-angle ground planes are unreadable
 * without this — it is the single cheapest image-quality win available.
 */
export function upgradeTextureFiltering(mat, maxAniso) {
  if (!mat) return;
  for (const slot of TEXTURE_SLOTS) {
    const t = mat[slot];
    if (!t || !t.isTexture) continue;
    if (t.anisotropy !== maxAniso) { t.anisotropy = maxAniso; t.needsUpdate = true; }
    if (t.minFilter !== THREE.LinearMipmapLinearFilter && t.generateMipmaps !== false) {
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
    }
  }
}

/**
 * Walk a scene (or object) and upgrade every standard material found.
 * Safe to call repeatedly — already-patched materials are skipped.
 */
export function upgradeSceneMaterials(root, renderer, o = {}) {
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
  let patched = 0, textures = 0;
  root.traverse((obj) => {
    const m = obj.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mat of list) {
      if (!PATCHED.has(mat) && mat.isMeshStandardMaterial) patched++;
      applySpecularAA(mat, o);
      upgradeTextureFiltering(mat, maxAniso);
      textures++;
    }
  });
  return { patched, materials: textures, maxAniso };
}


/*
 * Environment desaturation — a colour script, applied at the shader level.
 *
 * The review's finding: "Saturated primary blue columns, saturated yellow
 * racking beams, orange crates, green ammo cans, red containers, blue/green/red
 * pipe runs — all at similar saturation and similar value, in the same frame.
 * It reads as an asset-pack dump, not a blacksite."
 *
 * Pulling `material.color` toward grey does not work, because almost all of
 * this colour lives in generated albedo maps rather than in the tint. So the
 * desaturation is injected into the fragment shader just after the map is
 * sampled, which catches both.
 *
 * Deliberately applied to WORLD materials only. Characters carry their own
 * shader injection and need to stay separated from the terrain, and the
 * viewmodel is the player's anchor object — desaturating either would undo
 * work done specifically to make them read.
 */
const DESATURATED = new WeakSet();

export function desaturateMaterial(mat, saturation = 0.68) {
  if (!mat || DESATURATED.has(mat) || !mat.isMeshStandardMaterial) return mat;
  const sat = saturation.toFixed(3);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    if (shader.fragmentShader.includes('ENV_DESAT')) return;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        // ENV_DESAT
        float envLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        diffuseColor.rgb = mix( vec3( envLum ), diffuseColor.rgb, ${sat} );
      }`
    );
  };
  const baseKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${baseKey ? baseKey() : ''}|desat${sat}`;
  mat.needsUpdate = true;
  DESATURATED.add(mat);
  return mat;
}

/** Apply the colour script to an object tree (typically the level root). */
export function desaturateWorld(root, saturation = 0.68) {
  let n = 0;
  root.traverse((obj) => {
    const m = obj.material;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (!DESATURATED.has(mat) && mat.isMeshStandardMaterial) n++;
      desaturateMaterial(mat, saturation);
    }
  });
  return n;
}
