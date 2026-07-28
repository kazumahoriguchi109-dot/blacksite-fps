import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1400,height:800});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:400000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,4000));
// Stand close to a wall/floor junction — AO should be unmistakable here.
await p.evaluate(()=>{
  const g=window.__game,pl=g.player;
  pl.position.set(0,0.02,-15.2); pl.yaw=0; pl.pitch=-0.32;
  g.postfx.snapExposure?.();   // converge to THIS pose before freezing
  g.postfx.params.autoExposure=false;
  for(let i=0;i<80;i++){pl.update(1/120,g);g.weapons.update(1/120,g);}
});
await new Promise(r=>setTimeout(r,1200));
await p.screenshot({path:'shots/dbg/AO_normal.png'});
await p.evaluate(()=>{ window.__game.postfx.params.debugAO = true; });
await new Promise(r=>setTimeout(r,900));
await p.screenshot({path:'shots/dbg/AO_buffer.png'});

const stat = await p.evaluate(()=>{
  const g=window.__game, r=g.renderer, rt=g.postfx.aoBlurRT2;
  const buf=new Uint8Array(rt.width*rt.height*4);
  r.readRenderTargetPixels(rt,0,0,rt.width,rt.height,buf);
  let min=255,max=0,sum=0,n=0;
  for(let i=0;i<buf.length;i+=4){const v=buf[i];min=Math.min(min,v);max=Math.max(max,v);sum+=v;n++;}
  const P=g.postfx.params;
  return {aoMin:min, aoMax:max, aoMean:+(sum/n).toFixed(1),
          size:[rt.width,rt.height],
          params:{radius:P.aoRadius,intensity:P.aoIntensity,bias:P.aoBias,strength:P.aoStrength}};
});
console.log(JSON.stringify(stat));
await p.evaluate(()=>{ window.__game.postfx.params.debugAO = false; });
await b.close();
