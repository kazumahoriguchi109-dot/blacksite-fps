#!/usr/bin/env node
/*
 * Crop and upscale a region of a PNG, so a reviewer (human or model) can
 * actually see whether a finger closes. A full-frame 1600x900 capture renders
 * the hands about 200 px tall, which is not enough to judge anything.
 *
 *   node scripts/crop.mjs in.png out.png x y w h [scale]
 *
 * Uses a headless Chrome canvas rather than an image library so the repo keeps
 * its zero-extra-dependency rule.
 */
import puppeteer from 'puppeteer';
import { readFile, writeFile } from 'node:fs/promises';

const [inPath, outPath, X, Y, W, H, S = '3'] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: crop.mjs in.png out.png x y w h [scale]');
  process.exit(1);
}
const src = await readFile(inPath);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const url = await page.evaluate(async (b64, x, y, w, h, s) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * s; c.height = h * s;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, x, y, w, h, 0, 0, w * s, h * s);
  return c.toDataURL('image/png');
}, src.toString('base64'), +X, +Y, +W, +H, +S);
await writeFile(outPath, Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
console.log(`> ${outPath}  (${W}x${H} @${S}x)`);
