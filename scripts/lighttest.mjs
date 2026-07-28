import puppeteer from 'puppeteer';
const b = await puppeteer.launch({
    protocolTimeout: 900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1280,height:720});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:240000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,2500));

// white-box + pose
await p.evaluate(()=>{
  const g=window.__game;
  let src=null; g.scene.traverse(o=>{if(!src&&o.isMesh&&o.material?.isMeshStandardMaterial&&!o.material.isMeshPhysicalMaterial)src=o.material;});
  const flat=src.clone();
  for(const k of ['map','normalMap','roughnessMap','metalnessMap','aoMap','alphaMap','emissiveMap','envMap']) flat[k]=null;
  flat.color.setRGB(0.32,0.32,0.32); flat.roughness=0.88; flat.metalness=0; flat.transparent=false; flat.alphaTest=0; flat.opacity=1; flat.needsUpdate=true;
  g.scene.traverse(o=>{ if(o.isMesh&&o.material&&!/^(rifle|smg|pistol)\./.test(o.name||'')&&o.name!=='collider') o.material=flat; });
  const pl=g.player; pl.position.set(6,0.02,30); pl.yaw=0; pl.pitch=-0.02;
  for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons?.update(1/120,g);}
});
await new Promise(r=>setTimeout(r,700));
await p.screenshot({path:'shots/dbg/L1_whitebox_shadowson.png'});

// shadows OFF
const info = await p.evaluate(()=>{
  const g=window.__game, sun=g.sky.sunLight;
  sun.castShadow=false;
  g.scene.traverse(o=>{if(o.isMesh)o.receiveShadow=false;});
  return {intensity:sun.intensity, color:[sun.color.r,sun.color.g,sun.color.b].map(v=>+v.toFixed(3)),
          dir: g.sky.sunDirection.toArray().map(v=>+v.toFixed(3)),
          pos: sun.position.toArray().map(v=>+v.toFixed(1)),
          target: sun.target.position.toArray().map(v=>+v.toFixed(1)),
          envInt: g.scene.environmentIntensity};
});
await new Promise(r=>setTimeout(r,700));
await p.screenshot({path:'shots/dbg/L2_whitebox_shadowsoff.png'});
console.log(JSON.stringify(info));

// sun only (no env, no hemi, no point)
await p.evaluate(()=>{
  const g=window.__game;
  g.scene.environment=null;
  g.scene.traverse(o=>{ if(o.isHemisphereLight||o.isPointLight) o.intensity=0; });
});
await new Promise(r=>setTimeout(r,700));
await p.screenshot({path:'shots/dbg/L3_sunonly_noshadow.png'});
await b.close();
