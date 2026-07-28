import puppeteer from 'puppeteer';
/*
 * Sweep sun azimuth/elevation and measure how much of each review pose is in
 * shadow. A composed daylight frame runs 40-60% shadow; the current setup
 * measures 17-33%, which is why the scene reads as a flatly lit inventory of
 * objects rather than a composition of light.
 *
 * Shadow fraction is measured by sun differencing: render the frame, render it
 * again with the sun zeroed, and count pixels that barely changed.
 */
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:960,height:540});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:400000,polling:400});
await p.evaluate(()=>{
  document.getElementById('overlay')?.classList.add('hidden');
  document.getElementById('loading')?.remove();
  window.__game.weapons.root.visible=false;
  window.__game.postfx.params.autoExposure=false;
});
await new Promise(r=>setTimeout(r,3000));

const POSES=[
  {name:'courtyard', pos:[4,0.02,20], yaw:-0.42, pitch:0.02},
  {name:'admin',     pos:[0,0.02,-14], yaw:0,     pitch:0.10},
  {name:'gate',      pos:[0,0.02,40],  yaw:Math.PI,pitch:-0.02},
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const grab=()=>p.evaluate(()=>{
  const g=window.__game,r=g.renderer,rt=g.postfx.gradeRT;
  const buf=new Uint8Array(rt.width*rt.height*4);
  r.readRenderTargetPixels(rt,0,0,rt.width,rt.height,buf);
  return Array.from(buf);
});

const measure = async () => {
  let shadowPct=0;
  for (const pose of POSES){
    await p.evaluate(o=>{const g=window.__game,pl=g.player;
      pl.position.set(o.pos[0],o.pos[1],o.pos[2]);pl.yaw=o.yaw;pl.pitch=o.pitch;pl.velocity.set(0,0,0);
      for(let i=0;i<50;i++)pl.update(1/120,g);},pose);
    await sleep(700);
    const lit=await grab();
    await p.evaluate(()=>{const s=window.__game.sky.sunLight;s.userData._i=s.intensity;s.intensity=0;});
    await sleep(700);
    const fill=await grab();
    await p.evaluate(()=>{const s=window.__game.sky.sunLight;s.intensity=s.userData._i;});
    let shaded=0,n=0;
    for(let i=0;i<lit.length;i+=4){
      const L=(lit[i]+lit[i+1]+lit[i+2])/765, F=(fill[i]+fill[i+1]+fill[i+2])/765;
      if (L>0.995) continue;               // sky
      n++; if (L-F < 0.035) shaded++;      // sun contributes almost nothing here
    }
    shadowPct += 100*shaded/Math.max(n,1);
  }
  return shadowPct/POSES.length;
};

const results=[];
for (const az of [130, 165, 200, 235, 270, 305]) {
  for (const tod of [0.905, 0.93]) {
    await p.evaluate(o=>{
      const g=window.__game;
      g.sky.params.sunAzimuthStart=o.az; g.sky.params.sunAzimuthEnd=o.az;
      g.sky.setTimeOfDay(o.tod);
    },{az,tod});
    await sleep(900);
    const shadow=await measure();
    const info=await p.evaluate(()=>({dir:window.__game.sky.sunDirection.toArray().map(v=>+v.toFixed(3)),
      elev:+(Math.asin(-window.__game.sky.sunDirection.y)*180/Math.PI).toFixed(1)}));
    results.push({az,tod,shadowPct:+shadow.toFixed(1),elev:info.elev,dir:info.dir});
    console.log(`az=${az} tod=${tod} elev=${info.elev} shadow=${shadow.toFixed(1)}%`);
  }
}
results.sort((a,b)=>Math.abs(50-a.shadowPct)-Math.abs(50-b.shadowPct));
console.log('\nbest (closest to 50% shadow):', JSON.stringify(results[0]));
await b.close();
