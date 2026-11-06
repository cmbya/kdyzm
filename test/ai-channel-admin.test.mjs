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

async function browser(t, tuning = false) {
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
  if(tuning)Object.assign(state.config,{autoApply:false,logisticsEnabled:false});
  Object.assign(state,{changes:[],logistics:[],failOptimization:false,waitOptimization:null});
  const config=()=>({...state.config,...Object.fromEntries(['baseUrl','model','hasApiKey'].map(key=>[key,state.channels.find(c=>c.id===state.config.channelId)?.[key]])),channelEnabled:!!state.channels.find(c=>c.id===state.config.channelId)?.enabled});
  initStationAdmin({notice:(...args)=>notices.push(args),api:async(path,options={})=>{
    const method=options.method||'GET',body=options.body?JSON.parse(options.body):null;calls.push({path,method,body});
    if(path==='/v1/admin/stations')return {stations:[]};
    if(path==='/v1/admin/ai-optimization/history'){if(state.waitOptimization)await state.waitOptimization;if(state.failOptimization)throw new Error('记录暂不可用');return {changes:structuredClone(state.changes)};}
    if(path==='/v1/admin/logistics-ai'){if(state.failOptimization)throw new Error('物流暂不可用');return {candidates:structuredClone(state.logistics)};}
    if(path.includes('/ai-optimization/history/')&&path.endsWith('/rollback')){if(state.waitSave)await state.waitSave;const item=state.changes.find(c=>path.endsWith('/'+c.id+'/rollback'));item.status='rolled_back';item.canRollback=false;return {ok:true};}
    if(path.startsWith('/v1/admin/logistics-ai/')&&path.endsWith('/ignore')){state.logistics=state.logistics.filter(c=>!path.endsWith('/'+c.id+'/ignore'));return {ok:true};}
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

test('统一渠道列表保留暂停项并显示六小时频率，密钥不回显且渠道名称作为文字',async t=>{
  const page=await browser(t),get=id=>page.elements.get(id);
  assert.equal(get('ai-channel-edit').value,'a');assert.equal(get('ai-channel-select').value,'a');assert.equal(get('ai-interval').value,'360');
  assert.match(content(get('ai-channel-edit')),/<img src=x onerror=alert\(1\)>（已暂停）/);
  assert.equal(get('ai-api-key').value,'');assert.match(get('ai-key-state').textContent,/已配置/);
  assert.equal(get('ai-test').disabled,false);assert.match(get('ai-usage').textContent,/0 次 \/ 20 次/);
});

test('人工样本显示来源、待核对原因与关闭状态，已应用和撤回仍可审计',async t=>{
  const page=await browser(t),get=id=>page.elements.get(id);
  page.state.candidates=[
    {id:'manual-review',status:'unknown',stationName:'海棠2号柜',fragment:'海棠2号柜',automationReason:'其他匹配条件需核对',feedback:{kind:'manual_match',otherStationName:'物流海棠站',targetStationId:'target',subLocation:'2号柜'}},
    {id:'applied',status:'approved',stationName:'已学站名',fragment:'已学站名',feedback:{kind:'station_correction'}},
    {id:'withdrawn',status:'withdrawn',stationName:'撤回站名',fragment:'撤回站名',feedback:{kind:'manual_match'}},
  ];
  await page.click('station-settings-tab'); await page.click('station-queue-entry');
  const shown=content(get('candidate-list'));
  for(const expected of ['人工匹配样本','站点修正样本','其他匹配条件需核对','物流海棠站','2号柜','已应用','已撤回'])assert.ok(shown.includes(expected),expected);
  const articles=get('candidate-list').children;
  assert.equal(articles[1].querySelectorAll().filter(element=>element.tagName==='BUTTON').length,0);
  assert.equal(articles[2].querySelectorAll().filter(element=>element.tagName==='BUTTON').length,0);
});

test('自动调优必须显式勾选，保存后自动更新两种能力和修改记录',async t=>{
  const page=await browser(t,true),get=id=>page.elements.get(id);
  assert.equal(get('ai-auto-apply').checked,false);assert.equal(get('ai-auto-apply-row').hidden,false);
  assert.equal(page.calls.some(c=>c.method==='POST'||c.method==='PATCH'),false);
  get('ai-auto-apply').checked=true;await get('ai-auto-apply').dispatch('change');await page.click('ai-enabled');
  await page.submit('ai-settings-form');
  const saved=page.calls.find(c=>c.path==='/v1/admin/station-ai'&&c.method==='PATCH');
  assert.equal(saved.body.autoApply,true);assert.equal(saved.body.logisticsEnabled,true);assert.equal(saved.body.enabled,true);
  assert.match(get('ai-config-state').textContent,/自动调优已开启/);
  page.state.changes=[{id:'one',kind:'station_alias',summary:'<img src=x onerror=alert(1)>',status:'applied',canRollback:true,appliedAt:1}];
  await page.poll();assert.match(content(get('ai-optimization-list')),/<img src=x onerror=alert\(1\)>/);
  assert.match(get('ai-optimization-count').textContent,/1 条/);
});

test('回滚需确认且防重复请求，完成刷新；失败读取不删除已知记录',async t=>{
  const page=await browser(t,true),get=id=>page.elements.get(id);await page.click('ai-enabled');await page.submit('ai-settings-form');
  page.state.changes=[{id:'one',kind:'logistics_rule',summary:'到店文字',status:'applied',canRollback:true}];await page.poll();
  const rollback=get('ai-optimization-list').children[0].children.find(c=>c.tagName==='BUTTON');
  globalThis.confirm=()=>false;await rollback.click();assert.equal(page.calls.some(c=>c.path.endsWith('/rollback')),false);
  globalThis.confirm=()=>true;let release;page.state.waitSave=new Promise(resolve=>{release=resolve;});
  const pending=rollback.click();await settle();await rollback.click();
  await page.poll();assert.equal(get('ai-optimization-list').children[0].children.find(c=>c.tagName==='BUTTON'),rollback,'轮询不能重建正在提交的回滚按钮');
  assert.equal(page.calls.filter(c=>c.path.endsWith('/rollback')).length,1);release();await pending;
  assert.match(content(get('ai-optimization-list')),/已回滚/);
  page.state.failOptimization=true;await page.poll();assert.match(content(get('ai-optimization-list')),/已回滚/);
  assert.match(get('ai-optimization-result').textContent,/暂时无法读取/);
});

test('物流待处理可忽略，能力测试能显示第三项且晚到记录不能跨登录会话',async t=>{
  const page=await browser(t,true),get=id=>page.elements.get(id);await page.click('ai-enabled');await page.submit('ai-settings-form');
  page.state.logistics=[{id:'one',status:'review',fragment:'合成站点文字',automationReason:'位置证据存在冲突'}];await page.poll();
  assert.match(content(get('ai-logistics-list')),/位置证据存在冲突/);
  await get('ai-logistics-list').children[0].children.find(c=>c.tagName==='BUTTON').click();assert.match(content(get('ai-logistics-list')),/暂无/);
  page.state.testResult.capabilities.logistics_rule={ok:true,message:'物流反例通过'};await page.click('ai-test');
  assert.match(content(get('ai-capability-results')),/物流识别：校验通过/);
  let release;page.state.waitOptimization=new Promise(resolve=>{release=resolve;});const pending=page.poll();await settle();
  await page.click('logout');page.state.changes=[{id:'secret',summary:'过期会话记录',status:'applied'}];release();await pending;
  assert.doesNotMatch(content(get('ai-optimization-list')),/过期会话记录/);
});

test('站点设置只保存渠道选择、频率、开关和共享额度，不重复写入渠道密钥',async t=>{
  const page=await browser(t);await page.select('ai-channel-select','b');await page.fill('ai-limit','13');await page.submit('ai-settings-form');
  const saved=page.calls.find(c=>c.path==='/v1/admin/station-ai'&&c.method==='PATCH');
  assert.deepEqual(saved.body,{channelId:'b',enabled:false,intervalMinutes:360,dailyLimit:13});
  assert.match(page.elements.get('ai-settings-result').textContent,/已保存/);assert.match(page.elements.get('ai-config-state').textContent,/渠道不可用/);
});

test('共享额度超过20时显示错误且不发保存请求',async t=>{
  const page=await browser(t);await page.fill('ai-limit','21');await page.submit('ai-settings-form');
  assert.equal(page.calls.some(c=>c.path==='/v1/admin/station-ai'&&c.method==='PATCH'),false);
  assert.match(JSON.stringify(page.notices),/1至20/);
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
