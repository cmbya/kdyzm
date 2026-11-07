/* Shared visual primitives for the review prototype; no production API calls. */
window.SCENES = [];
window.UI = (() => {
  const escape = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    box:'<path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7 5.8l10 5.6"/>',
    package:'<path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9"/>',
    list:'<rect x="5" y="5" width="14" height="17" rx="3"/><path d="M9 5V2h6v3M9 11h6M9 16h4"/>',
    user:'<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3z"/>',
    bell:'<path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9M10 22h4"/>',
    pin:'<path d="M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    plus:'<path d="M12 4v16M4 12h16"/>',
    refresh:'<path d="M20 8a8 8 0 0 0-14-3L3 8M3 3v5h5M4 16a8 8 0 0 0 14 3l3-3M21 21v-5h-5"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    more:'<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',
    back:'<path d="m15 5-7 7 7 7"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    check:'<path d="m4 12 5 5L20 6"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    filter:'<path d="M4 6h16M7 12h10M10 18h4"/>',
    copy:'<rect x="8" y="8" width="13" height="13" rx="3"/><path d="M16 8V3H3v13h5"/>',
    scan:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M7 7v10M11 7v10M15 7v10M18 7v10"/>',
    shield:'<path d="m12 2 8 4v6c0 6-8 10-8 10S4 18 4 12V6zM8 12l3 3 5-6"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="m10 2-1 3-3 1-3-1-2 4 3 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-3-2v-3l2-2-2-4-3 1-3-1-1-3z"/>',
    spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
    link:'<path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2M8 16l8-8"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6v1"/>',
    warning:'<path d="m12 3 10 18H2zM12 9v5M12 17v1"/>',
    download:'<path d="M12 3v13m-5-5 5 5 5-5M3 16v5h18v-5"/>',
    phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    edit:'<path d="m14 4 6 6M3 21l5-1L21 7l-5-5L3 15z"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
  const action = (target, fallback) => target ? `data-go="${escape(target)}"` : `data-demo="${escape(fallback || '这是设计演示，未修改真实数据。')}"`;
  const button = (text,target='',kind='primary') => `<button class="btn ${escape(kind)}" ${action(target,text+' · 设计演示')}>${escape(text)}</button>`;
  const link = (text,target) => `<button class="text-action" ${action(target,text)}>${escape(text)}</button>`;
  const badge = (text,tone='neutral') => `<span class="badge ${escape(tone)}">${escape(text)}</span>`;
  const row = (title,sub='',tail='',target='') => `<button class="setting-row" ${action(target,title+' · 设计演示')}><span class="row-text"><strong>${escape(title)}</strong>${sub?`<small>${escape(sub)}</small>`:''}</span><span class="row-tail">${tail.includes('<')?tail:escape(tail)}${icon('chevron')}</span></button>`;
  const toggle = (title,desc,on) => `<label class="toggle-row"><span class="row-text"><strong>${escape(title)}</strong>${desc?`<small>${escape(desc)}</small>`:''}</span><input type="checkbox" role="switch" ${on?'checked':''}><span class="switch" aria-hidden="true"></span></label>`;
  const field = (label,value,placeholder='',type='text') => `<label class="field"><span>${escape(label)}</span>${type==='textarea'?`<textarea placeholder="${escape(placeholder)}" rows="4">${escape(value)}</textarea>`:`<input type="${escape(type)}" value="${escape(value)}" placeholder="${escape(placeholder)}">`}</label>`;
  const section = (title,content,extra='') => `<section class="section"><div class="section-heading"><h2>${escape(title)}</h2>${extra}</div>${content}</section>`;
  const note = (text,tone='neutral') => `<div class="note ${escape(tone)}">${icon(tone==='red'||tone==='amber'?'warning':'info')}<span>${escape(text)}</span></div>`;
  const kv = (label,value) => `<div class="kv"><span>${escape(label)}</span><strong>${value.includes?.('<')?value:escape(value)}</strong></div>`;
  const segmented = (items,active=0) => `<div class="segmented">${items.map((item,i)=>`<button class="${i===active?'active':''}" aria-pressed="${i===active}" ${action(Array.isArray(item)?item[1]:'', '切换至'+(Array.isArray(item)?item[0]:item))}>${escape(Array.isArray(item)?item[0]:item)}</button>`).join('')}</div>`;
  const choice = (title,desc,selected) => `<label class="choice"><input type="checkbox" ${selected?'checked':''}><span class="choice-check" aria-hidden="true">${icon('check')}</span><span class="row-text"><strong>${escape(title)}</strong>${desc?`<small>${escape(desc)}</small>`:''}</span></label>`;
  const empty = (title,desc,actionHTML='') => `<div class="empty"><span class="empty-icon">${icon('box')}</span><h2>${escape(title)}</h2><p>${escape(desc)}</p>${actionHTML}</div>`;
  const pickupCard = (p={}) => {
    const title = Array.from(p.product || '').slice(0,10).join('');
    const code = p.code || '2-2-1001';
    return `<article class="pickup-card ${p.done?'collected':''}"><div class="pickup-top"><div class="chips">${badge(p.role||'待归属',p.role==='妈妈'?'amber':p.role==='我'?'blue':'neutral')}${p.platform?`<span class="platform">${escape(p.platform)}</span>`:''}${p.multi?badge(typeof p.multi==='string'?p.multi:'共 '+p.multi+' 件','teal'):''}</div><button class="icon-button" data-go="pickup-menu" aria-label="取件码 ${escape(code)} 更多操作">${icon('more')}</button></div><div class="pickup-grid"><div class="cabinet ${!p.cabinet?'no-cabinet':''}"><small>${p.cabinet?'柜号':'取件位置'}</small><strong>${escape(p.cabinet||'驿站')}</strong></div><button class="pickup-code ${code.length>12?'long-code':''}" ${action(p.target||'pickup-detail')} aria-label="查看取件码 ${escape(code)}">${escape(code)}</button><div class="pickup-meta"><span class="pickup-product" title="${escape(p.product||'')}" aria-label="${escape(p.product||'未关联商品')}">${escape(title)}${Array.from(p.product||'').length>10?'…':''}</span><time>${escape(p.time||'')}</time><span class="pickup-source">${escape(p.source||(p.unmatched?'短信':''))}</span></div><button class="collect-button ${p.done?'done':''}" ${p.multi?'data-go="pickup-multi"':'data-collect'}>${p.done?icon('check')+'已取':'取件'}</button></div>${p.unmatched?`<div class="pickup-bottom">${link('匹配订单','pickup-match')}<span class="small muted">也可直接取件</span></div>`:''}</article>`;
  };
  const packageCard = (p={}) => `<button class="package-card" ${action(p.target||'package-detail')}><div class="hrow between"><div class="chips"><span class="platform">${escape(p.platform||'手动记录')}</span>${badge(p.role||'我')}</div>${badge(p.status||'运输中',p.tone||'blue')}</div><div class="package-product"><span class="product-art" aria-hidden="true">${icon('box')}</span><span><strong>${escape(Array.from(p.product||'日用收纳用品').slice(0,10).join(''))}</strong><small>${escape(p.price||'')}${p.date?' · '+escape(p.date):''}</small></span>${icon('chevron')}</div><div class="package-summary">${icon('clock')}<span>${escape(p.summary||'暂无新物流')}</span></div></button>`;
  const timeline = items => `<ol class="timeline">${items.map(t=>`<li class="${t.active?'current':''}"><time>${escape(t.time)}</time><p>${escape(t.text)}</p></li>`).join('')}</ol>`;
  return {escape,icon,button,row,toggle,field,section,badge,note,kv,segmented,choice,empty,link,pickupCard,packageCard,timeline};
})();
