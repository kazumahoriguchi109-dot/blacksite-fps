import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1100,height:1100});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,2500));

// Top-down: park the camera high and look straight down, hide the viewmodel.
await p.evaluate(()=>{
  const g=window.__game, pl=g.player;
  g.weapons.root.visible=false;
  pl.position.set(0, 120, 4);
  pl.yaw=0; pl.pitch=-Math.PI/2 + 0.001;
  pl.baseFov=70; pl.fov=70;
  for(let i=0;i<40;i++){ pl.update(1/120,g); }
  // Stop gravity dragging the camera back down.
  pl._integrate = ()=>{};
  for(let i=0;i<10;i++){ pl.update(1/120,g); }
  pl.position.set(0,120,4);
});
await new Promise(r=>setTimeout(r,900));
await p.screenshot({path:'shots/dbg/MAP_topdown.png'});

// A high oblique, which reads massing better than a pure plan view.
await p.evaluate(()=>{
  const g=window.__game, pl=g.player;
  pl.position.set(0, 58, 78); pl.yaw=0; pl.pitch=-0.62;
});
await new Promise(r=>setTimeout(r,900));
await p.screenshot({path:'shots/dbg/MAP_oblique.png'});

const bounds = await p.evaluate(()=>{
  const g=window.__game;
  const b=g.world.collider.geometry.boundingBox;
  return { min:[b.min.x|0,b.min.y|0,b.min.z|0], max:[b.max.x|0,b.max.y|0,b.max.z|0],
           spawns:g.world.spawnPoints.map(v=>[v.x,v.y,v.z]),
           enemySpawns:g.world.enemySpawns.length, cover:g.world.coverPoints?.length };
});
console.log(JSON.stringify(bounds));
await b.close();
