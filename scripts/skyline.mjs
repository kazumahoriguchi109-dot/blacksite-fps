import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:800,height:600});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await new Promise(r=>setTimeout(r,2500));
const out = await p.evaluate(()=>{
  const g=window.__game;
  const rows=[];
  g.world.root.traverse(o=>{
    if(!o.isMesh||!o.geometry?.boundingBox) return;
    const bb=o.geometry.boundingBox;
    const cxx=(bb.min.x+bb.max.x)/2, czz=(bb.min.z+bb.max.z)/2;
    const r=Math.hypot(cxx,czz);
    if(r<140) return;
    rows.push({ chunk:o.userData.chunk||o.name, r:+r.toFixed(0),
                minY:+bb.min.y.toFixed(2), maxY:+bb.max.y.toFixed(2),
                w:+(bb.max.x-bb.min.x).toFixed(0) });
  });
  rows.sort((a,b)=>a.r-b.r);
  return { count:rows.length, sample:rows.slice(0,14) };
});
console.log(JSON.stringify(out,null,1));
await b.close();
