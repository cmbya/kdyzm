import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initStationAdmin } from '../public/station-admin.js';

class Element {
  constructor(tag, id = '') { this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.listeners = new Map(); this.attributes = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
  querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
  querySelector() { return null; }
  focus() {}
  scrollIntoView() {}
  async dispatch(name, target = this) { for (const listener of this.listeners.get(name) || []) await listener({ target, preventDefault() {} }); }
  click() { return this.disabled ? Promise.resolve() : this.dispatch('click'); }
  set innerHTML(_value) { throw new Error('AI channel text must never be rendered as HTML'); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const content = element => element.textContent + element.children.map(content).join('');
const channel = (id, extra = {}) => ({ id, name:'合成渠道'+id, baseUrl:'https://synthetic.example', model:'synthetic-model', enabled:true, hasApiKey:true, apiKeyMasked:'••••••••', revision:1, ...extra });

async function browser(t) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)].map(match => [match[2], new Element(match[1], match[2])]));
  for (const formId of ['ai-channel-form', 'ai-settings-form']) {
    const body = html.split(`id="${formId}"`)[1].split('</form>')[0];
    elements.get(formId).children = [...body.matchAll(/<(?:input|select|button)[^>]*\bid="([^"]+)"/g)].map(match => elements.get(match[1]));
  }
  const document = { hidden:false, listeners:new Map(), getElementById:id=>elements.get(id), createElement:tag=>new Element(tag), createTextNode:value=>Object.assign(new Element('#text'),{textContent:value}), addEventListener(name, listener) { this.listeners.set(name, listener); } };
  const timers=new Map();let timerId=0;
  const original = { document:globalThis.document, confirm:globalThis.confirm, setTimeout:globalThis.setTimeout, clearTimeout:globalThis.clearTimeout }; globalThis.document=document;globalThis.confirm=()=>true;
  globalThis.setTimeout=(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);
  t.after(()=>{for(const [key,value] of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  const state = { channels:[channel('a'),channel('b',{name:'<img src=x onerror=alert(1)>',enabled:false})], config:{channelId:'a',enabled:false,intervalMinutes:5,dailyLimit:20,usageToday:0}, candidates:[],running:false,failCandidates:false,waitCandidates:null,waitTest:null,waitSave:null,failSave:false,failLoad:false, testResult:{ok:false,message:'部分能力未通过合成样例校验',capabilities:{station_alias:{ok:true,message:'合成样例通过'},sms_template:{ok:false,message:'模板未通过反例校验'}}} };
  const calls=[],notices=[];
  const config=()=>({...state.config,...Object.fromEntries(['baseUrl','model','hasApiKey'].map(key=>[key,state.channels.find(c=>c.id===state.config.channelId)?.[key]])),channelEnabled:!!state.channels.find(c=>c.id===state.config.channelId)?.enabled});
  initStationAdmin({notice:(...args)=>notices.push(args),api:async(path,options={})=>{
    const method=options.method||'GET',body=options.body?JSON.parse(options.body):null;calls.push({path,method,body});
    if(path==='/v1/admin/stations')return {stations:[]};
    if(path==='/v1/admin/station-candidates'){if(state.waitCandidates)await state.waitCandidates;if(state.failCandidates)throw new Error('候选暂时读取失败');return {candidates:structuredClone(state.candidates),running:state.running};}
    if(path==='/v1/admin/station-ai'){
      if(method==='PATCH'){if(state.waitSave)await state.waitSave;if(state.failSave)throw new Error('保存失败，草稿仍在');Object.assign(state.config,body);}
      return {config:config(),running:state.running};
    }
    if(path.endsWith('/test')){if(state.waitTest)await state.waitTest;state.config.usageToday+=2;return structuredClone(state.testResult);}
    if(path==='/v1/admin/ai-channels'){
      if(state.failLoad)throw new Error('渠道列表读取失败');
      if(method==='POST'){if(state.waitSave)await state.waitSave;if(state.failSave)throw new Error('保存失败，草稿仍在');state.channels.push(channel('created',{...body,hasApiKey:!!body.apiKey,apiKey:undefined}));}
      return {channels:structuredClone(state.channels),...state.config,defaultChannelId:state.config.channelId};
    }
    const id=path.split('/').at(-1),saved=state.channels.find(c=>c.id===id);
    if(method==='PATCH'&&saved){if(state.waitSave)await state.waitSave;if(state.failSave)throw new Error('保存失败，草稿仍在');Object.assign(saved,body);if(body.apiKey)saved.hasApiKey=true;if(body.clearApiKey)saved.hasApiKey=false;delete saved.apiKey;delete saved.clearApiKey;return {channel:structuredClone(saved)};}
    throw new Error('Unexpected request: '+path);
  }});
  const click=async id=>{await elements.get(id).click();await settle();};
  const fill=async(id,value)=>{const element=elements.get(id);element.value=value;const form=elements.get(['ai-limit'].includes(id)?'ai-settings-form':'ai-channel-form');await form.dispatch('input',element);};
  const select=async(id,value)=>{elements.get(id).value=value;await elements.get(id).dispatch('change');await settle();};
  const submit=async id=>{await elements.get(id).dispatch('submit');await settle();};
  const poll=async()=>{assert.equal(timers.size,1,'应仅有一个刷新计时器');const [id,timer]=[...timers][0];timers.delete(id);await timer.callback();await settle();};
  await click('station-settings-tab');return {elements,state,calls,notices,document,timers,poll,click,fill,select,submit};
}

test('统一渠道列表保留暂停项与五分钟设置，密钥不回显且渠道名称作为文字',async t=>{
  const page=await browser(t),get=id=>page.elements.get(id);
  assert.equal(get('ai-channel-edit').value,'a');assert.equal(get('ai-channel-select').value,'a');assert.equal(get('ai-interval').value,'5');
  assert.match(content(get('ai-channel-edit')),/<img src=x onerror=alert\(1\)>（已暂停）/);
  assert.equal(get('ai-api-key').value,'');assert.match(get('ai-key-state').textContent,/已配置/);
  assert.equal(get('ai-test').disabled,false);assert.match(get('ai-usage').textContent,/0 次 \/ 20 次/);
});

test('站点设置只保存渠道选择、频率、开关和共享额度，不重复写入渠道密钥',async t=>{
  const page=await browser(t);await page.select('ai-channel-select','b');await page.select('ai-interval','5');await page.fill('ai-limit','33');await page.submit('ai-settings-form');
  const saved=page.calls.find(c=>c.path==='/v1/admin/station-ai'&&c.method==='PATCH');
  assert.deepEqual(saved.body,{channelId:'b',enabled:false,intervalMinutes:5,dailyLimit:33});
  assert.match(page.elements.get('ai-settings-result').textContent,/已保存/);assert.match(page.elements.get('ai-config-state').textContent,/渠道不可用/);
});

test('编辑渠道留空保留密钥，创建后不回显密钥，清除只暂停所选渠道',async t=>{
  const page=await browser(t);await page.fill('ai-channel-name','已修改渠道');await page.select('ai-channel-enabled','false');await page.submit('ai-channel-form');
  assert.deepEqual(page.calls.find(c=>c.path.endsWith('/a')&&c.method==='PATCH').body,{name:'已修改渠道',baseUrl:'https://synthetic.example',model:'synthetic-model',enabled:false});
  assert.equal(page.state.channels[0].hasApiKey,true);assert.equal(page.state.config.enabled,false);
  await page.select('ai-channel-edit','');await page.fill('ai-channel-name','新合成渠道');await page.fill('ai-base-url','https://new.synthetic.example');await page.fill('ai-model','new-model');await page.fill('ai-api-key','synthetic-key');await page.submit('ai-channel-form');
  assert.equal(page.elements.get('ai-channel-edit').value,'created');assert.equal(page.elements.get('ai-api-key').value,'');
  await page.click('ai-clear-key');assert.equal(page.state.channels.at(-1).hasApiKey,false);assert.equal(page.state.channels.at(-1).enabled,false);assert.equal(page.state.channels[0].hasApiKey,true);
  assert.equal(page.elements.get('ai-test').disabled,true);assert.equal(page.elements.get('ai-clear-key').disabled,true);
});

test('能力测试分别呈现两个结果，部分失败不宣称通过，并刷新共享用量',async t=>{
  const page=await browser(t);await page.click('ai-test');
  assert.equal(page.calls.filter(c=>c.path==='/v1/admin/ai-channels/a/test').length,1);
  const text=content(page.elements.get('ai-capability-results'));assert.match(text,/站点别名：校验通过/);assert.match(text,/短信模板：未通过/);
  assert.match(page.elements.get('ai-test-result').textContent,/部分能力未通过/);assert.doesNotMatch(page.elements.get('ai-test-result').textContent,/连接成功/);
  assert.match(page.elements.get('ai-usage').textContent,/2 次 \/ 20 次/);
});

test('保存等待时防重复提交，失败保留草稿且恢复操作',async t=>{
  const page=await browser(t);await page.fill('ai-model','unsaved-model');let release;page.state.waitSave=new Promise(resolve=>{release=resolve;});page.state.failSave=true;
  const pending=page.submit('ai-channel-form');await settle();assert.equal(page.elements.get('ai-channel-save').disabled,true);await page.submit('ai-channel-form');
  assert.equal(page.calls.filter(c=>c.method==='PATCH').length,1);release();await pending;
  assert.equal(page.elements.get('ai-model').value,'unsaved-model');assert.equal(page.elements.get('ai-channel-save').disabled,false);assert.match(page.elements.get('ai-channel-result').textContent,/保存失败/);
});

test('后台刷新保留未保存的渠道、密钥和自动优化草稿',async t=>{
  const page=await browser(t);await page.fill('ai-model','draft-model');await page.fill('ai-api-key','draft-key');await page.fill('ai-limit','37');
  page.document.listeners.get('visibilitychange')();await settle();
  assert.equal(page.elements.get('ai-model').value,'draft-model');assert.equal(page.elements.get('ai-api-key').value,'draft-key');assert.equal(page.elements.get('ai-limit').value,'37');
  await page.click('ai-test');assert.equal(page.calls.some(c=>c.path.endsWith('/test')),false);assert.match(page.notices.at(-1)[0],/先保存渠道/);
});

test('切换渠道或退出登录后丢弃晚到测试结果，退出立即清空输入的密钥',async t=>{
  const page=await browser(t);let release;page.state.waitTest=new Promise(resolve=>{release=resolve;});const pending=page.click('ai-test');await settle();
  await page.select('ai-channel-edit','b');release();await pending;assert.equal(page.elements.get('ai-capability-results').children.length,0);assert.doesNotMatch(page.elements.get('ai-test-result').textContent,/测试已完成/);
  page.state.waitTest=new Promise(resolve=>{release=resolve;});const next=page.click('ai-test');await settle();await page.fill('ai-api-key','temporary-key');await page.click('logout');assert.equal(page.elements.get('ai-api-key').value,'');release();await next;
  assert.equal(page.elements.get('ai-capability-results').children.length,0);
});

test('测试返回时尊重当前新增渠道的不可测试状态',async t=>{
  const page=await browser(t);let release;page.state.waitTest=new Promise(resolve=>{release=resolve;});const pending=page.click('ai-test');await settle();
  await page.select('ai-channel-edit','');release();await pending;assert.equal(page.elements.get('ai-test').disabled,true);assert.equal(page.elements.get('ai-clear-key').disabled,true);
});

test('开启自动优化后立即刷新并持续发现后台结果，无需手动分析或重开页面',async t=>{
  const page=await browser(t);assert.equal(page.timers.size,0);
  page.state.candidates=[{id:'auto',stationName:'合成自动站点',fragment:'合成自动站点',status:'pending'}];
  await page.click('ai-enabled');await page.submit('ai-settings-form');
  assert.match(content(page.elements.get('candidate-list')),/合成自动站点/);assert.equal([...page.timers.values()][0].delay,10000);
  await page.fill('ai-limit','31');await page.fill('ai-model','尚未保存模型');
  page.state.running=true;await page.poll();assert.equal([...page.timers.values()][0].delay,3000);
  page.state.running=false;page.state.candidates[0].suggestion={suggestedName:'自动归并建议',alias:'合成自动站点',evidence:['虚构片段一致']};
  page.state.candidates[0].status='pending_review';await page.poll();
  assert.match(content(page.elements.get('candidate-list')),/自动归并建议/);assert.equal([...page.timers.values()][0].delay,10000);
  assert.equal(page.elements.get('ai-limit').value,'31');assert.equal(page.elements.get('ai-model').value,'尚未保存模型');
  assert.equal(page.calls.some(call=>call.path.endsWith('/run')),false);
  page.document.hidden=true;page.document.listeners.get('visibilitychange')();assert.equal(page.timers.size,0);
  page.document.hidden=false;page.document.listeners.get('visibilitychange')();await settle();assert.equal(page.timers.size,1);
  await page.click('basic-settings-tab');assert.equal(page.timers.size,0);
});

test('自动刷新等待完整请求结束且临时失败继续重试，不伪造超时或运行状态',async t=>{
  const page=await browser(t);await page.click('ai-enabled');await page.submit('ai-settings-form');
  let release;page.state.waitCandidates=new Promise(resolve=>{release=resolve;});const pending=page.poll();await settle();assert.equal(page.timers.size,0);
  page.state.failCandidates=true;release();await pending;assert.equal(page.timers.size,1);assert.equal([...page.timers.values()][0].delay,10000);
  page.state.waitCandidates=null;page.state.failCandidates=false;await page.poll();assert.equal(page.timers.size,1);
  assert.equal(page.notices.some(([message])=>/任务仍在后台处理|重新打开/.test(message)),false);
  await page.click('logistics-settings-tab');assert.equal(page.timers.size,0);
});
