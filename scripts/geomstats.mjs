import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1600,height:900});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await new Promise(r=>setTimeout(r,3000));
const out = await p.evaluate(()=>{
  const g=window.__game;
  const byMat={}; let total=0, meshes=0, casters=0;
  const lights={};
  g.scene.traverse(o=>{
    if(o.isLight){ lights[o.type]=(lights[o.type]||0)+1; }
    if(!o.isMesh||!o.geometry) return;
    meshes++;
    const pos=o.geometry.attributes.position;
    const t=(o.geometry.index?o.geometry.index.count:pos.count)/3;
    total+=t;
    if(o.castShadow) casters+=t;
    const n=(o.name||'?').split('#')[0];
    byMat[n]=(byMat[n]||0)+t;
  });
  const top=Object.entries(byMat).sort((a,b)=>b[1]-a[1]).slice(0,18)
    .map(([k,v])=>`${k}: ${(v/1000).toFixed(0)}k`);
  return { totalK:Math.round(total/1000), meshes, shadowCasterK:Math.round(casters/1000),
           lights, top,
           shadowMap:g.sky.sunLight.shadow.mapSize.x,
           envInt:g.scene.environmentIntensity };
});
console.log(JSON.stringify(out,null,1));
await b.close();
