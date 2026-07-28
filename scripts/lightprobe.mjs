import puppeteer from 'puppeteer';
const b = await puppeteer.launch({
    protocolTimeout: 900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:800,height:450});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:240000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,2500));

// Sample the post-process output directly. The canvas has no
// preserveDrawingBuffer, so drawImage() would read back an empty buffer.
const probe = async (label) => {
  const v = await p.evaluate(()=>{
    const g=window.__game, r=g.renderer, rt=g.postfx.gradeRT;
    const W=rt.width, H=rt.height;
    const read=(fx,fy,fw,fh)=>{
      const x=Math.floor(W*fx), y=Math.floor(H*fy), w=Math.floor(W*fw), h=Math.floor(H*fh);
      const buf=new Uint8Array(w*h*4);
      r.readRenderTargetPixels(rt, x, y, w, h, buf);
      let a=0,b=0,c=0; const n=w*h;
      for(let i=0;i<buf.length;i+=4){a+=buf[i];b+=buf[i+1];c+=buf[i+2];}
      return [Math.round(a/n), Math.round(b/n), Math.round(c/n)];
    };
    // readRenderTargetPixels origin is bottom-left.
    return { ground: read(0.20,0.06,0.14,0.10),
             wallRight: read(0.78,0.50,0.10,0.12),
             sky: read(0.42,0.86,0.14,0.08) };
  });
  console.log(label, JSON.stringify(v));
};

await p.evaluate(()=>{
  const g=window.__game;
  let src=null; g.scene.traverse(o=>{if(!src&&o.isMesh&&o.material?.isMeshStandardMaterial&&!o.material.isMeshPhysicalMaterial)src=o.material;});
  const flat=src.clone();
  for(const k of ['map','normalMap','roughnessMap','metalnessMap','aoMap','alphaMap','emissiveMap','envMap']) flat[k]=null;
  flat.color.setRGB(0.32,0.32,0.32); flat.roughness=0.88; flat.metalness=0; flat.transparent=false; flat.alphaTest=0; flat.opacity=1; flat.needsUpdate=true;
  g.scene.traverse(o=>{ if(o.isMesh&&o.material&&!/^(rifle|smg|pistol)\./.test(o.name||'')&&o.name!=='collider') o.material=flat; });
  const pl=g.player; pl.position.set(6,0.02,30); pl.yaw=0; pl.pitch=-0.02;
  for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons?.update(1/120,g);}
});
await new Promise(r=>setTimeout(r,700)); await probe('baseline        ');

await p.evaluate(()=>{ window.__game.sky.sunLight.intensity=100; });
await new Promise(r=>setTimeout(r,700)); await probe('sun=100         ');

await p.evaluate(()=>{ window.__game.sky.sunLight.intensity=0; });
await new Promise(r=>setTimeout(r,700)); await probe('sun=0           ');

await p.evaluate(()=>{ const g=window.__game; g.sky.sunLight.intensity=9; g.scene.environment=null; g.scene.traverse(o=>{if(o.isHemisphereLight||o.isPointLight)o.intensity=0;}); });
await new Promise(r=>setTimeout(r,700)); await probe('sun=9 only      ');

await p.evaluate(()=>{ window.__game.sky.sunLight.castShadow=false; });
await new Promise(r=>setTimeout(r,700)); await probe('sun=9 noshadow  ');
await p.screenshot({path:'shots/dbg/L4_sunonly_noshadow.png'});

const info = await p.evaluate(()=>{
  const g=window.__game, s=g.sky.sunLight;
  return { visible:s.visible, inScene:(()=>{let f=false;g.scene.traverse(o=>{if(o===s)f=true});return f})(),
    layersMask:s.layers.mask, camLayersMask:g.camera.layers.mask,
    targetInScene:(()=>{let f=false;g.scene.traverse(o=>{if(o===s.target)f=true});return f})(),
    intensity:s.intensity, exposure:g.postfx.params.exposure };
});
console.log('info', JSON.stringify(info));
await b.close();
