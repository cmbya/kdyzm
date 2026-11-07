import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const context=vm.createContext({window:{}});
for(const file of ['ui.js','pickup.js','settings.js']) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
const scenes=context.window.SCENES;
assert.equal(new Set(scenes.map(s=>s.id)).size,scenes.length,'Duplicate scene ids');
const targets=new Set(scenes.map(s=>s.id));
let links=0;
for(const scene of scenes){
  const html=scene.content()+(scene.footer?.()||'');
  assert(html.length>40,`Scene has no useful content: ${scene.id}`);
  assert(!html.includes('undefined'),`Undefined content: ${scene.id}`);
  for(const target of [...html.matchAll(/data-go="([^"]+)"/g)].map(m=>m[1]).concat(scene.back||[],(scene.top||[]).map(a=>a.target))){
    assert(targets.has(target),`${scene.id} links to missing scene ${target}`);links++;
  }
}
const routes=['pages/index/index','pages/index/edit-code','pages/packages/index','pages/packages/edit','pages/my/index','pages/my/online-accounts','pages/my/auto-settings','pages/my/ignored','pages/my/match-settings','pages/my/match-rules','pages/my/logistics-rules','pages/my/faq','pages/my/about','pages/my/changelog'];
for(const route of routes) assert(scenes.some(s=>s.route?.includes(route)),`Route not covered: ${route}`);
assert.equal(scenes.filter(s=>s.tab==='my').length,1);
assert(scenes.find(s=>s.id==='notifications').content().includes('data-dismiss'),'Notifications need per-item dismiss');
assert(scenes.find(s=>s.id==='pickup-long').content().includes('long-code'),'Long-code scenario must use long-code sizing');
console.log(JSON.stringify({passed:true,scenes:scenes.length,links,routes:routes.length},null,2));
fs.writeFileSync(path.join(root,'scene-map.json'),JSON.stringify(scenes.map(({id,title,group,route,description})=>({id,title,group,route,description})),null,2));
