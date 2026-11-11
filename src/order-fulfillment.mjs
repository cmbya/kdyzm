// Explicit local-delivery metadata takes priority. Never reject ordinary food,
// drinks or takeaway supplies merely because they are sold as physical goods.
export function isLocalDeliveryOrder(order, platform) {
  if (!['taobao', 'jd'].includes(platform || order?.platform)) return false;
  if (order?.fulfillmentType === 'local_delivery') return true;
  const labels = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    for (const [key, item] of Object.entries(value)) {
      if (['wareList', 'subOrders', 'itemInfo', 'shipments', 'title', 'name'].includes(key)) continue;
      if (typeof item === 'string' && /type|biz|business|delivery|shipping|channel|service|status|tag|label|url|href/i.test(key)) labels.push(item);
      else if (typeof item === 'object') visit(item, depth + 1);
    }
  };
  visit(order);
  if (labels.some(value => /外卖|即时配送|同城配送|小时达|分钟达|淘宝闪购|京东秒送|饿了么|骑手|等待接单|商家备餐|餐品制作|waimai|ele.me|jddj.com/i.test(value))) return true;
  const title = String(order?.title || (order?.wareList || []).map(item => item.name || '').join(' / ')
    || (order?.subOrders || []).map(item => item.itemInfo?.title || '').join(' / '));
  // Some PC lists omit delivery metadata. A ready-meal combination with a
  // person/serving count is a narrow fallback (e.g. 手撕包菜+木桶饭 1人份).
  return /(?:\+|＋|搭配|配).*(?:米饭|木桶饭|套餐)/.test(title) && /[一二三四五六七八九十\d]+\s*人份/.test(title)
    && !/速冻|冷冻|自热|预制|料理包|方便|罐头|模型|玩具/.test(title);
}
