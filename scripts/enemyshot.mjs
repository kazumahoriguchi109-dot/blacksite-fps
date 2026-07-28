import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1400,height:900});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3000));

const setup = async (dist, poseName) => {
  await p.evaluate((dist)=>{
    const g=window.__game, pl=g.player, V=pl.position.constructor;
    // Clear ground well away from geometry, sun to the side.
    pl.position.set(0, 0.02, 8); pl.yaw=0; pl.pitch=0.0;
    for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons.update(1/120,g);}
    g.ai.spawnWave(3);
    // Freeze the director, or the live loop walks them away from the mark
    // during the settle and every labelled distance is wrong.
    if (!g.ai.__frozen) { g.ai.__realUpdate = g.ai.update.bind(g.ai); g.ai.update = () => {}; g.ai.__frozen = true; }
    const alive=g.ai.enemies.filter(e=>e.alive);
    // Park them in front of the camera at a known distance, facing the player.
    alive.slice(0,3).forEach((e,i)=>{
      const x=(i-1)*1.5;
      e.root.position.set(x, 0.0, 8-dist);
      e.root.rotation.y = Math.PI;
      if (e.position) e.position.copy(e.root.position);
    });
    for(let i=0;i<90;i++) g.ai.__realUpdate?.(1/120,g);
    // Re-park in case the AI walked them off.
    alive.slice(0,3).forEach((e,i)=>{
      const x=(i-1)*1.5;
      e.root.position.set(x, 0.0, 8-dist);
      e.root.rotation.y = Math.PI;
    });
  }, dist);
  await new Promise(r=>setTimeout(r,700));
  await p.screenshot({path:`shots/dbg/${poseName}.png`});
};

await setup(4, 'E1_enemy_close');
await setup(12, 'E2_enemy_mid');

const info = await p.evaluate(()=>{
  const g=window.__game, e=g.ai.enemies.find(x=>x.alive);
  if(!e) return null;
  let meshes=0, tris=0, mats=new Set();
  e.root.traverse(o=>{ if(o.isMesh){meshes++; const q=o.geometry; tris+=((q.index?q.index.count:q.attributes.position.count)/3)|0; mats.add(o.material.uuid);} });
  const box = new (Object.getPrototypeOf(g.scene).constructor===Object?Object:Object)();
  return {meshes, tris, materials:mats.size, health:e.health, state:e.state,
          y:+e.root.position.y.toFixed(2), zones:e.getHitZones?.()?.length};
});
console.log('enemy', JSON.stringify(info));
await b.close();
