import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1600,height:900});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3000));

const sample = async (label, setup) => {
  if (setup) await p.evaluate(setup);
  await new Promise(r=>setTimeout(r,2600));
  const v = await p.evaluate(()=>{
    const g=window.__game;
    return { fps:Math.round(g.fps), calls:g.renderer.info.render.calls,
             tris:g.renderer.info.render.triangles,
             progs:g.renderer.info.programs?.length ?? 0 };
  });
  console.log(String(label).padEnd(26), JSON.stringify(v));
  return v;
};

await p.evaluate(()=>{
  const g=window.__game,pl=g.player;
  pl.position.set(6,0.02,30); pl.yaw=0; pl.pitch=-0.02;
  for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons.update(1/120,g);}
  g.ai?.spawnWave?.(10);
});
await sample('baseline (10 enemies)');
await sample('postfx off',        ()=>{ window.__game.postfx.enabled=false; });
await sample('postfx on again',   ()=>{ window.__game.postfx.enabled=true; });
await sample('shadows off',       ()=>{ window.__game.renderer.shadowMap.enabled=false;
                                        window.__game.scene.traverse(o=>{if(o.isMesh)o.material && (o.material.needsUpdate=true)}); });
await sample('shadows on',        ()=>{ window.__game.renderer.shadowMap.enabled=true;
                                        window.__game.scene.traverse(o=>{if(o.isMesh)o.material && (o.material.needsUpdate=true)}); });
await sample('point lights off',  ()=>{ window.__game.scene.traverse(o=>{if(o.isPointLight){o.userData._i=o.intensity;o.intensity=0;o.visible=false;}}); });
await sample('point lights on',   ()=>{ window.__game.scene.traverse(o=>{if(o.isPointLight){o.intensity=o.userData._i??8;o.visible=true;}}); });
await sample('AI update off',     ()=>{ const g=window.__game; g._aiUpd=g.ai.update; g.ai.update=()=>{}; });
await sample('enemies hidden',    ()=>{ window.__game.ai.root && (window.__game.ai.root.visible=false); });
await sample('FX update off',     ()=>{ const g=window.__game; g._fxUpd=g.fx.update; g.fx.update=()=>{}; });
await sample('render scale 0.75', ()=>{ window.__game.rendererWrapper.setRenderScale(0.75); });

const counts = await p.evaluate(()=>{
  const g=window.__game; let meshes=0,lights=0,shadowCasters=0,mats=new Set();
  g.scene.traverse(o=>{ if(o.isMesh){meshes++; if(o.castShadow)shadowCasters++; if(o.material)mats.add(o.material.uuid);} if(o.isLight)lights++; });
  return {meshes,lights,shadowCasters,materials:mats.size,
          shadowMapSize:g.sky.sunLight.shadow.mapSize.x};
});
console.log('scene', JSON.stringify(counts));
await b.close();
