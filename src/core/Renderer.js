import * as THREE from 'three';

/**
 * Renderer wrapper. Owns the WebGL2 context and the quality tier.
 *
 * Note: tone mapping is deliberately NoToneMapping here — the composite pass in
 * PostFX does ACES + grading itself so it can operate on the HDR buffer with
 * bloom already added, which is the correct order and what shipped engines do.
 */
export class Renderer {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,           // SMAA in the post chain instead
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    const gl = this.renderer.getContext();
    this.caps = {
      webgl2: this.renderer.capabilities.isWebGL2,
      maxAniso: this.renderer.capabilities.getMaxAnisotropy(),
      floatBlend: !!gl.getExtension('EXT_float_blend'),
      colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    };

    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated in r185 and silently falls back to PCF.
    // r185's PCF already samples a Vogel disc rotated by interleaved gradient
    // noise, so real softness comes from light.shadow.radius, not from the type.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    // Render scale lets us trade resolution for framerate without touching CSS size.
    this.renderScale = 1.0;
    this.maxPixelRatio = 2.0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  get domElement() { return this.renderer.domElement; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.width = w; this.height = h;
    this.pixelRatio = dpr * this.renderScale;
    this.bufferWidth = Math.max(1, Math.floor(w * this.pixelRatio));
    this.bufferHeight = Math.max(1, Math.floor(h * this.pixelRatio));
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, true);
    this.onResize?.(this.bufferWidth, this.bufferHeight);
  }

  setRenderScale(s) {
    this.renderScale = THREE.MathUtils.clamp(s, 0.5, 1.0);
    this.resize();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
