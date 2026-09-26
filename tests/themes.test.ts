import { test } from 'node:test';
import { expect } from '@std/expect';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { readJSON, readText } from './test-utils.ts';
const ids = ['midnight','plum','ocean','sand','lavender','ice'];
const css = readText('public/ui/styles/themes.css');
const blocks = [...css.matchAll(/:root(?:\[data-theme="([^"]+)"\])?\s*\{([^}]+)\}/g)];
const tokens = (body:string) => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]+);/g)].map(m=>[m[1]!,m[2]!]));
function luminance(hex:string) {
  const rgb = [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);
  return rgb[0]!*.2126+rgb[1]!*.7152+rgb[2]!*.0722;
}
function contrast(a:string,b:string) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
test('new themes define every semantic token and maintain normal text contrast',()=>{
  const required=Object.keys(tokens(blocks[0]![2]!)).sort();
  for(const id of ids) {
    const t=tokens(blocks.find(m=>m[1]===id)![2]!);
    expect(Object.keys(t).sort()).toEqual(required);
    for(const bg of ['paper','surface','column','hover','today','done']) {
      for(const fg of ['text','muted','accent','warning','done-text']) expect(contrast(t[fg]!,t[bg]!), `${id} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t['on-green']!,t.green!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['on-toast']!,t.toast!)).toBeGreaterThanOrEqual(4.5);
  }
});
test('all new themes restore before render, follow cross-tab changes and keep system defaults',async()=>{
  const source = transformSync(readText('public/theme.ts'), { loader: 'ts' }).code;
  for(const id of ids) {
    const attrs = new Map<string,string>(); const dataset:{theme?:string}={};
    const events=new Map<string,(e:{key?:string;newValue?:string|null;detail?:string})=>void>();
    let systemChanged=()=>{};
    const system={matches:false,addEventListener:(_name:string,callback:()=>void)=>{systemChanged=callback;}};
    runInNewContext(source,{localStorage:{getItem:()=>id},document:{documentElement:{dataset},querySelector:(selector:string)=>({setAttribute:(_name:string,value:string)=>attrs.set(selector,value)})},window:{matchMedia:()=>system,addEventListener:(name:string,fn:(e:object)=>void)=>events.set(name,fn)}});
    expect(dataset.theme).toBe(id);
    expect(attrs.get('link[rel="icon"]')).toContain('/'+id+'/favicon.svg');
    const manifest = readJSON('public/themes/'+id+'/manifest.webmanifest') as { theme_color: string };
    expect(attrs.get('meta[name="theme-color"]')).toBe(manifest.theme_color);
    events.get('storage')!({key:'taskpath-theme',newValue:'ocean'});expect(dataset.theme).toBe('ocean');
    events.get('storage')!({key:'taskpath-theme',newValue:null});expect(dataset.theme).toBe('light');
    system.matches=true;systemChanged();expect(dataset.theme).toBe('dark');
  }
});
