import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/logistics-rules.js';
import { Store } from '../src/store.mjs';
import { createCollector, jdParcels, taobaoParcels } from '../src/collectors.mjs';

const engine=globalThis.PickCodeLogistics;
const station='中山石岐远洋风景4卡店';
const description=`快件已由兔兔快递员测试员送达兔喜生活+暂存 取件地址:员峰振兴路菜鸟驿站(${station}) ${station},请及时取件。`;
const full='快件已由兔兔快递员测试员18600000000送达兔喜生活+暂存,取件地址:员峰振兴路菜鸟驿站('+station+') '+station+',请及时取件。 代理点电话:15800000000,投诉电话:0760-00000000';

test('明确取件地址优先于送达品牌前缀，重复括号站名只取一次',()=>{
  const time=Date.parse('2026-11-05T13:13:48+08:00');
  const evidence=engine.pickupEvidence([{time,timePrecision:'second',description}]);
  assert.equal(evidence.station,station);
  assert.equal(evidence.arrivalAt,time);
  assert.equal(evidence.arrivalAtSource,'platform_event');
  assert.equal(evidence.arrivalAtPrecision,'second');
});

test('已完成暂存动作连接紧邻逗号后的明确取件地址，包括截图完整电话尾文',()=>{
  const time=Date.parse('2026-11-05T13:13:48+08:00');
  for(const sample of [full, '已送达兔喜生活+暂存,取件地址:'+station,
    '已送达兔喜生活+存放， 自提地址：'+station]){
    const evidence=engine.pickupEvidence([{time,timePrecision:'second',description:sample,station:'兔喜快递超市代收点'}]);
    assert.equal(evidence.station,station,sample);
    assert.equal(evidence.arrivalAt,time,sample);
    assert.equal(evidence.arrivalAtSource,'platform_event');
    assert.equal(engine.eventStatus(sample),'arrived');
  }
});

test('完整逗号原文在淘宝、京东和拼多多采集入口产生可信到站时间',async()=>{
  const timeText='2026-11-05 13:13:48', time=Date.parse(timeText.replace(' ','T')+'+08:00');
  const tb=taobaoParcels({mailNo:'SYNTHETIC',multiStage:[{time:timeText,title:'物流更新',labelDesc:{text:full}}]},'o')[0];
  const jd=jdParcels({multiPackageTrackInfoList:[{carriageInfo:{carriageId:'SYNTHETIC'},trackGroupInfo:{orderTrackShowList:[{CreationTime:timeText,Content:full}]}}]},'o',time)[0];
  const pdd=await createCollector({now:()=>time,fetchImpl:async()=>new Response(JSON.stringify({shipping:{tracking_number:'SYNTHETIC',traces:[{time:timeText,info:full}]}}))})
    ({platform:'pdd'},'pdd_user_id=SYNTHETIC',{targetOrder:{platformOrderId:'o',shipments:[{waybillNo:'SYNTHETIC',status:'transit'}]}});
  for(const shipment of [tb,jd,pdd.shipments[0]]){
    assert.equal(shipment.status,'arrived'); assert.equal(shipment.station,station);
    assert.equal(shipment.arrivalAt,time); assert.equal(shipment.arrivalAtSource,'platform_event');
    assert.equal(shipment.arrivalAtPrecision,'second');
  }
});

test('后台升级后下次正常导入会利用已留存完整原文修复旧缓存，无需重写库或再次下载轨迹',t=>{
  const time=Date.parse('2026-11-05T13:13:48+08:00');
  let rules=engine.defaults().map(rule=>({...rule,enabled:false}));
  const store=new Store({key:Buffer.alloc(32,2),now:()=>time+3600000,getLogisticsRules:()=>rules});
  t.after(()=>store.close());
  const account=store.saveAccount({platform:'pdd',label:'合成',cookie:'SYNTHETIC'},'a',true);
  const order={platformOrderId:'o',title:'合成逗号原文'};
  const shipment={platformOrderId:'o',waybillNo:'SYNTHETIC',status:'arrived',station:'兔喜快递超市代收点',arrivalAt:0};
  store.importResult(account.id,{orders:[order],shipments:[{...shipment,logisticsEvents:[{time,timePrecision:'second',description:full}],logisticsState:'ok'}]});
  assert.equal(store.snapshot([account.id]).shipments[0].arrivalAt,0);
  rules=engine.defaults();
  assert.equal(store.snapshot([account.id]).shipments[0].arrivalAt,0,'只读快照不迁移持久缓存');
  store.importResult(account.id,{orders:[order],shipments:[shipment]});
  const repaired=store.snapshot([account.id]).shipments[0];
  assert.equal(repaired.station,station); assert.equal(repaired.arrivalAt,time);
  assert.equal(repaired.arrivalAtSource,'platform_event'); assert.equal(repaired.arrivalAtPrecision,'second');
  assert.equal(repaired.logisticsEvents[0].description,full);
});

test('明确地址保留柜号、卡位、不同括号内容，不用品牌猜测门店',()=>{
  assert.equal(engine.pickupStation('已送达兔喜生活，取件地址:远洋风景4卡3号柜兔喜快递柜'),'');
  assert.equal(engine.pickupStation('已送达兔喜生活 取件地址:远洋风景4卡3号柜兔喜快递柜'),'远洋风景4卡3号柜兔喜快递柜');
  assert.equal(engine.pickupStation('已送达兔喜生活 取件地址:东门菜鸟驿站(远洋风景4卡店) 远洋风景5卡店'),'东门菜鸟驿站(远洋风景4卡店) 远洋风景5卡店');
  for (const prefix of ['东门1号柜菜鸟驿站', '西门菜鸟驿站', '5卡菜鸟驿站', '2栋菜鸟驿站']) {
    const address = `${prefix}(远洋风景4卡3号柜店) 远洋风景4卡3号柜店`;
    assert.equal(engine.pickupStation('已送达兔喜生活 取件地址:' + address), address);
  }
});

test('地址字段不绕过未来、否定、改投、中转和家门口限制',()=>{
  for(const text of ['预计'+description,'尚未送达兔喜生活 取件地址:幸福菜鸟驿站',
    '已改投其他站点 取件地址:幸福菜鸟驿站','已送达转运中心 取件地址:家门口',
    '已送达兔喜生活 取件地址:杭州分拣中心','已送达兔喜生活 下一站取件地址:幸福菜鸟驿站']){
    assert.equal(engine.pickupArrivalEvent(text),false,text);
  }
});

test('相邻地址不能把非暂存、未来、上门、中转或后续另一句转换成到站证据',()=>{
  const address='取件地址:幸福菜鸟驿站';
  for(const sample of ['已送达兔喜生活,'+address, '已送达幸福服装店,'+address,
    '预计送达兔喜生活+暂存,'+address, '尚未送达兔喜生活+暂存,'+address,
    '请快递员送达兔喜生活+暂存,'+address, '已改投兔喜生活+暂存,'+address,
    '已送达转运中心暂存,'+address, '已送达家门口暂存,'+address,
    '已送达兔喜生活+暂存,下一站'+address, '已送达兔喜生活+暂存,取件地址:下一站幸福菜鸟驿站',
    '已送达兔喜生活+暂存,取件地址:家门口', '已送达兔喜生活+暂存,取件地址:杭州分拣中心',
    '已送达兔喜生活+暂存,备注:'+address, '已送达兔喜生活+暂存。'+address,
    '已送达兔喜生活+暂存,请联系快递员,'+address]){
    assert.equal(engine.pickupArrivalEvent(sample),false,sample);
    assert.equal(engine.pickupEvidence([{time:1000,description:sample}]).arrivalAt,0,sample);
  }
  const reminder='催取提醒：已送达兔喜生活+暂存,'+address;
  assert.equal(engine.pickupArrivalEvent(reminder),false);
  assert.equal(engine.pickupEvidence([{time:1000,description:reminder}]).arrivalAt,0);
  const rules=engine.defaults().map(rule=>({...rule,enabled:false}));
  assert.equal(engine.pickupArrivalEvent('已送达兔喜生活+暂存,'+address,'',rules),false);
});
