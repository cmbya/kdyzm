import { createHash } from 'node:crypto';
import { fail, onlyKeys } from './security.mjs';
import './logistics-rules.js';

export const PICKUP_COMPLETION_VERSION = 1;
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const compact = value => typeof value === 'string' ? value.normalize('NFKC').replace(/[\s\p{P}]/gu, '') : '';
const forbidden = /未(?:曾|能|有)?(?:签收|取件|领取|取走|取出)|没有(?:签收|取件|领取|取走|取出)|尚未|并未|无法|不能|拒收|拒签|取消|撤销|误签|虚假签收|非本人|非收件人|退回|退货|退件|返件|退签|重新派送|重新入库|二次派送|代收|代签|门卫|保安|前台|邻居|驿站签收|快递柜签收|门口|门外|揽收|寄件|寄出|发件人|快递员|配送员|派件员|工作人员|预计|预定|将于|即将|等待|等待领取|待取件|待领取|待签收|请(?:您|用户|收件人|本人)?(?:及时|尽快|前往)?(?:签收|取件|领取|取走|取出)|需要(?:签收|取件|领取)|(?:签收|取件|领取|取走|取出)(?:失败|未成功|异常|有误|作废)/u;
const signature = /(?:本人|收件人)(?:本人)?(?:已|已经)?(?:确认)?签收|已由(?:收件人)?本人签收|签收人(?:为|是)?(?:收件人|本人)/u;
// Match an actual receipt clause, never instructions such as 请签收人凭码签收.
const codeReceipt = description => typeof description === 'string' && description.split(/[，,。；;！!？?\r\n]/u)
  .some(part => /^(?:已签收[:：]?)?签收人(?:已)?凭(?:取货|取件)码(?:完成)?签收$/.test(compact(part)));
const collection = /(?:用户|客户|您|本人|收件人)(?:本人)?(?:已|已经)(?:完成)?(?:取件|领取|取走|取出)|(?:用户|客户|您|本人|收件人)(?:本人)?(?:取件|领取|取出)成功|(?:用户|客户|您|本人|收件人)(?:已|已经)从[^。；!?]{0,24}(?:柜|驿站)(?:中|内)?取出/u;
const collectionExtension = /(?:用户|客户|您|本人|收件人)(?:本人)?(?:(?:已|已经)(?:完成)?(?:提货|提取|自提)|(?:领取|取件|提货|提取|自提|收取)(?:完毕|完成|成功))/u;
const incomplete = /申请|预约|计划|准备|可能|可以|必须|无需|无须|需要|届时|如果|并非|不是|未能|没能|不曾|否认|拒绝|尚待|(?:将|待|未|请|若|如|需|可|会|没有)(?:由)?(?:本人|收件人|用户|客户|您).{0,8}(?:签收|领取|取件|取出|提货|提取|自提|收取)|(?:本人|收件人|用户|客户|您)(?:将|会|待|正|拟|未|需|可).{0,8}(?:签收|领取|取件|取出|提货|提取|自提|收取)|(?:签收|领取|取件|取走|取出|提货|提取|自提|收取)(?:成功|完毕|完成)?(?:后|时|前|中|失败|未成功|未完成|异常|有误|作废)/u;
const nonParcel = /(?:领取|提取|取出|收取)(?:了|到|成功)?(?:取件码|验证码|优惠券|红包|奖励|积分|通知|短信)|(?:取件码|验证码|优惠券|红包|奖励|积分|通知|短信)(?:已)?(?:领取|提取|取出|收取)/u;
const instruction = /(?:须要?|应当?|务必|要求|指定|仅限|支持|安排|选择|勾选|开通|开启|提供|使用|推荐)(?:由|为)?(?:本人|收件人|用户|客户|您).{0,8}(?:签收|领取|取件|取出|提货|提取|自提|收取)|(?:签收|领取|取件|取出|提货|提取|自提|收取)(?:服务|要求|方式|说明|须知|标准|规则|选项|条款|功能|业务|模式|流程|协议|类型)/u;
const uncertainty = /[?？]|[吗么呢](?:[。！!，,;；\s]|$)|是否|是不是|有无|核实|核验|询问|待确认|待核|待查|待验证|疑似|疑问|据称|声称|不确定|无法确认|真伪|属实/u;

export function parcelNotReceived(description) {
  return typeof description === 'string' && description.normalize('NFKC').split(/[，,。；;！!？?\r\n]/u)
    .some(part => {
      const value = compact(part);
      return [...value.matchAll(/(?:未(?:曾|能|有)?|没(?:有|能)?)(?:收货|收到(?:(?:任何|该|此|本)?(?:包裹|快件|快递|货物|货品|货|商品|物品)|$))/gu)]
        .some(match => !/(?:如果|如若|倘若|假如|假若|若|如)(?:您|用户|客户|收件人|本人|买家|有)?(?:反馈|反映|发现|遇到|出现)?(?:仍然|依然|仍|还)?$/u.test(value.slice(0, match.index)));
    });
}

export function completionNarrative(description) {
  if (typeof description !== 'string') return '';
  return description.normalize('NFKC').split(/[，,。；;\r\n]/u).filter(part => {
    const value = part.trim();
    const contact = /^(?:(?:如有(?:任何)?(?:疑问|问题)|如需帮助)(?:请|可)?(?:联系|电联|致电|拨打)|(?:请|可)(?:联系|电联|致电|拨打)|(?:快递员|配送员|派件员|网点|代收点|客服|投诉)(?:电话)?\s*[:：])/u.test(value);
    // Ignore standalone contact boilerplate only; a correction or delivery action must still veto completion.
    const action = /签收|领取|取件|取走|取出|提货|提取|自提|收取|收到|退回|退货|退件|返件|代签|代收|拒收|拒签|取消|撤销|核实|核验|是否|疑似|未|没有|预计|等待/u.test(value.replace(/代收点/gu, ''));
    return !contact || action;
  }).join('，');
}

export function completionKind(description) {
  const narrative = completionNarrative(description), text = compact(narrative);
  // Keep question punctuation until uncertainty is checked; compacting it would turn a question into a fact.
  if (!text || parcelNotReceived(narrative) || uncertainty.test(narrative) || uncertainty.test(text) || forbidden.test(text) || incomplete.test(text) || nonParcel.test(text) || instruction.test(text)) return '';
  if (codeReceipt(narrative)) return 'user_collected';
  if (signature.test(text)) return 'recipient_signed';
  if (collection.test(text) || collectionExtension.test(text)) return 'user_collected';
  return '';
}

export const builtinPickupCompletionRules = Object.freeze([
  { id: 'builtin-code-receipt-v1', version: 1, kind: 'user_collected', keywords: [], enabled: true, origin: 'builtin' },
  { id: 'builtin-recipient-signature-v1', version: 1, kind: 'recipient_signed', keywords: [], enabled: true, origin: 'builtin' },
  { id: 'builtin-user-collection-v1', version: 1, kind: 'user_collected', keywords: [], enabled: true, origin: 'builtin' },
  { id: 'builtin-pdd-out-cabinet-v1', version: 1, kind: 'user_collected', keywords: [], enabled: true, origin: 'builtin' },
  { id: 'builtin-taobao-pickup-point-exit-v1', version: 1, kind: 'user_collected', keywords: [], enabled: true, origin: 'builtin' },
]);

function providerCollection(event) {
  const ruleId = event?.provider === 'pdd' && event.providerStatus === 'OUT_CABINET' && event.providerStatusTag === '已取件'
    && event.providerSubStatus === 'OUT_CABINET_501' ? 'builtin-pdd-out-cabinet-v1'
    : event?.provider === 'taobao' && event.providerStatus === 'doing' && event.providerStatusTag === '已签收'
      && event.providerStatusText === '包裹已从代收点取出' ? 'builtin-taobao-pickup-point-exit-v1' : '';
  if (!ruleId) return '';
  const narrative = completionNarrative(event.description), text = compact(narrative).replace(/代收点/gu, '');
  // The location label is compatible with a confirmed exit; explicit failure/correction still wins.
  return !parcelNotReceived(narrative) && !uncertainty.test(narrative) && !uncertainty.test(text) && !forbidden.test(text) && !incomplete.test(text)
    && !nonParcel.test(text) && !instruction.test(text) ? ruleId : '';
}

export function validatePickupCompletionRule(input) {
  onlyKeys(input, ['id', 'version', 'kind', 'keywords', 'enabled', 'origin']);
  if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) || input.id.startsWith('builtin-')
    || !Number.isSafeInteger(input.version ?? 1) || (input.version ?? 1) < 1
    || !['recipient_signed', 'user_collected'].includes(input.kind)
    || input.enabled !== undefined && typeof input.enabled !== 'boolean'
    || !Array.isArray(input.keywords) || !input.keywords.length || input.keywords.length > 6
    || input.keywords.some(value => typeof value !== 'string' || value.length < 2 || value.length > 60 || /[\r\n\x00-\x1f]/.test(value))
    || !['manual', 'ai'].includes(input.origin ?? 'manual')) fail(400, 'INVALID_PICKUP_COMPLETION_RULE', '自动取件规则仅支持有明确领取语义的受限明文关键词');
  const keywords = [...new Set(input.keywords.map(value => value.normalize('NFKC').trim()))];
  if (completionKind(keywords.join('')) !== input.kind) fail(400, 'INVALID_PICKUP_COMPLETION_RULE', '关键词缺少明确本人签收或用户领取依据');
  return { id: input.id, version: input.version ?? 1, kind: input.kind, keywords, enabled: input.enabled ?? true, origin: input.origin ?? 'manual' };
}

// A newer delivery/return/pending event starts a new cycle or contradicts completion.
export function completionConflict(description) {
  const value = compact(description);
  return !!value && !completionKind(description) && (parcelNotReceived(description) || uncertainty.test(description) || uncertainty.test(value) || forbidden.test(value) || incomplete.test(value) || nonParcel.test(value) || instruction.test(value) || /运输中|转运|中转|派送|配送中|到达|已到|到站|入库|已放入|已存入|暂存|待取|等待|送达.*(?:柜|驿站|代收点)|离开|发往/u.test(value));
}

export function detectPickupCompletion(shipment, { rules = [], now = Date.now() } = {}) {
  const events = Array.isArray(shipment?.logisticsEvents) ? shipment.logisticsEvents : [];
  const candidates = events.filter(event => validTime(event?.time) && event.time <= now
    && globalThis.PickCodeLogistics.eventTimeIssue(event, now) !== 'timeConflict' && (providerCollection(event) || completionKind(event.description)))
    .sort((a, b) => b.time - a.time);
  for (const event of candidates) {
    // Legacy station parsing can stamp this same receipt as the arrival because
    // its thank-you text names a locker. A distinct pending event still vetoes it below.
    if (validTime(shipment.arrivalAt) && (shipment.arrivalAt > event.time
      || shipment.arrivalAt === event.time && !codeReceipt(event.description))) continue;
    if (events.some(other => other?.time === event.time && other.description === event.description
      && (!other.provider || !event.provider || other.provider === event.provider)
      && globalThis.PickCodeLogistics.eventTimeIssue(other, now) === 'timeConflict')) continue;
    const structured = providerCollection(event);
    if (events.some(other => {
      // A historical display status cannot retract the identical previously verified Taobao pickup fact.
      if (structured === 'builtin-taobao-pickup-point-exit-v1' && other?.provider === 'taobao' && other.providerStatus === 'done'
        && ['time', 'description', 'providerStatusTag', 'providerStatusText'].every(key => other[key] === event[key])
        && (other.location || '') === (event.location || '') && (other.providerSubStatus || '') === (event.providerSubStatus || '')) return false;
      return !providerCollection(other) && (other?.provider === 'pdd' && other.providerStatus === 'IN_CABINET' || completionConflict(other?.description))
        && (!validTime(other.time) || other.time >= event.time);
    })) continue;
    const kind = structured ? 'user_collected' : completionKind(event.description);
    const description = String(event.description).slice(0, 600), value = compact(description);
    const builtinId = structured || (codeReceipt(description) ? 'builtin-code-receipt-v1'
      : signature.test(value) ? 'builtin-recipient-signature-v1' : collection.test(value) ? 'builtin-user-collection-v1' : '');
    const builtins = builtinPickupCompletionRules.filter(rule => rule.id === builtinId);
    const rule = [...builtins, ...rules.filter(rule => rule.enabled && rule.kind === kind && rule.keywords?.length && rule.keywords.every(keyword => value.includes(compact(keyword))))]
      .find(rule => rule.enabled && rule.kind === kind);
    if (!rule) continue;
    const provider = structured ? { provider: event.provider, providerStatus: event.providerStatus, providerStatusTag: event.providerStatusTag,
      ...(event.providerSubStatus ? { providerSubStatus: event.providerSubStatus } : {}), providerStatusText: event.providerStatusText || '' } : {};
    return { kind, description, eventTime: event.time, timePrecision: ['second', 'minute'].includes(event.timePrecision) ? event.timePrecision : 'unknown', ...provider,
      fingerprint: createHash('sha256').update(JSON.stringify([event.time, description, kind, ...(structured ? [provider] : [])])).digest('hex'), ruleId: rule.id, ruleVersion: rule.version };
  }
  return null;
}

export function pickupCompletionState(shipment = {}) {
  const saved = shipment.pickupCompletion;
  if (saved?.version === 1) return { version: 1, autoPicked: !!saved.autoPicked,
    manualOverride: ['picked', 'pending'].includes(saved.manualOverride) ? saved.manualOverride : '',
    completedAt: saved.autoPicked && validTime(saved.completedAt) ? saved.completedAt : 0, evidence: saved.autoPicked ? saved.evidence || null : null };
  return { version: 1, autoPicked: false, manualOverride: shipment.picked ? 'picked' : '', completedAt: 0, evidence: null };
}

export function effectivePicked(state) { return state.manualOverride ? state.manualOverride === 'picked' : state.autoPicked; }
