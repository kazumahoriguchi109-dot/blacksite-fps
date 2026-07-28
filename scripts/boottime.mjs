import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1280,height:720});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
p.on('console',m=>{ if(m.type()==='error') console.log('[err]',m.text().slice(0,160)); });
const t0=Date.now();
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
let last='';
for(let i=0;i<180;i++){
  const s = await p.evaluate(()=>({m:document.getElementById('lmsg')?.textContent??'DONE', g:!!window.__game}));
  if(s.m!==last){ console.log(`${((Date.now()-t0)/1000).toFixed(1)}s  ${s.m}`); last=s.m; }
  if(s.g){ console.log(`${((Date.now()-t0)/1000).toFixed(1)}s  BOOTED`); break; }
  await new Promise(r=>setTimeout(r,2000));
}
const st = await p.evaluate(()=>{ const g=window.__game; if(!g) return null;
  return {tris:g.renderer.info.render.triangles, calls:g.renderer.info.render.calls}; });
console.log('stats', JSON.stringify(st));
await b.close();
