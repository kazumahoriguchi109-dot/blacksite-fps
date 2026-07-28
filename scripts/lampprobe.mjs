import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1200,height:700});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3000));
// Stand in the middle of the warehouse.
await p.evaluate(()=>{const g=window.__game,pl=g.player;pl.position.set(32,0.02,10);pl.yaw=0;pl.pitch=0;for(let i=0;i<60;i++)pl.update(1/120,g);});
await new Promise(r=>setTimeout(r,1800));
const out = await p.evaluate(()=>{
  const g=window.__game, rig=g.lightRig, cam=g.camera;
  const virt = (rig?.virtual ?? []).map(v=>({
    d:+v.position.distanceTo(cam.position).toFixed(1),
    i:+v.intensity.toFixed(1), dist:+v.distance.toFixed(1), score:+v.score.toFixed(3),
  })).sort((a,b)=>a.d-b.d).slice(0,10);
  const slots = (rig?.slots ?? []).map(s=>+s.light.intensity.toFixed(2));
  return { virtualCount: rig?.virtual.length ?? 0, nearest: virt, slots,
           active: slots.filter(v=>v>0.01).length,
           indoor:+(g.indoor?.factor ?? -1).toFixed(2),
           maxRange: rig?.maxRange };
});
console.log(JSON.stringify(out,null,1));
await b.close();
