import puppeteer from 'puppeteer';
const b = await puppeteer.launch({protocolTimeout:900000,headless:true,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage();
await p.setViewport({width:1280,height:720});
await p.goto('http://127.0.0.1:5188',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__game,{timeout:240000,polling:400});
await p.evaluate(()=>{document.getElementById('overlay')?.classList.add('hidden');document.getElementById('loading')?.remove();});
await new Promise(r=>setTimeout(r,2500));
await p.evaluate(()=>{const g=window.__game;const wg=g.weapons?.group||g.weapons?.root;if(wg)wg.visible=false;});
await p.evaluate(()=>{const g=window.__game,pl=g.player;pl.position.set(10,0.02,6);pl.yaw=-1.35;pl.pitch=-0.34;for(let i=0;i<90;i++){pl.update(1/120,g);g.weapons?.update(1/120,g);}});
await new Promise(r=>setTimeout(r,900));
const patch=()=>p.evaluate(()=>{const g=window.__game,r=g.renderer,rt=g.postfx.gradeRT;const W=rt.width,H=rt.height;
 const x=Math.floor(W*0.06),y=Math.floor(H*0.30),w=Math.floor(W*0.44),h=Math.floor(H*0.26);
 const buf=new Uint8Array(w*h*4);r.readRenderTargetPixels(rt,x,y,w,h,buf);let R=0,G=0,B=0;const n=w*h;
 for(let i=0;i<buf.length;i+=4){R+=buf[i];G+=buf[i+1];B+=buf[i+2];}return [R/n/255,G/n/255,B/n/255].map(v=>+v.toFixed(4));});
const setL=(o)=>p.evaluate((o)=>{const g=window.__game;let hemi=null;g.scene.traverse(x=>{if(x.isHemisphereLight)hemi=x;});
 if(o.sun!==undefined)g.sky.sunLight.intensity=o.sun;
 if(o.hemi!==undefined&&hemi)hemi.intensity=o.hemi;
 if(o.env!==undefined)g.scene.environmentIntensity=o.env;
 if(o.hcol&&hemi)hemi.color.setRGB(o.hcol[0],o.hcol[1],o.hcol[2]);},o);
const lin=c=>c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);
const lum=c=>0.2126*lin(c[0])+0.7152*lin(c[1])+0.0722*lin(c[2]);
const sunSaved = await p.evaluate(()=>window.__game.sky.sunLight.intensity);
// LIT reference at the shipping env/hemi is meaningless; measure lit at each combo instead.
const HCOL = JSON.parse(process.env.HCOL||'[0.929,0.939,1.0]');
for(const env of [0.05,0.10,0.16,0.24]){
  for(const hi of [0.8,1.2,1.8,2.6]){
    await setL({env, hemi:hi, hcol:HCOL, sun:sunSaved}); await new Promise(r=>setTimeout(r,420));
    const L = await patch();
    await setL({sun:0}); await new Promise(r=>setTimeout(r,420));
    const F = await patch();
    const ratio = lum(L)/Math.max(lum(F),1e-6);
    console.log(`env=${env.toFixed(2)} hemi=${hi.toFixed(2)}  ratio=${ratio.toFixed(2)} stops=${Math.log2(ratio).toFixed(2)}  shadowBR=${(F[2]/Math.max(F[0],1e-4)).toFixed(2)} litBR=${(L[2]/L[0]).toFixed(2)}  lit=${JSON.stringify(L)} fill=${JSON.stringify(F)}`);
  }
}
await b.close();
