import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1400,height:800});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:400000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3500));
for (const az of [130, 200, 235, 270]) {
  await p.evaluate(a=>{
    const g=window.__game;
    g.sky.params.sunAzimuthStart=a; g.sky.params.sunAzimuthEnd=a;
    g.sky.setTimeOfDay(0.905);
    const pl=g.player; pl.position.set(4,0.02,20); pl.yaw=-0.42; pl.pitch=0.02;
    for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons.update(1/120,g);}
  }, az);
  await new Promise(r=>setTimeout(r,1400));
  await p.evaluate(()=>window.__game.postfx.snapExposure?.());
  await new Promise(r=>setTimeout(r,400));
  await p.screenshot({path:`shots/dbg/SUN_${az}.png`});
  console.log('captured az', az);
}
await b.close();
