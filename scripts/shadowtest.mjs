import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1280,height:720});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:240000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,2500));

const pose = ()=>p.evaluate(()=>{
  const g=window.__game,pl=g.player;
  pl.position.set(0,10.9,-26); pl.yaw=Math.PI; pl.pitch=-0.25; pl.velocity.set(0,0,0);
  for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons?.update(1/120,g);}
});

await pose(); await new Promise(r=>setTimeout(r,600));
await p.screenshot({path:'shots/dbg/A_baseline.png'});

// A: widen the shadow frustum near/far
const r1 = await p.evaluate(()=>{
  const s=window.__game.sky.sunLight.shadow;
  s.camera.near=1; s.camera.far=400; s.camera.updateProjectionMatrix();
  window.__game.renderer.shadowMap.needsUpdate=true;
  return {n:s.camera.near,f:s.camera.far};
});
await new Promise(r=>setTimeout(r,800));
await p.screenshot({path:'shots/dbg/B_widefrustum.png'});

// B: kill ambient/env so only the sun lights the scene — shadows must show
await p.evaluate(()=>{
  const g=window.__game;
  g.scene.environment=null;
  g.scene.traverse(o=>{ if(o.isHemisphereLight) o.intensity=0; if(o.isPointLight) o.intensity=0; });
  g.scene.traverse(o=>{ if(o.isMesh && o.material && 'envMapIntensity' in o.material){o.material.envMapIntensity=0;o.material.needsUpdate=true;} });
});
await new Promise(r=>setTimeout(r,900));
await p.screenshot({path:'shots/dbg/C_sunonly.png'});

// C: does the shadow map contain anything? render depth of the shadow camera view
const r3 = await p.evaluate(()=>{
  const g=window.__game, sun=g.sky.sunLight;
  return { mapExists: !!sun.shadow.map, size: sun.shadow.map&&[sun.shadow.map.width,sun.shadow.map.height],
           calls: g.renderer.info.render.calls, shadowIntensity: sun.shadow.intensity,
           camNear: sun.shadow.camera.near, camFar: sun.shadow.camera.far,
           lightPos: sun.position.toArray().map(v=>+v.toFixed(1)),
           targetPos: sun.target.position.toArray().map(v=>+v.toFixed(1)) };
});
console.log('after:', JSON.stringify(r3));
await b.close();
