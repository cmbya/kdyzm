import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/logistics-rules.js';

const engine=globalThis.PickCodeLogistics;
const station='中山石岐远洋风景4卡店';
const description=`快件已由兔兔快递员测试员送达兔喜生活+暂存 取件地址:员峰振兴路菜鸟驿站(${station}) ${station},请及时取件。`;

test('明确取件地址优先于送达品牌前缀，重复括号站名只取一次',()=>{
  const time=Date.parse('2026-11-05T13:13:48+08:00');
  const evidence=engine.pickupEvidence([{time,timePrecision:'second',description}]);
  assert.equal(evidence.station,station);
  assert.equal(evidence.arrivalAt,time);
  assert.equal(evidence.arrivalAtSource,'platform_event');
  assert.equal(evidence.arrivalAtPrecision,'second');
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
