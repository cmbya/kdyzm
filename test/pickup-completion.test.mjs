import test from 'node:test';
import assert from 'node:assert/strict';
import { completionKind, detectPickupCompletion, validatePickupCompletionRule } from '../src/pickup-completion.mjs';

const NOW = 1800000000000;
const event = (description, time = NOW - 1000) => ({ time, description });
const detect = (...logisticsEvents) => detectPickupCompletion({ logisticsEvents }, { now: NOW });

test('only explicit recipient signature or completed user collection counts', () => {
  for (const description of ['本人签收', '您的包裹已由本人签收', '收件人已签收', '签收人：本人', '签收人：收件人', '用户已取件', '收件人已取走', '收件人领取成功', '用户取件成功', '您已从丰巢柜取出']) {
    const result = detect(event(description));
    assert.ok(result, description); assert.equal(result.eventTime, NOW - 1000);
    assert.equal(result.description, description); assert.ok(result.fingerprint); assert.equal(result.ruleVersion, 1);
  }
  for (const description of ['已签收', '交易完成', '交易成功', '门卫代收', '驿站已签收', '快递柜已签收', '包裹已放门口', '快递员取件成功', '工作人员领取成功', '用户未取件', '本人未签收', '用户没有领取成功', '预计本人签收', '请本人签收', '待收件人签收', '本人签收后可评价', '退回包裹本人签收', '收件人签收失败', '本人误签收', '用户待取件', '已经揽收']) {
    assert.equal(detect(event(description)), null, description);
  }
  for (const description of ['并非本人签收', '用户尚未领取成功', '不是本人签收', '未能由本人签收', '不需要收件人签收', '可能本人签收', '准备本人已完成提货', '用户已领取取件码', '取件码领取成功', '用户已领取红包', '本人已取件中']) assert.equal(detect(event(description)), null, description);
});

test('success without a recipient and signature instructions or service descriptions are not completion', () => {
  const descriptions = ['取件成功', '领取成功', '包裹取件成功', '揽收取件成功', '退件领取成功', '已从丰巢柜取出',
    '须本人签收', '须由本人签收', '应当本人签收', '务必收件人签收', '要求本人签收', '本人签收服务',
    '本人签收服务已开通', '支持本人签收', '指定本人签收', '本人签收要求', '本人签收说明', '本人签收流程', '本人签收方式'];
  for (const description of descriptions) {
    assert.equal(detect(event(description)), null, description);
    assert.equal(detectPickupCompletion({ status: 'signed', logisticsEvents: [event(description)] }, { now: NOW }), null, description);
  }
  for (const keywords of [['领取成功'], ['取件成功'], ['本人签收服务'], ['须本人签收']]) {
    assert.throws(() => validatePickupCompletionRule({ id: 'instruction', kind: keywords[0].includes('签收') ? 'recipient_signed' : 'user_collected', keywords }));
  }
  assert.equal(detect(event('本人签收', NOW - 2000), event('须本人签收')), null);
});

test('chronology rejects stale, tied, future and undated completion evidence', () => {
  const signed = event('本人已签收', NOW - 2000);
  assert.equal(detect(signed, event('退回商家')), null);
  assert.equal(detect(event('待取件', signed.time), signed), null);
  assert.equal(detect(signed, event('不是本人签收')), null);
  assert.equal(detect(signed, event('用户尚未领取成功', signed.time)), null);
  assert.equal(detect(signed, event('收件人将签收')), null);
  assert.equal(detect(signed, event('重新入库', 0)), null);
  assert.equal(detect(event('本人签收', NOW + 1)), null);
  assert.equal(detect(event('本人签收', 0)), null);
  assert.ok(detect(event('本人签收'), event('到达驿站，待取件', NOW - 5000)));
  assert.ok(detect(event('已签收'), signed));
  assert.equal(detectPickupCompletion({ arrivalAt: NOW, logisticsEvents: [signed] }, { now: NOW }), null);
});

test('questions and verification requests cannot become completion after punctuation normalization', () => {
  const descriptions = ['用户已领取是否属实', '用户已领取？', '用户已领取?', '用户已取走快递，请核实是否本人领取',
    '询问：收件人已签收', '本人已签收，待确认', '疑似用户已取件', '用户已领取，是 否属实', '用户已完成提货？', '用户已领取了吗', '用户已取走快递吗'];
  const rule = validatePickupCompletionRule({ id: 'ai-question-guard', kind: 'user_collected', keywords: ['用户已完成提货'], origin: 'ai' });
  for (const description of descriptions) {
    assert.equal(completionKind(description), '', description);
    assert.equal(detectPickupCompletion({ status: 'signed', logisticsEvents: [event(description)] }, { rules: [rule], now: NOW }), null, description);
    assert.equal(detect(event('本人已签收', NOW - 2000), event(description)), null, description);
  }
  assert.throws(() => validatePickupCompletionRule({ id: 'question', kind: 'user_collected', keywords: ['用户已领取？'] }));
  assert.ok(detect(event('用户已领取。')));
  assert.ok(detect(event('收件人已签收，谢谢。')));
});

test('literal rule extends only explicit collection wording and cannot bypass fixed guards', () => {
  const shipment = { logisticsEvents: [event('本人已完成提货')] };
  assert.equal(detectPickupCompletion(shipment, { now: NOW }), null);
  const rule = validatePickupCompletionRule({ id: 'ai-collection', kind: 'user_collected', keywords: ['本人已完成提货'], origin: 'ai' });
  const result = detectPickupCompletion(shipment, { rules: [rule], now: NOW });
  assert.equal(result.ruleId, 'ai-collection');
  for (const description of ['预计本人已完成提货', '快递员称本人已完成提货', '退回包裹本人已完成提货']) {
    assert.equal(detectPickupCompletion({ logisticsEvents: [event(description)] }, { rules: [rule], now: NOW }), null);
  }
  for (const keywords of [['已签收'], ['交易完成'], ['用户'], ['快递员领取成功']]) assert.throws(() => validatePickupCompletionRule({ id: 'unsafe', kind: 'user_collected', keywords }));
  assert.throws(() => validatePickupCompletionRule({ id: 'unsafe', kind: 'user_collected', keywords: ['用户已取件'], pattern: '.*' }));
});

test('success words do not hide a following failure, negation or conditional suffix', () => {
  const positives = ['本人已完成提货成功', '客户提取成功', '本人提货完毕', '客户提取完成'];
  for (const [index, description] of positives.entries()) {
    const rule = validatePickupCompletionRule({ id: `ai-success-${index}`, kind: 'user_collected', keywords: [description], origin: 'ai' });
    assert.equal(completionKind(description), 'user_collected', description);
    assert.equal(detectPickupCompletion({ logisticsEvents: [event(description)] }, { rules: [rule], now: NOW }).ruleId, rule.id);
    for (const suffix of ['失败', '未成功', '未完成', '后通知', '前通知', '时通知', '异常', '有误', '作废']) {
      const negative = description + suffix;
      assert.equal(completionKind(negative), '', negative);
      assert.equal(detectPickupCompletion({ logisticsEvents: [event(negative)] }, { rules: [rule], now: NOW }), null, negative);
      assert.equal(detect(event('本人已签收', NOW - 2000), event(negative)), null, negative);
    }
  }
});
