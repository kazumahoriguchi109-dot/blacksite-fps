// A function, not an object, purely so `base` can differ between dev and build.
// GitHub Pages serves a project site from /<repo>/, so the built asset URLs must
// carry that prefix — but applying it in dev would move the dev server to
// http://127.0.0.1:5188/blacksite-fps/ and break every script under scripts/,
// all of which fetch the root.
export default ({ command }) => ({
  base: command === 'build' ? '/blacksite-fps/' : '/',
  server: {
    port: 5188,
    host: '127.0.0.1',
    watch: {
      // Vite watches the whole project root. The capture harness writes
      // hundreds of PNGs into shots/ on every run, and each write was firing a
      // full page reload — which restarted texture generation from scratch and
      // made the game appear to never finish loading. Nothing under these paths
      // is ever imported by the app.
      ignored: [
        '**/shots/**',
        '**/scratchpad/**',
        '**/*.png',
        '**/*.log',
      ],
    },
  },
  build: { target: 'esnext', sourcemap: true },
  // Vite discovers these lazily and then force-reloads the page to re-optimise,
  // which made the game build the entire level TWICE on a cold start (~42 s and
  // a mid-boot reload that broke the capture harness). Declaring them up front
  // removes the reload entirely.
  optimizeDeps: {
    include: [
      'three',
      'three-mesh-bvh',
      'three/examples/jsm/postprocessing/Pass.js',
      'three/examples/jsm/postprocessing/SMAAPass.js',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
    ],
  },
});
