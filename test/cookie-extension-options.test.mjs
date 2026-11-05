import test from 'node:test';
import assert from 'node:assert/strict';
import {rolesFrom,entryStatus,errorKind,selectionChanges,entryKey,escapeHtml} from '../cookie-extension/options-model.mjs';
const item=(id,platform='jd',baseUrl='https://a.example')=>({id,baseUrl,account:{id:'account-'+id,familyId:'family',familyName:'家人',platform,status:'configured'},connection:{identityBound:true,lastSyncAt:123},auto:false});
test('UI grouping preserves backend boundaries and legacy grant scope',()=>{
  const roles=rolesFrom([item('a'),item('b','pdd'),item('c','jd','https://b.example')],[],'https://a.example');
  assert.equal(roles.length,1); assert.deepEqual(roles[0].entries.map(e=>e.id),['a','b']);
  assert.ok(roles[0].entries.every(e=>e.selected && !e.family));
  assert.equal(rolesFrom([],[],'https://a.example').length,0);
});
test('saved credentials never imply successful collection',()=>{
  const entry=item('a'); assert.equal(entryStatus(entry).kind,'pending');
  entry.account.status='ok'; assert.equal(entryStatus(entry).kind,'verified');
  entry.account.status='error'; assert.equal(entryStatus(entry).label,'已同步，采集未完成');
  entry.account.status='expired'; assert.equal(entryStatus(entry).action,'去登录');
  entry.error='权限未授予'; entry.errorCode='PERMISSION_REQUIRED'; assert.equal(entryStatus(entry).action,'授予权限');
});
test('account conflicts, missing login and outages have different remedies',()=>{
  assert.equal(errorKind({code:'COOKIE_IDENTITY_MISMATCH'}),'conflict');
  assert.equal(errorKind({code:'IDENTITY_MISSING'}),'login');
  assert.equal(errorKind({code:'NETWORK_ERROR'}),'network');
  assert.equal(errorKind({error:'浏览器登录的账号与后台授权账号不一致'}),'conflict');
});
test('platform management rejects ambiguous targets, deselection clears auto only for that target',()=>{
  const a=item('a'),b=item('b'),p=item('p','pdd'); const entries=[a,b,p];
  assert.throws(()=>selectionChanges(entries,[entryKey(a),entryKey(b)],[]),/只能选择一个/);
  const changed=selectionChanges(entries,[entryKey(a)],[entryKey(a),entryKey(p)]);
  assert.equal(changed[0].auto,true); assert.equal(changed[2].auto,false); assert.equal(changed[2].selected,false);
  assert.equal(changed[0].entry,a); assert.equal(changed[2].entry,p);
  assert.equal(a.selected,undefined);
});
test('backend-controlled names are escaped before HTML rendering',()=>{assert.equal(escapeHtml('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;');});
