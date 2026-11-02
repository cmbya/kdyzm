import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStationNames } from '../public/station-admin.js';
const station={id:'a',name:'远洋风景4卡',enabled:true,aliases:[{name:'远洋风景四卡2号柜兔喜快递柜'},{name:'中山石岐远洋风景4卡店'}]};
test('后台匹配核对两端必须有已保存同站规则，单端已知和明确位置冲突不能显示同站',()=>{
 assert.equal(compareStationNames('远洋风景四卡2号柜兔喜快递柜','中山石岐远洋风景4卡店',[station]).same,true);
 assert.equal(compareStationNames('未知店','中山石岐远洋风景4卡店',[station]).same,false);
 for(const [a,b] of [['花园4卡2号柜','花园5卡2号柜'],['花园3栋驿站','花园4栋驿站'],['花园东门店','花园西门店'],['花园1号柜','花园2号柜']]) assert.deepEqual(compareStationNames(a,b,[{...station,aliases:[{name:a},{name:b}]}]),{same:false,conflict:true});
 assert.equal(compareStationNames('远洋风景四卡店','远洋风景4卡店',[]).same,true);
 assert.equal(compareStationNames('远洋风景4卡丰巢快递柜','远洋风景4卡菜鸟驿站',[]).same,false);
 assert.equal(compareStationNames(station.name,'中山石岐远洋风景4卡店',[{...station,enabled:false}]).same,false);
});
