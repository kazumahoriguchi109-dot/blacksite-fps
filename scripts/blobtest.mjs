import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1280,height:720});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:400000,polling:500});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3000));

const pose=()=>p.evaluate(()=>{const g=window.__game,pl=g.player;
  pl.spawn(g.world.spawnPoints[0],0); pl.position.set(4,0.02,18); pl.yaw=0; pl.pitch=-0.05;
  g.postfx.params.hurt=0; pl.health=100; pl.dead=false;
  for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons.update(1/120,g);}});

await pose(); await new Promise(r=>setTimeout(r,600));
await p.screenshot({path:'shots/dbg/N0_clean.png'});

// fire a burst
await p.evaluate(()=>{window.__game.input.down.add('Mouse0');});
await new Promise(r=>setTimeout(r,900));
await p.evaluate(()=>{window.__game.input.down.delete('Mouse0');});
await new Promise(r=>setTimeout(r,900));
await pose(); await new Promise(r=>setTimeout(r,400));
await p.screenshot({path:'shots/dbg/N1_afterfire.png'});

// hide each FX subsystem in turn
const hide = async (label, fn) => { await p.evaluate(fn); await new Promise(r=>setTimeout(r,500));
  await p.screenshot({path:`shots/dbg/${label}.png`}); };
await hide('N2_no_particles', ()=>{ const g=window.__game;
  g.fx.root.traverse(o=>{ if(o.isPoints||o.isMesh){ if(/particle|smoke|alpha|add/i.test(o.name||'')) o.visible=false; } }); });
await hide('N3_no_fxroot',    ()=>{ window.__game.fx.root.visible=false; });
await hide('N4_no_decals',    ()=>{ const g=window.__game; g.fx.root.visible=true;
  g.fx.decals && (g.fx.decals.root ? g.fx.decals.root.visible=false : 0);
  g.scene.traverse(o=>{ if(/decal/i.test(o.name||'')) o.visible=false; }); });

const info = await p.evaluate(()=>{
  const g=window.__game; const list=[];
  g.fx.root.traverse(o=>{ if(o.isMesh||o.isPoints) list.push(`${o.name||o.type} vis=${o.visible} blend=${o.material?.blending} depthW=${o.material?.depthWrite} tr=${o.material?.transparent}`); });
  const lights=[]; g.scene.traverse(o=>{if(o.isLight)lights.push(`${o.type}:${o.intensity.toFixed(1)}`)});
  return {fxChildren:list.slice(0,14), lights:lights.length, lightList:lights.slice(0,20)};
});
console.log(JSON.stringify(info,null,1));
await b.close();
