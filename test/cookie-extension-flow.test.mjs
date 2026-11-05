import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncFlow} from '../cookie-extension/sync-flow.mjs';
const entry=(platform,bound=false)=>({id:'group',accountId:platform,family:true,selected:true,account:{platform},connection:{identityBound:bound}});
test('logged-in platforms finish independently and first identities wait for one confirmation',async()=>{
  const calls=[];
  const flow=createSyncFlow({call:async(action,args)=>{calls.push([action,args.accountId]);
    if(args.accountId === 'pdd') throw Object.assign(new Error('missing login'),{code:'IDENTITY_MISSING'});
    if(action.endsWith('previewSync')) return {token:'proof',identityHint:'masked',account:{platform:args.accountId}};
    return {changed:true};
  }});
  await flow.start({name:'家人'},[entry('taobao',true),entry('jd'),entry('pdd')]);
  assert.equal(flow.state.phase,'confirm');
  assert.deepEqual(flow.state.results.map(r=>r.status),['synced','confirm','error']);
  assert.equal(calls.filter(([action])=>action.endsWith('confirmSync')).length,0);
  await flow.confirm(); assert.deepEqual(flow.state.results.map(r=>r.status),['synced','synced','error']);
});
test('cancel while checking prevents stale confirmation and next-platform reads',async()=>{
  let resolve; const gate=new Promise(r=>resolve=r); const calls=[];
  const flow=createSyncFlow({call:async(action)=>{calls.push(action);if(action.endsWith('previewSync')) return gate; return {};}});
  const pending=flow.start({name:'A'},[entry('jd'),entry('pdd')]);
  await new Promise(r=>setImmediate(r)); await flow.cancel(); resolve({token:'stale'}); await pending;
  assert.equal(flow.state,null); assert.equal(calls.filter(a=>a.endsWith('previewSync')).length,1);
  assert.equal(calls.filter(a=>a.endsWith('cancelSync')).length,2);
  await flow.confirm(); assert.equal(calls.some(a=>a.endsWith('confirmSync')),false);
});
test('returning from login retries only pending platform and retains role',async()=>{
  let ready=false; const calls=[];
  const flow=createSyncFlow({call:async(action,args)=>{calls.push([action,args.accountId]);if(args.accountId === 'pdd' && !ready) throw Object.assign(new Error('login'),{code:'LOGIN_REQUIRED'});return {changed:true};}});
  const jd=entry('jd',true),pdd=entry('pdd',true);
  await flow.start({name:'original'},[jd,pdd]); ready=true; await flow.retry(pdd);
  assert.equal(flow.state.role.name,'original'); assert.equal(calls.filter(([action,id])=>action.endsWith(':sync') && id === 'jd').length,1);
  assert.deepEqual(flow.state.results.map(r=>r.status),['synced','synced']);
});
test('ambiguous targets fail before any cookie or network action',async()=>{
  let calls=0; const flow=createSyncFlow({call:async()=>{calls++;}});
  await assert.rejects(flow.start({},[entry('jd'),{...entry('jd'),accountId:'other'}]),/唯一账号/); assert.equal(calls,0);
});

test('cancel during previous-flow cleanup cannot restart a new sync',async()=>{
  let release; const cleanup=new Promise(resolve=>release=resolve); const calls=[];
  const flow=createSyncFlow({call:async action=>{calls.push(action);if(action.endsWith('cancelSync'))await cleanup;return {changed:true};}});
  await flow.start({name:'old'},[entry('jd',true)]);
  const next=flow.start({name:'new'},[entry('pdd',true)]);
  await flow.cancel(); release(); await next;
  assert.equal(flow.state,null); assert.equal(flow.running,false);
  assert.equal(calls.filter(action=>action.endsWith(':sync')).length,1);
});

test('simultaneous starts during cleanup reserve one active flow',async()=>{
  let release; const cleanup=new Promise(resolve=>release=resolve); const calls=[];
  const flow=createSyncFlow({call:async(action,args)=>{calls.push([action,args.accountId]);if(action.endsWith('cancelSync'))await cleanup;return {changed:true};}});
  await flow.start({name:'old'},[entry('jd',true)]);
  const next=flow.start({name:'new'},[entry('pdd',true)]);
  await flow.start({name:'duplicate'},[entry('taobao',true)]); release(); await next;
  assert.equal(flow.state.role.name,'new');
  assert.deepEqual(calls.filter(([action])=>action.endsWith(':sync')).map(([,id])=>id),['jd','pdd']);
});
