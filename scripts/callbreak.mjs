import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1600,height:900});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3500));
await p.evaluate(()=>{const g=window.__game,pl=g.player;pl.position.set(4,0.02,20);pl.yaw=-0.42;pl.pitch=0.02;for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons.update(1/120,g);}});
await new Promise(r=>setTimeout(r,1200));

const out = await p.evaluate(()=>{
  const g=window.__game;
  const tri=(o)=>{const q=o.geometry;if(!q?.attributes?.position)return 0;return ((q.index?q.index.count:q.attributes.position.count)/3)|0;};
  const buckets = {};
  const add=(k,o)=>{ const t=tri(o); (buckets[k] ??= {meshes:0,tris:0,tiny:0}); buckets[k].meshes++; buckets[k].tris+=t; if(t<800) buckets[k].tiny++; };
  g.world.root.traverse(o=>{ if(o.isMesh && o.name!=='collider') add('level', o); });
  g.ai?.root?.traverse(o=>{ if(o.isMesh) add('enemies', o); });
  g.fx?.root?.traverse(o=>{ if(o.isMesh||o.isPoints) add('fx', o); });
  g.weapons?.root?.traverse(o=>{ if(o.isMesh) add('viewmodel', o); });
  // Level chunk histogram
  const hist=[0,0,0,0,0,0];
  const edges=[100,400,1000,4000,20000,1e9];
  const perMat={};
  g.world.root.traverse(o=>{
    if(!o.isMesh||o.name==='collider')return;
    const t=tri(o);
    for(let i=0;i<edges.length;i++){ if(t<edges[i]){hist[i]++;break;} }
    (perMat[o.name] ??= {n:0,tris:0}); perMat[o.name].n++; perMat[o.name].tris+=t;
  });
  const top=Object.entries(perMat).sort((a,b)=>b[1].n-a[1].n).slice(0,10)
    .map(([k,v])=>`${k}: ${v.n} meshes / ${(v.tris/1000).toFixed(0)}k`);
  return { render:{calls:g.renderer.info.render.calls, tris:g.renderer.info.render.triangles},
           buckets, chunkHistogram:{'<100':hist[0],'<400':hist[1],'<1k':hist[2],'<4k':hist[3],'<20k':hist[4],'20k+':hist[5]},
           topByMeshCount: top };
});
console.log(JSON.stringify(out,null,1));
await b.close();
