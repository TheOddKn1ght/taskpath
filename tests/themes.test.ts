import { test, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';
const ids = ['midnight','plum','ocean','sand','lavender','ice','mint','blush','paper','ember','forest','graphite'];
const css = await Bun.file('public/ui/styles/themes.css').text();
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
  const source=new Bun.Transpiler({loader:'ts'}).transformSync(await Bun.file('public/theme.ts').text());
  for(const id of ids) {
    const attrs = new Map<string,string>(); const dataset:{theme?:string}={};
    const events=new Map<string,(e:{key?:string;newValue?:string|null;detail?:string})=>void>();
    let systemChanged=()=>{};
    const system={matches:false,addEventListener:(_name:string,callback:()=>void)=>{systemChanged=callback;}};
    runInNewContext(source,{localStorage:{getItem:(key:string)=>key === "taskpath-theme" ? id : null},document:{documentElement:{dataset},querySelector:(selector:string)=>({setAttribute:(_name:string,value:string)=>attrs.set(selector,value)})},window:{matchMedia:()=>system,addEventListener:(name:string,fn:(e:object)=>void)=>events.set(name,fn)}});
    expect(dataset.theme).toBe(id);
    expect(attrs.get('link[rel="icon"]')).toContain('/'+id+'/favicon.svg');
    const manifest=await Bun.file('public/themes/'+id+'/manifest.webmanifest').json();
    expect(attrs.get('meta[name="theme-color"]')).toBe(manifest.theme_color);
    events.get('storage')!({key:'taskpath-theme',newValue:'ocean'});expect(dataset.theme).toBe('ocean');
    events.get('storage')!({key:'taskpath-theme',newValue:null});expect(dataset.theme).toBe('light');
    system.matches=true;systemChanged();expect(dataset.theme).toBe('dark');
  }
});

function themeRuntime(values: Record<string, string> = {}, unavailable = false) {
  const dataset: { theme?: string } = {};
  const attrs = new Map<string, string>();
  const events = new Map<string, (e: unknown) => void>();
  let changed = () => {};
  const system = { matches: false, addEventListener: (_: string, fn: () => void) => { changed = fn; } };
  const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(require('node:fs').readFileSync('public/theme.ts', 'utf8'));
  runInNewContext(source, {
    localStorage: { getItem: (key: string) => { if (unavailable) throw new Error('blocked'); return values[key] ?? null; } },
    document: { documentElement: { dataset }, querySelector: (selector: string) => ({ setAttribute: (_: string, value: string) => attrs.set(selector, value) }) },
    window: { matchMedia: () => system, addEventListener: (name: string, fn: (e: unknown) => void) => events.set(name, fn) },
  });
  return { dataset, attrs, emit: (name: string, event: unknown) => events.get(name)!(event), mode: (dark: boolean) => { system.matches = dark; changed(); } };
}
test('system theme pair restores, switches live, and preserves fixed theme choices', () => {
  const r = themeRuntime({ 'taskpath-theme-light': 'sand', 'taskpath-theme-dark': 'nord' });
  expect(r.dataset.theme).toBe('sand');
  r.mode(true);
  expect(r.dataset.theme).toBe('nord');
  expect(r.attrs.get('link[rel="icon"]')).toContain('/nord/');
  r.emit('taskpath-system-themes', { detail: { mode: 'dark', theme: 'ocean' } });
  expect(r.dataset.theme).toBe('ocean');
  r.emit('taskpath-theme', { detail: 'plum' });
  r.mode(false);
  r.emit('storage', { key: 'taskpath-theme-light', newValue: 'ice' });
  expect(r.dataset.theme).toBe('plum');
  r.emit('taskpath-theme', { detail: 'system' });
  expect(r.dataset.theme).toBe('ice');
  r.emit('storage', { key: null, newValue: null });
  expect(r.dataset.theme).toBe('light');
  r.mode(true);
  expect(r.dataset.theme).toBe('dark');
});
test('invalid or mismatched system themes and inaccessible storage use safe defaults', () => {
  for (const r of [themeRuntime({ 'taskpath-theme-light': 'nord', 'taskpath-theme-dark': 'missing' }), themeRuntime({}, true)]) {
    expect(r.dataset.theme).toBe('light');
    r.mode(true);
    expect(r.dataset.theme).toBe('dark');
    r.emit('storage', { key: 'taskpath-theme-dark', newValue: 'sand' });
    expect(r.dataset.theme).toBe('dark');
    r.emit('storage', { key: 'taskpath-theme-dark', newValue: 'midnight' });
    expect(r.dataset.theme).toBe('midnight');
    r.emit('storage', { key: 'taskpath-theme-dark', newValue: null });
    expect(r.dataset.theme).toBe('dark');
  }
});

test('added palettes are selectable for their matching automatic appearance', () => {
  for (const id of ['mint', 'blush', 'paper', 'ember', 'forest', 'graphite']) {
    const dark = blocks.find(m => m[1] === id)![2]!.includes('color-scheme: dark');
    const r = themeRuntime({ ['taskpath-theme-' + (dark ? 'dark' : 'light')]: id });
    r.mode(dark);
    expect(r.dataset.theme).toBe(id);
  }
});
