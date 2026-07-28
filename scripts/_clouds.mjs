import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1600,height:900});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:240000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();document.getElementById('hud')?.remove();});
await new Promise(r=>setTimeout(r,2500));
await p.evaluate(()=>{const g=window.__game;const wg=g.weapons?.group||g.weapons?.root;if(wg)wg.visible=false;});
// yaw relative to the sun bearing so we get across-sun, toward-sun and away-from-sun skies
const sunYaw = await p.evaluate(()=>{const d=window.__game.sky.sunDirection;return Math.atan2(-d.x,-d.z);});
const shots = [['toward', sunYaw, 0.45],['across', sunYaw+Math.PI/2, 0.45],['away', sunYaw+Math.PI, 0.42],['high', sunYaw+2.2, 0.85]];
for(const [name,yaw,pitch] of shots){
  await p.evaluate((yaw,pitch)=>{const g=window.__game,pl=g.player;pl.position.set(8,0.02,14);pl.yaw=yaw;pl.pitch=pitch;
    for(let i=0;i<90;i++){pl.update(1/120,g);g.weapons?.update(1/120,g);}},yaw,pitch);
  await new Promise(r=>setTimeout(r,900));
  await p.screenshot({path:`shots/clouds/${name}.png`});
  console.log('shot', name);
}
console.log('fps-ish', await p.evaluate(()=>window.__game.renderer?.info?.render?.calls));
await b.close();
