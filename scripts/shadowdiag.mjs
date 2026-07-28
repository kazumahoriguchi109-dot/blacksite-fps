import puppeteer from 'puppeteer';
const b = await puppeteer.launch({
    protocolTimeout: 900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1280,height:720});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:240000,polling:400});
await new Promise(r=>setTimeout(r,3000));
const out = await p.evaluate(()=>{
  const g=window.__game, sun=g.sky?.sunLight;
  if(!sun) return {err:'no sun'};
  const t=sun.target;
  // Count how many objects the shadow camera frustum actually contains.
  return {
    lightPos: sun.position.toArray().map(v=>+v.toFixed(2)),
    targetPos: t ? t.position.toArray().map(v=>+v.toFixed(2)) : null,
    targetParent: t?.parent?.type ?? t?.parent?.name ?? 'NONE',
    targetInScene: (()=>{let f=false;g.scene.traverse(o=>{if(o===t)f=true});return f})(),
    targetMatrixWorldPos: t ? [t.matrixWorld.elements[12],t.matrixWorld.elements[13],t.matrixWorld.elements[14]].map(v=>+v.toFixed(2)) : null,
    lightMatrixWorldPos: [sun.matrixWorld.elements[12],sun.matrixWorld.elements[13],sun.matrixWorld.elements[14]].map(v=>+v.toFixed(2)),
    shadowMapExists: !!sun.shadow.map,
    shadowMapSize: sun.shadow.map ? [sun.shadow.map.width, sun.shadow.map.height] : null,
    shadowCam: {l:sun.shadow.camera.left,r:sun.shadow.camera.right,t:sun.shadow.camera.top,b:sun.shadow.camera.bottom,n:sun.shadow.camera.near,f:sun.shadow.camera.far},
    shadowAutoUpdate: g.renderer.shadowMap.autoUpdate,
    shadowNeedsUpdate: g.renderer.shadowMap.needsUpdate,
    shadowIntensity: sun.shadow.intensity,
    renderInfoShadowCalls: g.renderer.info.render.calls,
    // Does the level mesh material actually receive? check one
    sampleMesh: (()=>{let m=null;g.scene.traverse(o=>{if(!m&&o.isMesh&&o.name==='concrete_wall')m=o});
      return m? {name:m.name, cast:m.castShadow, recv:m.receiveShadow, matType:m.material.type, matName:m.material.name, visible:m.visible, mauto:m.matrixAutoUpdate} : null})(),
    meshNames: (()=>{const a=[];g.scene.traverse(o=>{if(o.isMesh&&a.length<20)a.push(o.name||o.type)});return a})(),
  };
});
console.log(JSON.stringify(out,null,2));
await b.close();
