import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

/*
 * Hand-rolled post stack. Deliberately not EffectComposer: we render the scene
 * once into an HDR target that owns a real DepthTexture, which every downstream
 * effect (AO, fog, volumetrics, motion blur) needs. Chaining the stock example
 * passes cannot give us that without an extra geometry pass.
 *
 * Order:
 *   scene -> sceneHDR(+depth)
 *   HBAO (half-res) -> bilateral blur
 *   volumetric light shafts (quarter-res, depth-occluded radial blur)
 *   bloom mip chain (Jimenez/COD-style 13-tap down, tent up)
 *   resolve   : AO * scene + fog + volumetrics + bloom + camera motion blur
 *   grade     : chromatic aberration, ACES, lift/gamma/gain, vignette, grain, dirt
 *   SMAA      : edge AA
 *   sharpen   : contrast-adaptive sharpen to screen
 */

const COMMON = /* glsl */`
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  const float PI = 3.14159265359;
  float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---------------------------------------------------------------- HBAO -----
const AO_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tDepth;
  uniform mat4 uProjInv;
  uniform mat4 uProj;
  uniform vec2 uRes;
  uniform float uRadius, uRadiusNear, uContactWeight;
  uniform float uIntensity, uBias, uNear, uFar, uFrame;

  // Two scales per direction. A single 0.85 m radius sampled at half resolution
  // cannot resolve contact-scale occlusion: the smallest usable offset is ~2
  // half-res texels, which at a few metres is already tens of centimetres of
  // world space, so the wall/floor junction — the thing that makes objects look
  // like they rest on the ground — fell entirely between samples. The near
  // march handles contact, the far march handles the broad ambient term.
  #define DIRS 6
  #define STEPS_NEAR 4
  #define STEPS_FAR 4

  vec3 viewPos(vec2 uv){
    float d = texture2D(tDepth, uv).r;
    vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uProjInv * clip;
    return v.xyz / v.w;
  }

  // Interleaved gradient noise — cheap, well distributed, temporally stable enough.
  float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

  // Bayer 4x4, computed analytically. GLSL ES 1.00 forbids dynamic indexing of
  // a local array, and the loop-over-16 workaround is far more expensive than
  // this recurrence. Yields 16 distinct values on a repeating 4x4 tile, which
  // the 4x4 resolve downstream averages over exactly one period.
  float bayer2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
  float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }

  void main(){
    float d = texture2D(tDepth, vUv).r;
    if (d >= 0.9999) { gl_FragColor = vec4(1.0); return; }

    vec3 P = viewPos(vUv);
    vec2 texel = 1.0 / uRes;

    // Depth-aware normal reconstruction: pick the closer neighbour on each axis
    // so we don't smear normals across silhouettes.
    vec3 pR = viewPos(vUv + vec2(texel.x, 0.0));
    vec3 pL = viewPos(vUv - vec2(texel.x, 0.0));
    vec3 pU = viewPos(vUv + vec2(0.0, texel.y));
    vec3 pD = viewPos(vUv - vec2(0.0, texel.y));
    vec3 dx = (abs(pR.z - P.z) < abs(P.z - pL.z)) ? (pR - P) : (P - pL);
    vec3 dy = (abs(pU.z - P.z) < abs(P.z - pD.z)) ? (pU - P) : (P - pD);
    vec3 N = normalize(cross(dx, dy));

    // Project the world-space radius into screen space at this depth.
    //
    // The upper clamp matters enormously and was set to 0.25 — a quarter of the
    // screen. Close to a surface that meant every sample landed on unrelated
    // geometry far outside uRadius and was rejected by the distance test, so the
    // AO buffer came out a near-white field with no contact darkening anywhere.
    // 0.06 keeps the sample disc local enough that it actually finds creases.
    float projScale = 0.5 * uProj[1][1] / max(0.0001, -P.z);
    float radiusFarUV  = clamp(uRadius * projScale,        texel.y * 2.0, 0.11);
    float radiusNearUV = clamp(uRadiusNear * projScale,    texel.y * 1.2, 0.030);

    // Tile the rotation rather than randomising per pixel, and add a slow
    // per-frame offset so any residual pattern averages out over time.
    float rnd = fract(bayer4(gl_FragCoord.xy) + uFrame * 0.0625);
    float occ = 0.0;

    float occNear = 0.0;

    for (int i = 0; i < DIRS; i++){
      float ang = (float(i) + rnd) * (2.0 * PI / float(DIRS));
      vec2 dir = vec2(cos(ang), sin(ang));
      dir.x *= uRes.y / uRes.x;             // keep the sample disc circular

      // --- contact march ---
      float topN = uBias;
      for (int j = 1; j <= STEPS_NEAR; j++){
        float t = (float(j) - 0.5 * rnd) / float(STEPS_NEAR);
        vec2 suv = vUv + dir * t * radiusNearUV;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
        vec3 S = viewPos(suv);
        vec3 diff = S - P;
        float len = length(diff);
        if (len < 0.0001 || len > uRadiusNear) continue;
        float cosH = dot(N, diff / len);
        float atten = 1.0 - clamp(len / uRadiusNear, 0.0, 1.0);
        occNear += max(cosH - topN, 0.0) * atten * atten;
        topN = max(topN, cosH);
      }

      // --- broad ambient march ---
      float topH = uBias;
      for (int j = 1; j <= STEPS_FAR; j++){
        float t = (float(j) - 0.5 * rnd) / float(STEPS_FAR);
        vec2 suv = vUv + dir * t * radiusFarUV;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
        vec3 S = viewPos(suv);
        vec3 diff = S - P;
        float len = length(diff);
        if (len < 0.0001 || len > uRadius) continue;
        float cosH = dot(N, diff / len);
        float atten = 1.0 - clamp(len / uRadius, 0.0, 1.0);
        occ += max(cosH - topH, 0.0) * atten * atten;
        topH = max(topH, cosH);
      }
    }

    // Contact carries most of the weight — it is what reads as "resting on".
    float occTotal = (occNear * uContactWeight + occ) / float(DIRS);
    float ao = 1.0 - clamp(occTotal * uIntensity, 0.0, 1.0);
    gl_FragColor = vec4(ao, ao, ao, 1.0);
  }
`;

// 4x4 box resolve of the interleaved AO pattern. Depth-weighted so it does not
// pull occlusion across a silhouette.
const AO_RESOLVE_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tAO, tDepth;
  uniform vec2 uRes;
  uniform float uNear, uFar;

  float linZ(float d){
    float z = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }

  void main(){
    vec2 texel = 1.0 / uRes;
    float centerZ = linZ(texture2D(tDepth, vUv).r);
    float sum = 0.0, wsum = 0.0;
    for (int y = -1; y <= 2; y++){
      for (int x = -1; x <= 2; x++){
        vec2 off = vec2(float(x), float(y)) * texel;
        float z = linZ(texture2D(tDepth, vUv + off).r);
        float w = exp(-abs(z - centerZ) * 2.2);
        sum += texture2D(tAO, vUv + off).r * w;
        wsum += w;
      }
    }
    float v = sum / max(wsum, 0.0001);
    gl_FragColor = vec4(v, v, v, 1.0);
  }
`;

// Depth-aware (bilateral) separable blur for the AO buffer.
const AO_BLUR_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tAO, tDepth;
  uniform vec2 uDir, uRes;
  uniform float uNear, uFar;

  float linZ(float d){
    float z = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }

  void main(){
    vec2 texel = 1.0 / uRes;
    float centerZ = linZ(texture2D(tDepth, vUv).r);
    float sum = 0.0, wsum = 0.0;
    for (int i = -4; i <= 4; i++){
      float fi = float(i);
      vec2 off = uDir * texel * fi;
      float w = exp(-fi * fi / 8.0);
      float z = linZ(texture2D(tDepth, vUv + off).r);
      // Reject samples across a depth discontinuity so AO doesn't bleed.
      w *= exp(-abs(z - centerZ) * 1.6);
      sum += texture2D(tAO, vUv + off).r * w;
      wsum += w;
    }
    float v = sum / max(wsum, 0.0001);
    gl_FragColor = vec4(v, v, v, 1.0);
  }
`;

// ------------------------------------------------- volumetric light shafts --
const SHAFT_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tDepth;
  uniform vec2 uSunUV;
  uniform float uDensity, uDecay, uWeight, uExposure, uFrame, uVisible;
  #define SAMPLES 36

  float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

  void main(){
    if (uVisible < 0.001) { gl_FragColor = vec4(0.0); return; }
    vec2 delta = (vUv - uSunUV) * (uDensity / float(SAMPLES));
    vec2 uv = vUv;
    float illum = 1.0;
    float accum = 0.0;
    // Jitter the ray start to trade banding for noise (the grain hides it).
    uv -= delta * ign(gl_FragCoord.xy + uFrame * 3.17);
    for (int i = 0; i < SAMPLES; i++){
      uv -= delta;
      // Sky pixels (depth ~1) are unoccluded light; geometry blocks the shaft.
      float d = texture2D(tDepth, clamp(uv, 0.0, 1.0)).r;
      float s = step(0.9995, d);
      s *= illum * uWeight;
      accum += s;
      illum *= uDecay;
    }
    float v = accum * uExposure * uVisible;
    gl_FragColor = vec4(v, v, v, 1.0);
  }
`;

// ------------------------------------------------- auto-exposure metering ---
/*
 * A fixed exposure only works if the camera never turns. Facing away from the
 * sun this scene sat at ~3.5 stops of range; facing into it, a quarter of the
 * frame clipped to pure white and the range collapsed to 1.4 stops. Eye
 * adaptation fixes that: meter the frame's log-average luminance, smooth it
 * over time, and derive exposure from it.
 *
 * Metering is centre-weighted so a bright sky at the top of frame doesn't
 * crush the ground the player is actually looking at.
 */
const LUM_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tScene;
  void main(){
    vec3 c = texture2D(tScene, vUv).rgb;
    float l = max(luma(c), 0.0);
    // Centre weighting: full weight in the middle, falling to 0.25 at the edges.
    float r = length(vUv - 0.5) * 2.0;
    float w = mix(1.0, 0.25, smoothstep(0.35, 1.15, r));
    // Store weighted log-luminance and the weight, so the reduction can
    // normalise correctly rather than averaging a pre-divided value.
    float logL = log(max(l, 0.0002));
    gl_FragColor = vec4(logL * w, w, 0.0, 1.0);
  }
`;

// 4x4 box reduction (bilinear gives each tap a free 2x2).
const REDUCE_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  void main(){
    vec4 a = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel);
    vec4 b = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel);
    vec4 c = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel);
    vec4 d = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel);
    gl_FragColor = (a + b + c + d) * 0.25;
  }
`;

// 1x1 ping-pong: ease the adapted luminance toward the measured one.
const ADAPT_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tMeasured, tPrev;
  uniform float uDt, uUpRate, uDownRate;
  void main(){
    vec2 m = texture2D(tMeasured, vec2(0.5)).rg;
    float measured = exp(m.r / max(m.g, 0.0001));
    float prev = texture2D(tPrev, vec2(0.5)).r;
    if (prev <= 0.0) prev = measured;      // first frame: snap, don't fade in
    // Eyes brighten slowly and darken fast; matching that is what stops the
    // adaptation reading as an automatic camera doing exposure hunting.
    float rate = measured > prev ? uDownRate : uUpRate;
    float k = 1.0 - exp(-uDt * rate);
    gl_FragColor = vec4(mix(prev, measured, k), 0.0, 0.0, 1.0);
  }
`;

// ----------------------------------------------------------------- bloom ----
const BRIGHT_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tDiffuse;
  uniform float uThreshold, uKnee, uExposure;
  uniform sampler2D tAdapt;
  uniform float uKeyValue, uEvMin, uEvMax;
  float autoExposure(){
    float lum = max(texture2D(tAdapt, vec2(0.5)).r, 0.0002);
    return clamp(uKeyValue / lum, uEvMin, uEvMax);
  }
  void main(){
    // Exposure is applied here as well as in resolve, so the bloom threshold is
    // in display-referred terms (1.0 == white) regardless of how bright the
    // sky module's HDR radiances happen to be.
    vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure * autoExposure();
    float l = luma(c);
    // Soft knee so highlights ramp into bloom instead of popping.
    float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 0.0001);
    float contrib = max(soft, l - uThreshold) / max(l, 0.0001);
    gl_FragColor = vec4(c * contrib, 1.0);
  }
`;

// 13-tap downsample (Jimenez, "Next Generation Post Processing in COD:AW")
const DOWN_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  void main(){
    vec2 t = uTexel;
    vec3 a = texture2D(tDiffuse, vUv + vec2(-2.0, 2.0) * t).rgb;
    vec3 b = texture2D(tDiffuse, vUv + vec2( 0.0, 2.0) * t).rgb;
    vec3 c = texture2D(tDiffuse, vUv + vec2( 2.0, 2.0) * t).rgb;
    vec3 d = texture2D(tDiffuse, vUv + vec2(-2.0, 0.0) * t).rgb;
    vec3 e = texture2D(tDiffuse, vUv).rgb;
    vec3 f = texture2D(tDiffuse, vUv + vec2( 2.0, 0.0) * t).rgb;
    vec3 g = texture2D(tDiffuse, vUv + vec2(-2.0,-2.0) * t).rgb;
    vec3 h = texture2D(tDiffuse, vUv + vec2( 0.0,-2.0) * t).rgb;
    vec3 i = texture2D(tDiffuse, vUv + vec2( 2.0,-2.0) * t).rgb;
    vec3 j = texture2D(tDiffuse, vUv + vec2(-1.0, 1.0) * t).rgb;
    vec3 k = texture2D(tDiffuse, vUv + vec2( 1.0, 1.0) * t).rgb;
    vec3 l = texture2D(tDiffuse, vUv + vec2(-1.0,-1.0) * t).rgb;
    vec3 m = texture2D(tDiffuse, vUv + vec2( 1.0,-1.0) * t).rgb;
    vec3 res = e * 0.125;
    res += (a + c + g + i) * 0.03125;
    res += (b + d + f + h) * 0.0625;
    res += (j + k + l + m) * 0.125;
    gl_FragColor = vec4(res, 1.0);
  }
`;

// 9-tap tent upsample, additively blended into the larger mip.
const UP_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uRadius;
  void main(){
    vec2 t = uTexel * uRadius;
    vec3 s = texture2D(tDiffuse, vUv + vec2(-1.0, 1.0) * t).rgb * 1.0;
    s += texture2D(tDiffuse, vUv + vec2( 0.0, 1.0) * t).rgb * 2.0;
    s += texture2D(tDiffuse, vUv + vec2( 1.0, 1.0) * t).rgb * 1.0;
    s += texture2D(tDiffuse, vUv + vec2(-1.0, 0.0) * t).rgb * 2.0;
    s += texture2D(tDiffuse, vUv).rgb * 4.0;
    s += texture2D(tDiffuse, vUv + vec2( 1.0, 0.0) * t).rgb * 2.0;
    s += texture2D(tDiffuse, vUv + vec2(-1.0,-1.0) * t).rgb * 1.0;
    s += texture2D(tDiffuse, vUv + vec2( 0.0,-1.0) * t).rgb * 2.0;
    s += texture2D(tDiffuse, vUv + vec2( 1.0,-1.0) * t).rgb * 1.0;
    gl_FragColor = vec4(s / 16.0, 1.0);
  }
`;

// --------------------------------------------------------------- resolve ----
// AO + height fog + inscatter + volumetrics + bloom + camera motion blur, all
// still in HDR/linear so tonemapping downstream sees physically sane values.
const RESOLVE_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tScene, tDepth, tAO, tBloom, tShafts;
  uniform mat4 uProjInv, uViewInv, uPrevViewProj;
  uniform vec3 uCamPos, uSunDir, uSunColor, uFogColor, uFogColorGround;
  uniform vec2 uRes;
  uniform float uNear, uFar, uAOStrength, uBloomStrength, uExposure;
  uniform sampler2D tAdapt;
  uniform float uKeyValue, uEvMin, uEvMax;
  uniform float uFogDensity, uFogHeight, uFogHeightFalloff, uInscatter;
  uniform float uMotionScale, uFrame, uShaftStrength;
  uniform float uViewmodelDepthMax;   // viewmodel occupies [0, this] in depth
  uniform float uDebugAO;

  #define MB_SAMPLES 10

  vec3 worldPos(vec2 uv, float d){
    vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uProjInv * clip;
    v /= v.w;
    return (uViewInv * vec4(v.xyz, 1.0)).xyz;
  }
  float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

  void main(){
    float depth = texture2D(tDepth, vUv).r;
    vec3 wp = worldPos(vUv, depth);

    // The viewmodel is drawn by a different camera into a compressed depth
    // range, so unprojecting it with the world camera's matrices yields a
    // position centimetres from the eye and the reprojection velocity
    // saturates on every frame the player turns — the gun smeared to mush
    // whenever you looked around. Exclude it from motion blur entirely, which
    // is what engines do via a stencil bit.
    float isViewmodel = step(depth, uViewmodelDepthMax);

    // --- camera motion blur: reproject this pixel through last frame's VP ---
    vec4 prevClip = uPrevViewProj * vec4(wp, 1.0);
    vec2 prevUv = (prevClip.xy / max(abs(prevClip.w), 0.0001) * sign(prevClip.w)) * 0.5 + 0.5;
    vec2 vel = (vUv - prevUv) * uMotionScale * (1.0 - isViewmodel);
    float velLen = length(vel);
    vel = velLen > 0.06 ? vel * (0.06 / velLen) : vel;   // clamp streak length

    vec3 col;
    if (velLen > 0.0009) {
      float jitter = ign(gl_FragCoord.xy + uFrame * 7.13);
      vec3 acc = vec3(0.0);
      for (int i = 0; i < MB_SAMPLES; i++){
        float t = (float(i) + jitter) / float(MB_SAMPLES) - 0.5;
        acc += texture2D(tScene, clamp(vUv - vel * t, 0.0, 1.0)).rgb;
      }
      col = acc / float(MB_SAMPLES);
    } else {
      col = texture2D(tScene, vUv).rgb;
    }
    // From here down everything is display-referred: 1.0 is nominal white.
    float adaptedLum = max(texture2D(tAdapt, vec2(0.5)).r, 0.0002);
    float ev = uExposure * clamp(uKeyValue / adaptedLum, uEvMin, uEvMax);
    col *= ev;

    // --- ambient occlusion (attenuates ambient/indirect, floored so it darkens
    //     creases rather than crushing directly lit surfaces to black) ---
    float ao = texture2D(tAO, vUv).r;
    ao = mix(1.0, ao, uAOStrength * (1.0 - isViewmodel));
    col *= ao;
    // Debug: show the AO buffer directly so it can be verified rather than
    // assumed. Driven by postfx.params.debugAO.
    if (uDebugAO > 0.5) { gl_FragColor = vec4(vec3(texture2D(tAO, vUv).r), 1.0); return; }

    // --- exponential height fog with sun inscattering ---
    if (depth < 0.9999) {
      vec3 toCam = wp - uCamPos;
      float dist = length(toCam);
      vec3 dir = toCam / max(dist, 0.0001);
      // Analytic integral of density = exp(-(h - h0) * k) along the ray.
      float kh = max(uFogHeightFalloff, 0.0001);
      float hCam = uCamPos.y - uFogHeight;
      float dy = dir.y * dist;
      float baseD = uFogDensity * exp(-kh * hCam);
      float fogAmt = abs(dy) > 0.001
        ? baseD * (1.0 - exp(-kh * dy)) / (kh * dir.y)
        : baseD * dist;
      fogAmt = 1.0 - exp(-max(fogAmt, 0.0));
      float sunAmt = max(dot(dir, -uSunDir), 0.0);
      vec3 fogCol = mix(uFogColorGround, uFogColor, smoothstep(-0.1, 0.5, dir.y)) * ev;
      fogCol += uSunColor * pow(sunAmt, 8.0) * uInscatter * ev;
      col = mix(col, fogCol, clamp(fogAmt, 0.0, 1.0));
    }

    // --- volumetric shafts + bloom ---
    col += texture2D(tShafts, vUv).r * uSunColor * uShaftStrength * ev;
    col += texture2D(tBloom, vUv).rgb * uBloomStrength;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ----------------------------------------------------------------- grade ----
const GRADE_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tDiffuse;
  uniform vec2 uRes;
  uniform float uCA, uVignette, uVignetteSmooth, uGrain, uTime;
  uniform float uContrast, uSaturation, uTemperature, uTint;
  uniform vec3 uLift, uGammaC, uGain;
  uniform float uHurt;      // red flash / desaturation on damage
  uniform float uDirt;

  // ACES RRT+ODT fit (Stephen Hill).
  const mat3 ACESInput = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 ACESOutput = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  vec3 RRTAndODTFit(vec3 v){
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 ACESFitted(vec3 c){
    c = ACESInput * c;
    c = RRTAndODTFit(c);
    c = ACESOutput * c;
    return clamp(c, 0.0, 1.0);
  }

  float hash12(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Smoothly interpolated value noise. The previous dirt used floor()'d hash
  // cells directly, which drew a visible grid of flat squares over the frame.
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main(){
    vec2 c = vUv - 0.5;
    float r2 = dot(c, c);

    // Chromatic aberration: radial, scaled by r^2 so the centre stays clean.
    vec2 caOff = c * r2 * uCA;
    vec3 col;
    col.r = texture2D(tDiffuse, vUv - caOff).r;
    col.g = texture2D(tDiffuse, vUv).g;
    col.b = texture2D(tDiffuse, vUv + caOff).b;

    // White balance in a cheap approximation of LMS space.
    col.r *= 1.0 + uTemperature;
    col.b *= 1.0 - uTemperature;
    col.g *= 1.0 + uTint;

    col = ACESFitted(col);

    // Lift / gamma / gain, then contrast around 0.18 mid grey.
    col = col * uGain + uLift * (1.0 - col);
    col = pow(max(col, 0.0), 1.0 / max(uGammaC, vec3(0.001)));
    col = (col - 0.18) * uContrast + 0.18;

    float l = luma(col);
    col = mix(vec3(l), col, uSaturation);

    // Damage feedback: desaturate and push red into the periphery.
    if (uHurt > 0.001) {
      col = mix(col, vec3(l), uHurt * 0.30);
      col.r += uHurt * smoothstep(0.10, 0.42, r2) * 0.38;
    }

    // Lens dirt: smeared multi-scale smudges, only where the frame is bright.
    if (uDirt > 0.0) {
      vec2 dv = vUv * vec2(uRes.x / uRes.y, 1.0);
      float d = vnoise(dv * 7.0) * 0.6 + vnoise(dv * 19.0) * 0.3 + vnoise(dv * 43.0) * 0.1;
      d = smoothstep(0.52, 0.92, d);
      float bright = smoothstep(0.55, 1.0, l);
      col += d * uDirt * bright * 0.30;
    }

    // Vignette.
    float vig = smoothstep(uVignette, uVignette - uVignetteSmooth, sqrt(r2));
    col *= mix(1.0, vig, 0.5);

    col = max(col, 0.0);
    // Manual linear -> sRGB (the renderer's own conversion is off for post).
    vec3 srgb = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
    gl_FragColor = vec4(srgb, 1.0);
  }
`;

// --------------------------------------------------------------- sharpen ----
const SHARPEN_FRAG = /* glsl */`
  ${COMMON}
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uAmount, uGrain, uTime;

  float hash12(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main(){
    vec3 e = texture2D(tDiffuse, vUv).rgb;
    vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;
    vec3 s = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
    vec3 w = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;
    vec3 ea = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;
    // Contrast-adaptive: sharpen less where local contrast is already high.
    vec3 mn = min(min(min(n, s), min(w, ea)), e);
    vec3 mx = max(max(max(n, s), max(w, ea)), e);
    vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, 0.0001), 0.0, 1.0);
    amp = sqrt(amp);
    vec3 sharp = e * (1.0 + 4.0 * uAmount * amp) - (n + s + w + ea) * (uAmount * amp);

    // Film grain, applied AFTER sharpening so it isn't amplified, and sampled
    // on a ~1.6px lattice so it reads as emulsion rather than sensor noise.
    vec2 gp = floor(gl_FragCoord.xy / 1.6);
    float g = hash12(gp + fract(uTime) * 1000.0) - 0.5;
    float lum = luma(sharp);
    sharp += g * uGrain * (1.0 - smoothstep(0.0, 0.72, lum));

    gl_FragColor = vec4(clamp(sharp, 0.0, 1.0), 1.0);
  }
`;

const BLOOM_LEVELS = 6;

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.frame = 0;
    this.enabled = true;

    this.params = {
      // AO is a visibility term; multiplying past 1.0 is what punched contact
      // regions to pure black.
      // Contact-scale AO. 1.05 m was a large-scale occlusion radius that, with
      // the screen-space clamp above, resolved to nothing at all.
      aoRadius: 0.85, aoRadiusNear: 0.18, aoContactWeight: 1.6,
      aoIntensity: 1.9, aoBias: 0.018, aoStrength: 0.95,
      // evMax was 2.6, which was enough while every space was lit identically.
      // Now that interiors attenuate the sky IBL, a warehouse needs roughly 4x
      // to become readable, and the clamp — not the metering — was what kept it
      // black. evMin stays tight so looking at the sun still darkens properly.
      autoExposure: true, keyValue: 0.20, evMin: 0.35, evMax: 4.6, debugAO: false,
      adaptUpRate: 0.9, adaptDownRate: 2.6,
      // Bloom now actually does something: the sun disc and sky are authored
      // well above 1.0, so a real threshold + strength gives highlight glow
      // instead of ACES clipping flat to white.
      bloomThreshold: 1.15, bloomKnee: 0.55, bloomStrength: 0.22, bloomRadius: 1.2,
      // Exposure raised so the lit side sits in the middle of the curve rather
      // than down in the ACES toe, where the sun contribution was being crushed.
      exposure: 1.0, contrast: 1.14, saturation: 1.06,
      temperature: 0.004, tint: -0.003,
      // A committed split-tone: cool, slightly lifted shadows against warm
      // highlights. The previous values were a null grade.
      // A blue-only lift on top of crushed blacks is what turned every shadow
      // navy. The coolness belongs in the fill light, not the grade.
      lift: new THREE.Vector3(0.008, 0.007, 0.006),
      gammaC: new THREE.Vector3(1.0, 1.0, 1.0),
      gain: new THREE.Vector3(1.018, 1.00, 0.982),
      // CA was ~1.3px on top of 1-2px corrugation ribs, which read as rainbow
      // fringing on every metal wall. Sharpen was amplifying it further.
      // Corners were landing at 0.22 (-2.2 stops). A fast lens is about -0.4.
      ca: 0.0008, vignette: 1.05, vignetteSmooth: 0.35, grain: 0.030, dirt: 0.18,
      motionScale: 0.55, sharpen: 0.18,
      // 0.0072 fogged the 350 m backdrop by 92%, erasing the ground under it
      // and leaving the skyline blocks apparently levitating.
      // A 22 m fog scale height made the 350 m backdrop 50% fogged at its base
      // and barely fogged at its top, so every block's base dissolved into the
      // horizon haze and the top stayed dark — they read as levitating. An 80 m
      // scale height keeps a real height gradient without erasing the bases.
      fogDensity: 0.0020, fogHeight: 0.0, fogHeightFalloff: 0.012, inscatter: 0.34,
      shaftStrength: 0.5, shaftDensity: 0.72, shaftDecay: 0.965, shaftWeight: 0.06, shaftExposure: 0.9,
      hurt: 0.0,
    };

    this.sunDir = new THREE.Vector3(0, -1, 0);
    this.sunColor = new THREE.Color(1, 0.95, 0.85);
    this.fogColor = new THREE.Color(0.42, 0.52, 0.66);
    this.fogColorGround = new THREE.Color(0.28, 0.30, 0.33);

    /**
     * Optional second camera used to draw the first-person weapon.
     * Real engines render the viewmodel with its own (narrower) FOV and a
     * compressed depth range, so the weapon neither fisheyes at wide world FOV
     * nor intersects level geometry. Set by main.js.
     */
    this.viewmodelCamera = null;
    this.viewmodelDepthRange = 0.06;

    this._prevViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._tmpV3 = new THREE.Vector3();
    this._tmpV4 = new THREE.Vector4();

    this._buildTargets(1, 1);
    this._buildPasses();
  }

  _rt(w, h, opts = {}) {
    return new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      ...opts,
    });
  }

  _buildTargets(w, h) {
    this.width = w; this.height = h;

    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    this.sceneRT = this._rt(w, h, { depthBuffer: true, depthTexture: depth });
    this.depthTexture = depth;

    const aw = Math.max(1, w >> 1), ah = Math.max(1, h >> 1);
    this.aoRT = this._rt(aw, ah, { format: THREE.RedFormat, type: THREE.UnsignedByteType });
    this.aoBlurRT = this._rt(aw, ah, { format: THREE.RedFormat, type: THREE.UnsignedByteType });
    this.aoBlurRT2 = this._rt(aw, ah, { format: THREE.RedFormat, type: THREE.UnsignedByteType });

    const sw = Math.max(1, w >> 2), sh = Math.max(1, h >> 2);
    this.shaftRT = this._rt(sw, sh, { format: THREE.RedFormat });

    this.brightRT = this._rt(w >> 1, h >> 1);
    this.bloomDown = [];
    this.bloomUp = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const s = 2 << i;   // 2,4,8,...
      this.bloomDown.push(this._rt(w / s, h / s));
      this.bloomUp.push(this._rt(w / s, h / s));
    }

    // Auto-exposure metering chain: 64 -> 16 -> 4 -> 1, then a 1x1 ping-pong
    // holding the temporally adapted luminance.
    this.lumRT = this._rt(64, 64);
    this.lumReduce = [this._rt(16, 16), this._rt(4, 4), this._rt(1, 1)];
    this.adaptRT = [this._rt(1, 1), this._rt(1, 1)];
    this.adaptIndex = 0;

    this.resolveRT = this._rt(w, h);
    this.gradeRT = this._rt(w, h, { type: THREE.UnsignedByteType });
    this.smaaRT = this._rt(w, h, { type: THREE.UnsignedByteType });
  }

  _disposeTargets() {
    const all = [
      this.sceneRT, this.aoRT, this.aoBlurRT, this.aoBlurRT2, this.shaftRT,
      this.brightRT, this.resolveRT, this.gradeRT, this.smaaRT,
      this.lumRT, ...(this.lumReduce ?? []), ...(this.adaptRT ?? []),
      ...this.bloomDown, ...this.bloomUp,
    ];
    for (const t of all) t?.dispose();
    this.depthTexture?.dispose();
  }

  _mat(frag, uniforms) {
    return new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader: frag,
      depthTest: false, depthWrite: false,
    });
  }

  _buildPasses() {
    const U = THREE.UniformsUtils;

    this.aoMat = this._mat(AO_FRAG, {
      tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() },
      uProj: { value: new THREE.Matrix4() }, uRes: { value: new THREE.Vector2() },
      uRadius: { value: 0.9 }, uRadiusNear: { value: 0.18 }, uContactWeight: { value: 1.6 },
      uIntensity: { value: 1.2 }, uBias: { value: 0.03 },
      uNear: { value: 0.1 }, uFar: { value: 500 }, uFrame: { value: 0 },
    });
    this.aoResolveMat = this._mat(AO_RESOLVE_FRAG, {
      tAO: { value: null }, tDepth: { value: null },
      uRes: { value: new THREE.Vector2() },
      uNear: { value: 0.1 }, uFar: { value: 500 },
    });
    this.aoBlurMat = this._mat(AO_BLUR_FRAG, {
      tAO: { value: null }, tDepth: { value: null },
      uDir: { value: new THREE.Vector2(1, 0) }, uRes: { value: new THREE.Vector2() },
      uNear: { value: 0.1 }, uFar: { value: 500 },
    });
    this.shaftMat = this._mat(SHAFT_FRAG, {
      tDepth: { value: null }, uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
      uDensity: { value: 0.7 }, uDecay: { value: 0.96 }, uWeight: { value: 0.06 },
      uExposure: { value: 0.9 }, uFrame: { value: 0 }, uVisible: { value: 0 },
    });
    this.lumMat = this._mat(LUM_FRAG, { tScene: { value: null } });
    this.reduceMat = this._mat(REDUCE_FRAG, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this.adaptMat = this._mat(ADAPT_FRAG, {
      tMeasured: { value: null }, tPrev: { value: null },
      uDt: { value: 0.016 }, uUpRate: { value: 0.9 }, uDownRate: { value: 2.6 },
    });

    this.brightMat = this._mat(BRIGHT_FRAG, {
      tDiffuse: { value: null }, uThreshold: { value: 1.0 }, uKnee: { value: 0.6 },
      uExposure: { value: 1.0 }, tAdapt: { value: null },
      uKeyValue: { value: 0.20 }, uEvMin: { value: 0.35 }, uEvMax: { value: 2.6 },
    });
    this.downMat = this._mat(DOWN_FRAG, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this.upMat = this._mat(UP_FRAG, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 },
    });
    this.upMat.blending = THREE.AdditiveBlending;

    this.resolveMat = this._mat(RESOLVE_FRAG, {
      tScene: { value: null }, tDepth: { value: null }, tAO: { value: null },
      tBloom: { value: null }, tShafts: { value: null },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uFogColor: { value: new THREE.Vector3(0.4, 0.5, 0.65) },
      uFogColorGround: { value: new THREE.Vector3(0.28, 0.3, 0.33) },
      uRes: { value: new THREE.Vector2() },
      uNear: { value: 0.1 }, uFar: { value: 500 },
      uAOStrength: { value: 0.9 }, uBloomStrength: { value: 0.06 },
      uExposure: { value: 1.0 }, tAdapt: { value: null },
      uKeyValue: { value: 0.20 }, uEvMin: { value: 0.35 }, uEvMax: { value: 2.6 },
      uFogDensity: { value: 0.008 }, uFogHeight: { value: 0 },
      uFogHeightFalloff: { value: 0.05 }, uInscatter: { value: 0.5 },
      uMotionScale: { value: 0.5 }, uFrame: { value: 0 }, uShaftStrength: { value: 0.5 },
      uViewmodelDepthMax: { value: 0.06 }, uDebugAO: { value: 0 },
    });

    this.gradeMat = this._mat(GRADE_FRAG, {
      tDiffuse: { value: null }, uRes: { value: new THREE.Vector2() },
      uCA: { value: 0.003 }, uVignette: { value: 0.8 },
      uVignetteSmooth: { value: 0.5 }, uGrain: { value: 0.03 }, uTime: { value: 0 },
      uContrast: { value: 1.05 }, uSaturation: { value: 1.05 },
      uTemperature: { value: 0.01 }, uTint: { value: 0 },
      uLift: { value: new THREE.Vector3() }, uGammaC: { value: new THREE.Vector3(1, 1, 1) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      uHurt: { value: 0 }, uDirt: { value: 0.2 },
    });

    this.sharpenMat = this._mat(SHARPEN_FRAG, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uAmount: { value: 0.3 },
      uGrain: { value: 0.03 }, uTime: { value: 0 },
    });

    this.quad = new FullScreenQuad(null);
    this.smaa = new SMAAPass();
  }

  /**
   * Force eye adaptation to converge immediately.
   *
   * Capture and measurement tools need the exposure a player would settle at,
   * but adaptation takes 1-3 s. Freezing it instead makes every screenshot show
   * an exposure the game never actually displays. Running the metering chain
   * with an effectively infinite dt converges it in one frame.
   */
  snapExposure() {
    this._snapExposure = true;
  }

  setSize(w, h) {
    if (w === this.width && h === this.height) return;
    this._disposeTargets();
    this._buildTargets(w, h);
    this.smaa.setSize(w, h);
  }

  /** Draw a fullscreen pass, clearing the target first. */
  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.quad.render(this.renderer);
  }

  /**
   * Draw a fullscreen pass *without* clearing, so additive blending accumulates
   * into whatever the target already holds. Requires renderer.autoClear=false —
   * FullScreenQuad.render() goes through WebGLRenderer.render(), which would
   * otherwise clear the target and silently destroy the bloom mip chain.
   */
  _blitAdd(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  /** Where the sun projects to in NDC, and whether it's on screen at all. */
  _sunScreen(camera) {
    const p = this._tmpV3.copy(camera.position).addScaledVector(this.sunDir, -1000);
    const v = this._tmpV4.set(p.x, p.y, p.z, 1).applyMatrix4(this._viewProj);
    if (v.w <= 0) return { uv: null, visible: 0 };
    const x = (v.x / v.w) * 0.5 + 0.5;
    const y = (v.y / v.w) * 0.5 + 0.5;
    // Fade the effect out as the sun leaves the frustum so shafts don't pop.
    const m = 0.35;
    const fx = 1 - THREE.MathUtils.smoothstep(Math.max(0, Math.max(-x, x - 1)), 0, m);
    const fy = 1 - THREE.MathUtils.smoothstep(Math.max(0, Math.max(-y, y - 1)), 0, m);
    return { uv: [x, y], visible: fx * fy };
  }

  render(dt, elapsed) {
    const r = this.renderer, cam = this.camera, P = this.params;
    const w = this.width, h = this.height;
    this.frame++;

    cam.updateMatrixWorld();
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    // We drive clears explicitly for the whole chain so the additive bloom
    // upsample can accumulate. Restored before returning.
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    // ---- 1. scene -> HDR + depth ----
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, true);
    r.render(this.scene, cam);

    // ---- 1b. viewmodel, on its own layer, own FOV, compressed depth range --
    // Squeezing the weapon into the front 6% of the depth buffer guarantees it
    // draws in front of the world without clearing depth — so AO, fog and
    // motion blur downstream still see the world's real depth everywhere else.
    if (this.viewmodelCamera) {
      const gl = r.getContext();
      const bg = this.scene.background;
      const prevShadowAuto = r.shadowMap.autoUpdate;
      this.scene.background = null;          // don't repaint the sky over the scene
      r.shadowMap.autoUpdate = false;        // shadow maps are already up to date
      gl.depthRange(0.0, this.viewmodelDepthRange);
      r.render(this.scene, this.viewmodelCamera);
      gl.depthRange(0.0, 1.0);
      r.shadowMap.autoUpdate = prevShadowAuto;
      this.scene.background = bg;
    }

    if (!this.enabled) {
      r.setRenderTarget(null);
      this.gradeMat.uniforms.tDiffuse.value = this.sceneRT.texture;
      this._applyGradeUniforms(elapsed);
      this.quad.material = this.gradeMat;
      this.quad.render(r);
      return;
    }

    // ---- 2. HBAO ----
    const au = this.aoMat.uniforms;
    au.tDepth.value = this.depthTexture;
    au.uProjInv.value.copy(cam.projectionMatrixInverse);
    au.uProj.value.copy(cam.projectionMatrix);
    au.uRes.value.set(w >> 1, h >> 1);
    au.uRadius.value = P.aoRadius;
    au.uRadiusNear.value = P.aoRadiusNear;
    au.uContactWeight.value = P.aoContactWeight;
    au.uIntensity.value = P.aoIntensity;
    au.uBias.value = P.aoBias;
    au.uNear.value = cam.near; au.uFar.value = cam.far;
    au.uFrame.value = this.frame % 64;
    this._blit(this.aoMat, this.aoRT);

    const rv = this.aoResolveMat.uniforms;
    rv.tAO.value = this.aoRT.texture;
    rv.tDepth.value = this.depthTexture;
    rv.uRes.value.set(w >> 1, h >> 1);
    rv.uNear.value = cam.near; rv.uFar.value = cam.far;
    this._blit(this.aoResolveMat, this.aoBlurRT);

    const bu = this.aoBlurMat.uniforms;
    bu.tDepth.value = this.depthTexture;
    bu.uRes.value.set(w >> 1, h >> 1);
    bu.uNear.value = cam.near; bu.uFar.value = cam.far;
    bu.tAO.value = this.aoBlurRT.texture; bu.uDir.value.set(1, 0);
    this._blit(this.aoBlurMat, this.aoRT);
    bu.tAO.value = this.aoRT.texture; bu.uDir.value.set(0, 1);
    this._blit(this.aoBlurMat, this.aoBlurRT2);

    // ---- 3. volumetric shafts ----
    const sun = this._sunScreen(cam);
    const su = this.shaftMat.uniforms;
    su.tDepth.value = this.depthTexture;
    su.uVisible.value = sun.visible * (P.shaftStrength > 0 ? 1 : 0);
    if (sun.uv) su.uSunUV.value.set(sun.uv[0], sun.uv[1]);
    su.uDensity.value = P.shaftDensity;
    su.uDecay.value = P.shaftDecay;
    su.uWeight.value = P.shaftWeight;
    su.uExposure.value = P.shaftExposure;
    su.uFrame.value = this.frame % 64;
    this._blit(this.shaftMat, this.shaftRT);

    // ---- 3b. auto-exposure metering ----
    this.lumMat.uniforms.tScene.value = this.sceneRT.texture;
    this._blit(this.lumMat, this.lumRT);
    let lumSrc = this.lumRT;
    for (const target of this.lumReduce) {
      this.reduceMat.uniforms.tDiffuse.value = lumSrc.texture;
      this.reduceMat.uniforms.uTexel.value.set(1 / lumSrc.width, 1 / lumSrc.height);
      this._blit(this.reduceMat, target);
      lumSrc = target;
    }
    const prevAdapt = this.adaptRT[this.adaptIndex];
    const nextAdapt = this.adaptRT[this.adaptIndex ^ 1];
    this.adaptMat.uniforms.tMeasured.value = lumSrc.texture;
    this.adaptMat.uniforms.tPrev.value = prevAdapt.texture;
    // A one-frame snap uses a huge dt so the exponential converges fully.
    this.adaptMat.uniforms.uDt.value = this._snapExposure ? 100.0 : Math.min(dt, 0.1);
    this._snapExposure = false;
    this.adaptMat.uniforms.uUpRate.value = P.adaptUpRate;
    this.adaptMat.uniforms.uDownRate.value = P.adaptDownRate;
    this._blit(this.adaptMat, nextAdapt);
    this.adaptIndex ^= 1;
    const adaptTex = P.autoExposure ? nextAdapt.texture : null;

    // ---- 4. bloom ----
    this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
    this.brightMat.uniforms.tAdapt.value = nextAdapt.texture;
    this.brightMat.uniforms.uKeyValue.value = P.autoExposure ? P.keyValue : 0;
    this.brightMat.uniforms.uEvMin.value = P.autoExposure ? P.evMin : 1;
    this.brightMat.uniforms.uEvMax.value = P.autoExposure ? P.evMax : 1;
    this.brightMat.uniforms.uThreshold.value = P.bloomThreshold;
    this.brightMat.uniforms.uKnee.value = P.bloomKnee;
    this.brightMat.uniforms.uExposure.value = P.exposure;
    this._blit(this.brightMat, this.brightRT);

    let src = this.brightRT;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.downMat.uniforms.tDiffuse.value = src.texture;
      this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._blit(this.downMat, this.bloomDown[i]);
      src = this.bloomDown[i];
    }
    // Upsample: start at the smallest mip, tent-blur it up and add into the next
    // larger one, so every scale contributes rather than only the smallest.
    for (let i = BLOOM_LEVELS - 1; i >= 0; i--) {
      const target = i === 0 ? this.brightRT : this.bloomDown[i - 1];
      this.upMat.uniforms.tDiffuse.value = this.bloomDown[i].texture;
      this.upMat.uniforms.uTexel.value.set(1 / this.bloomDown[i].width, 1 / this.bloomDown[i].height);
      this.upMat.uniforms.uRadius.value = P.bloomRadius;
      this._blitAdd(this.upMat, target);
    }

    // ---- 5. resolve ----
    const ru = this.resolveMat.uniforms;
    ru.tScene.value = this.sceneRT.texture;
    ru.tDepth.value = this.depthTexture;
    ru.tAO.value = this.aoBlurRT2.texture;
    ru.tBloom.value = this.brightRT.texture;
    ru.tShafts.value = this.shaftRT.texture;
    ru.uProjInv.value.copy(cam.projectionMatrixInverse);
    ru.uViewInv.value.copy(cam.matrixWorld);
    ru.uPrevViewProj.value.copy(this._prevViewProj);
    ru.uCamPos.value.copy(cam.position);
    ru.uSunDir.value.copy(this.sunDir);
    ru.uSunColor.value.set(this.sunColor.r, this.sunColor.g, this.sunColor.b);
    ru.uFogColor.value.set(this.fogColor.r, this.fogColor.g, this.fogColor.b);
    ru.uFogColorGround.value.set(this.fogColorGround.r, this.fogColorGround.g, this.fogColorGround.b);
    ru.uRes.value.set(w, h);
    ru.uNear.value = cam.near; ru.uFar.value = cam.far;
    ru.uExposure.value = P.exposure;
    ru.tAdapt.value = nextAdapt.texture;
    // With auto-exposure off, force the EV multiplier to exactly 1.
    ru.uKeyValue.value = P.autoExposure ? P.keyValue : 0;
    ru.uEvMin.value = P.autoExposure ? P.evMin : 1;
    ru.uEvMax.value = P.autoExposure ? P.evMax : 1;
    ru.uAOStrength.value = P.aoStrength;
    ru.uBloomStrength.value = P.bloomStrength;
    ru.uFogDensity.value = P.fogDensity;
    ru.uFogHeight.value = P.fogHeight;
    ru.uFogHeightFalloff.value = P.fogHeightFalloff;
    ru.uInscatter.value = P.inscatter;
    ru.uMotionScale.value = P.motionScale * Math.min(2, dt > 0 ? (1 / 60) / dt : 1);
    ru.uShaftStrength.value = P.shaftStrength;
    ru.uViewmodelDepthMax.value = this.viewmodelCamera ? this.viewmodelDepthRange * 1.02 : -1.0;
    ru.uDebugAO.value = P.debugAO ? 1 : 0;
    ru.uFrame.value = this.frame % 64;
    this._blit(this.resolveMat, this.resolveRT);

    // ---- 6. grade ----
    this.gradeMat.uniforms.tDiffuse.value = this.resolveRT.texture;
    this._applyGradeUniforms(elapsed);
    this._blit(this.gradeMat, this.gradeRT);

    // ---- 7. SMAA -> 8. sharpen -> screen ----
    this.smaa.renderToScreen = false;
    this.smaa.render(r, this.smaaRT, this.gradeRT, dt, false);

    this.sharpenMat.uniforms.tDiffuse.value = this.smaaRT.texture;
    this.sharpenMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.sharpenMat.uniforms.uAmount.value = P.sharpen;
    this.sharpenMat.uniforms.uGrain.value = P.grain;
    this.sharpenMat.uniforms.uTime.value = elapsed;
    this.quad.material = this.sharpenMat;
    r.setRenderTarget(null);
    r.clear(true, false, false);
    this.quad.render(r);

    this._prevViewProj.copy(this._viewProj);
    r.autoClear = prevAutoClear;
  }

  _applyGradeUniforms(elapsed) {
    const g = this.gradeMat.uniforms, P = this.params;
    g.uRes.value.set(this.width, this.height);
    g.uCA.value = P.ca;
    g.uVignette.value = P.vignette;
    g.uVignetteSmooth.value = P.vignetteSmooth;
    g.uGrain.value = P.grain;
    g.uTime.value = elapsed;
    g.uContrast.value = P.contrast;
    g.uSaturation.value = P.saturation;
    g.uTemperature.value = P.temperature;
    g.uTint.value = P.tint;
    g.uLift.value.copy(P.lift);
    g.uGammaC.value.copy(P.gammaC);
    g.uGain.value.copy(P.gain);
    g.uHurt.value = P.hurt;
    g.uDirt.value = P.dirt;
  }

  dispose() {
    this._disposeTargets();
    this.quad.dispose();
    this.smaa.dispose?.();
  }
}
