import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:900,height:600});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3000));
const read = (label)=>p.evaluate((l)=>{
  const g=window.__game; let hemi=0;
  g.scene.traverse(o=>{if(o.isHemisphereLight)hemi=o.intensity;});
  return {l, ibl:+g.scene.environmentIntensity.toExponential(3), hemi:+hemi.toExponential(3),
          indoor:+(g.indoor?.factor??-1).toFixed(3), fog:+g.postfx.params.fogDensity.toExponential(2)};
}, label).then(v=>console.log(JSON.stringify(v)));

const go = (x,z)=>p.evaluate((o)=>{const g=window.__game,pl=g.player;pl.position.set(o.x,0.02,o.z);pl.velocity.set(0,0,0);},{x,z});

await go(4,20);  await new Promise(r=>setTimeout(r,1500)); await read('outdoor start');
await go(32,16); await new Promise(r=>setTimeout(r,1500)); await read('indoor 1.5s');
await new Promise(r=>setTimeout(r,4000));                  await read('indoor 5.5s');
await go(4,20);  await new Promise(r=>setTimeout(r,4000)); await read('outdoor again 4s');
await new Promise(r=>setTimeout(r,6000));                  await read('outdoor again 10s');
await b.close();
