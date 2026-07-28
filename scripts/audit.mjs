import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:800,height:600});
const warns=[];
p.on('console',m=>{ const t=m.text(); if(/fallback|unavailable|unknown|not found|failed/i.test(t)) warns.push(t.slice(0,160)); });
p.on('pageerror',e=>warns.push('[pageerror] '+e.message.slice(0,160)));
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await new Promise(r=>setTimeout(r,3000));

const out = await p.evaluate(()=>{
  const g=window.__game;
  // Which materials actually ended up on level meshes, and are any of them
  // the shared concrete fallback standing in for something else?
  const byName = new Map();
  g.world.root.traverse(o=>{
    if(!o.isMesh||!o.material) return;
    const key = o.name;
    const m = o.material;
    if(!byName.has(key)) byName.set(key, { matName: m.name || '(unnamed)', uuid: m.uuid, count: 0 });
    byName.get(key).count++;
  });
  // Group meshes by the material instance they use — several distinct level
  // material names sharing ONE material instance means a silent fallback.
  const byUuid = new Map();
  for (const [name, v] of byName) {
    if(!byUuid.has(v.uuid)) byUuid.set(v.uuid, { matName: v.matName, names: [] });
    byUuid.get(v.uuid).names.push(name);
  }
  const collisions = [...byUuid.values()].filter(v => new Set(v.names).size > 1);

  // Surfaces referenced by the collider vs the known list.
  const ids = g.world.collider?.userData?.triSurfaces;
  const present = new Set();
  if (ids) for (let i=0;i<ids.length;i+=97) present.add(ids[i]);

  return {
    levelMeshNames: byName.size,
    materialInstances: byUuid.size,
    sharedInstances: collisions.map(c=>({ material:c.matName, usedBy:[...new Set(c.names)] })).slice(0,10),
    surfaceIdsInUse: [...present].sort((a,b)=>a-b),
    lights: (()=>{let n=0;g.scene.traverse(o=>{if(o.isLight)n++});return n})(),
    emissiveMeshes: (()=>{let n=0;g.scene.traverse(o=>{if(o.isMesh&&o.material?.emissiveIntensity>1)n++});return n})(),
  };
});
console.log(JSON.stringify(out,null,1));
console.log('\nconsole warnings:', warns.length ? warns.slice(0,10) : '(none)');
await b.close();
