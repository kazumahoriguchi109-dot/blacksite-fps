import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:900,height:600});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await new Promise(r=>setTimeout(r,2500));
const out = await p.evaluate(()=>{
  const g=window.__game;
  g.ai.spawnWave(2);
  const e=g.ai.enemies.find(x=>x.alive);
  if(!e) return {err:'no enemy'};
  const mats=new Map();
  e.root.traverse(o=>{
    if(!o.isMesh||!o.material) return;
    const m=o.material;
    if(mats.has(m.uuid)) return;
    mats.set(m.uuid, {
      name:o.name||'?', type:m.type,
      color:[+m.color.r.toFixed(3),+m.color.g.toFixed(3),+m.color.b.toFixed(3)],
      rough:m.roughness, metal:m.metalness,
      envInt:m.envMapIntensity, hasMap:!!m.map, hasNormal:!!m.normalMap,
      hasAO:!!m.aoMap, hasMetalMap:!!m.metalnessMap, hasRoughMap:!!m.roughnessMap, uv1:!!o.geometry.attributes.uv1,
      emissive:m.emissive?[+m.emissive.r.toFixed(2),+m.emissive.g.toFixed(2),+m.emissive.b.toFixed(2)]:null,
      layers:o.layers.mask, cast:o.castShadow, recv:o.receiveShadow,
      mapColorSpace:m.map?m.map.colorSpace:null,
    });
  });
  return { materials:[...mats.values()], sceneEnv:!!g.scene.environment, envIntensity:g.scene.environmentIntensity };
});
console.log(JSON.stringify(out,null,1));
await b.close();
