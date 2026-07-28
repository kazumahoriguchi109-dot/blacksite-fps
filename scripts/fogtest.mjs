import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1400,height:800});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3000));
await p.evaluate(()=>{
  const g=window.__game,pl=g.player;
  pl.position.set(0,10.9,-26); pl.yaw=Math.PI; pl.pitch=-0.10;
  for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons.update(1/120,g);}
});
await new Promise(r=>setTimeout(r,900));
await p.screenshot({path:'shots/dbg/G1_fog_on.png'});

await p.evaluate(()=>{ window.__game.postfx.params.fogDensity = 0; });
await new Promise(r=>setTimeout(r,700));
await p.screenshot({path:'shots/dbg/G2_fog_off.png'});

const info = await p.evaluate(()=>{
  const g=window.__game;
  // Is the 900 m ground plane actually in the scene, and where?
  let found=null, total=0;
  g.world.root.traverse(o=>{
    if(!o.isMesh||!o.geometry?.boundingBox) return;
    const bb=o.geometry.boundingBox; total++;
    const sx=bb.max.x-bb.min.x;
    if(sx>500) found={name:o.name, min:[bb.min.x|0,+bb.min.y.toFixed(2),bb.min.z|0],
                       max:[bb.max.x|0,+bb.max.y.toFixed(2),bb.max.z|0],
                       visible:o.visible, cast:o.castShadow};
  });
  // Where are the skyline blocks vertically?
  let lowest=1e9, highestBase=-1e9;
  g.world.root.traverse(o=>{
    if(!o.isMesh||!o.geometry?.boundingBox) return;
    const bb=o.geometry.boundingBox;
    const r=Math.hypot((bb.min.x+bb.max.x)/2,(bb.min.z+bb.max.z)/2);
    if(r>150 && r<450){ lowest=Math.min(lowest,bb.min.y); highestBase=Math.max(highestBase,bb.min.y); }
  });
  return { groundPlane:found, meshes:total, skylineMinY:+lowest.toFixed(2), skylineMaxBaseY:+highestBase.toFixed(2),
           far:g.camera.far };
});
console.log(JSON.stringify(info,null,1));
await b.close();
