import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1280,height:720});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction(()=>!!window.__game,{timeout:300000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,3500));

const probe = async (label, x,z,yaw,pitch) => {
  await p.evaluate((o)=>{
    const g=window.__game, pl=g.player;
    pl.position.set(o.x,0.02,o.z); pl.yaw=o.yaw; pl.pitch=o.pitch;
    for(let i=0;i<60;i++){pl.update(1/120,g);g.weapons.update(1/120,g);}
  }, {x,z,yaw,pitch});
  await new Promise(r=>setTimeout(r,1600));   // let adaptation settle
  const v = await p.evaluate(()=>{
    const g=window.__game, r=g.renderer, fx=g.postfx;
    // Adapted luminance is a 1x1 half-float target; read it back directly.
    const rt = fx.adaptRT[fx.adaptIndex];
    const buf = new Float32Array(4);
    try { r.readRenderTargetPixels(rt, 0, 0, 1, 1, buf); } catch(e) { return {err:e.message}; }
    // Histogram of the final graded frame.
    const gr = fx.gradeRT, W=gr.width, H=gr.height;
    const px = new Uint8Array(W*H*4);
    r.readRenderTargetPixels(gr, 0, 0, W, H, px);
    let black=0, white=0; const lums=[];
    for (let i=0;i<px.length;i+=4){
      const L=(0.2126*px[i]+0.7152*px[i+1]+0.0722*px[i+2])/255;
      if(L<0.004) black++; if(L>0.996) white++;
      if((i>>2)%17===0) lums.push(L);
    }
    lums.sort((a,b)=>a-b);
    const q=(t)=>lums[Math.floor(t*(lums.length-1))];
    const n=W*H;
    return { adaptedLum:+buf[0].toFixed(4),
             pctBlack:+(100*black/n).toFixed(2), pctWhite:+(100*white/n).toFixed(2),
             p10:+q(0.10).toFixed(3), p50:+q(0.50).toFixed(3), p90:+q(0.90).toFixed(3) };
  });
  console.log(label.padEnd(22), JSON.stringify(v));
};

await probe('away from sun', 0, 16, 0, -0.02);
await probe('into sun',      10, 10, 1.83, 0.22);
await probe('across map',    4, 20, -0.42, 0.02);
await probe('looking down',  0, 16, 0, -0.55);
await b.close();
