import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1600,height:900});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,4000));

// Freeze adaptive resolution so we measure the real cost, not the DRS response.
await p.evaluate(()=>{ const g=window.__game; g.drs.enabled=false; g.rendererWrapper.setRenderScale(1.0); });

const measure = async (label, setup, arg) => {
  if (setup) await p.evaluate(setup, arg);
  await new Promise(r=>setTimeout(r,1500));             // let it settle / compile
  const r = await p.evaluate(()=>new Promise(res=>{
    const t=[]; let n=0; let last=performance.now();
    const tick=()=>{ const now=performance.now(); t.push(now-last); last=now; n++;
      if(n<180) requestAnimationFrame(tick);
      else { t.sort((a,b)=>a-b);
        const g=window.__game;
        res({ medianMs:+t[t.length>>1].toFixed(2), p95Ms:+t[Math.floor(t.length*0.95)].toFixed(2),
              fps:+(1000/t[t.length>>1]).toFixed(0),
              calls:g.renderer.info.render.calls, tris:g.renderer.info.render.triangles }); }
    };
    requestAnimationFrame(tick);
  }));
  console.log(label.padEnd(28), JSON.stringify(r));
  return r;
};

const setPose = (o) => {
  const g = window.__game, pl = g.player;
  pl.position.set(o.x, o.y, o.z); pl.yaw = o.yaw; pl.pitch = o.pitch;
  pl.velocity.set(0, 0, 0);
  for (let i = 0; i < 60; i++) { pl.update(1/120, g); g.weapons.update(1/120, g); }
};

await measure('spawn, no enemies', setPose, {x:0,y:0.02,z:16,yaw:0,pitch:-0.02});
await measure('across map, no enemies', setPose, {x:6,y:0.02,z:30,yaw:0,pitch:-0.02});
await measure('4 enemies (wave 1)', ()=>{ window.__game.ai.spawnWave(4); });
await measure('12 enemies', ()=>{ window.__game.ai.spawnWave(8); });
await measure('  + postfx off', ()=>{ window.__game.postfx.enabled=false; });
await measure('  + shadows off', ()=>{ window.__game.renderer.shadowMap.enabled=false; });
await measure('  postfx+shadows back', ()=>{ const g=window.__game; g.postfx.enabled=true; g.renderer.shadowMap.enabled=true; });

const info = await p.evaluate(()=>{
  const g=window.__game; let meshes=0,casters=0,enemyMeshes=0;
  g.scene.traverse(o=>{ if(o.isMesh){meshes++; if(o.castShadow)casters++;} });
  g.ai.root && g.ai.root.traverse(o=>{ if(o.isMesh)enemyMeshes++; });
  return {meshes,casters,enemyMeshes,lights:(()=>{let n=0;g.scene.traverse(o=>{if(o.isLight)n++});return n})(),
          shadowMap:g.sky.sunLight.shadow.mapSize.x};
});
console.log('scene', JSON.stringify(info));
await b.close();
