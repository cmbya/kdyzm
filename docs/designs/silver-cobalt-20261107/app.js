(() => {
  const U=window.UI;
  let active='pickup', width=390, toastTimer;
  const groups=['取件','包裹','设置','识别与优化','帮助'];
  const labels={'pickup':'取件列表 · 按站点','pickup-time':'取件列表 · 按时间','pickup-history':'展开历史取件','pickup-empty':'取件空状态','pickup-long':'长码与缺失信息','pickup-unmatched':'未匹配取件详情','package-error':'包裹更新失败','package-loading':'包裹加载中','package-empty':'包裹空状态','package-refreshing':'后台更新中','notifications-empty':'通知空状态','notifications-review':'待确认通知','notifications-error':'异常通知','notifications-sync':'同步通知','update':'发现新版本'};
  const displayName=s=>labels[s.id]||s.title;
  const getScene=id=>window.SCENES.find(s=>s.id===id);
  const statusbar=()=>'<div class="statusbar"><span>9:41</span><span class="status-icons">▮▮▮ ▰ <i class="battery"></i></span></div>';
  function phoneHTML(scene) {
    const top=(scene.top||[]).map(a=>`<button class="icon-button" aria-label="${U.escape(a.label)}" data-go="${U.escape(a.target)}">${U.icon(a.icon)}${a.icon==='bell'?'<span class="notification-dot">2</span>':''}</button>`).join('');
    const back=scene.back?`<button class="icon-button" aria-label="${scene.sheet?'关闭':'返回'}" data-go="${U.escape(scene.back)}">${U.icon(scene.sheet?'close':'back')}</button>`:'';
    const tabs=scene.tab?`<nav class="tabbar" aria-label="主导航">${[['pickup','box','取件列表'],['packages','list','包裹记录'],['my','user','我的']].map(([id,icon,label])=>`<button class="${scene.tab===id?'active':''}" ${scene.tab===id?'aria-current="page"':''} data-go="${id}">${U.icon(icon)}<span>${label}</span></button>`).join('')}</nav>`:'';
    return `<div class="phone ${scene.sheet?'sheet-phone':''}" data-scene="${scene.id}">${scene.sheet?'<div class="sheet-backdrop" aria-hidden="true"><p>取件助手</p></div>':''}${statusbar()}<header class="phone-header ${scene.back?'subpage':''}">${!scene.sheet?back:''}<h1>${U.escape(scene.title)}</h1><div class="header-actions">${top}${scene.sheet?back:''}</div></header><div class="page-content">${scene.content()}</div>${scene.footer?`<footer class="page-footer">${scene.footer()}</footer>`:tabs||'<div class="phone-safearea"></div>'}</div>`;
  }
  function renderNav(filter='') {
    const scenes=window.SCENES.filter(s=>(s.title+s.group+s.description).includes(filter));
    document.querySelector('#scene-nav').innerHTML=groups.map(group=>`<section class="nav-group"><h2>${group}</h2>${scenes.filter(s=>s.group===group).map(s=>`<button class="nav-item" data-go="${s.id}" ${s.id===active?'aria-current="page"':''}><span>${String(window.SCENES.indexOf(s)+1).padStart(2,'0')}</span>${U.escape(displayName(s))}</button>`).join('')}</section>`).join('');
  }
  function render(id,updateHash=true) {
    const scene=getScene(id)||window.SCENES[0];
    if(!scene) return;
    active=scene.id;
    document.querySelector('#review-stage').hidden=false;
    document.querySelector('#overview').hidden=true;
    document.querySelector('#overview-button').textContent='设计总览';
    document.querySelector('#phone-host').innerHTML=phoneHTML(scene);
    document.querySelector('#phone-host .phone').style.width=width+'px';
    if(scene.id==='pickup-conflict')document.querySelectorAll('#phone-host .choice input').forEach(input=>{input.type='radio';input.name='code-choice';});
    if(scene.id==='packages-filter')document.querySelectorAll('#phone-host .section').forEach((section,i)=>section.querySelectorAll('.choice input').forEach(input=>{input.type='radio';input.name='filter-'+i;}));
    document.querySelector('#scene-title').textContent=displayName(scene);
    document.querySelector('#scene-group').textContent=scene.group+' / '+String(window.SCENES.indexOf(scene)+1).padStart(2,'0');
    document.querySelector('#scene-description').textContent=scene.description;
    document.querySelector('#scene-route').textContent=scene.route||'共用组件';
    document.querySelector('#scene-position').textContent=String(window.SCENES.indexOf(scene)+1).padStart(2,'0')+' / '+window.SCENES.length+' 场景';
    document.querySelector('#scene-select').value=scene.id;
    if(updateHash) history.replaceState(null,'','#'+scene.id);
    renderNav(document.querySelector('#scene-search').value);
  }
  function overview(sheetIndex) {
    document.querySelector('#review-stage').hidden=true;
    document.querySelector('#overview').hidden=false;
    document.querySelector('#overview-button').textContent='返回逐页';
    const ids=Number.isInteger(sheetIndex)?window.SCENES.slice(sheetIndex*6,sheetIndex*6+6).map(s=>s.id):['pickup','packages','my','pickup-detail','corrections','widgets'];
    const label=Number.isInteger(sheetIndex)?`全案 ${sheetIndex+1} / ${Math.ceil(window.SCENES.length/6)}`:'主界面总览';
    document.querySelector('#overview').innerHTML=`<header class="overview-title"><div><h2>B · 细腻柔雾</h2><p>取件助手 · ${label} / ${window.SCENES.length} 个场景 / 合成示例数据</p></div><span class="eyebrow">SILVER FROST · APPROVED DIRECTION</span></header><div class="overview-grid">${ids.map((id)=>{const s=getScene(id);return `<article class="overview-item"><h3><span>${String(window.SCENES.indexOf(s)+1).padStart(2,'0')}</span>${U.escape(displayName(s))}</h3>${phoneHTML(s)}</article>`;}).join('')}</div>`;
  }
  function toast(text) { clearTimeout(toastTimer);const el=document.querySelector('#prototype-toast');el.textContent=text;el.classList.add('visible');toastTimer=setTimeout(()=>el.classList.remove('visible'),3300); }
  document.addEventListener('click',e=>{
    const dismiss=e.target.closest('[data-dismiss]');
    if(dismiss){dismiss.closest('.notification-item')?.remove();toast('已关闭本条通知；业务状态保持不变，有新进展再提醒。');return;}
    const go=e.target.closest('[data-go]');
    if(go) { if(getScene(go.dataset.go)){document.body.classList.remove('board');render(go.dataset.go);}else toast('关联页面尚未配置：'+go.dataset.go);return; }
    const collect=e.target.closest('[data-collect]');
    if(collect){const done=!collect.classList.contains('done');collect.classList.toggle('done',done);collect.closest('.pickup-card')?.classList.toggle('collected',done);collect.innerHTML=done?U.icon('check')+'已取':'取件';toast(done?'已标记领取 · 演示数据；不操作购物平台':'已撤销领取 · 演示数据');return;}
    const demo=e.target.closest('[data-demo]');if(demo){toast(demo.dataset.demo);return;}
    const size=e.target.closest('[data-width]');if(size){width=Number(size.dataset.width);document.querySelectorAll('[data-width]').forEach(b=>b.setAttribute('aria-pressed',b===size));render(active);}
  });
  document.addEventListener('change',e=>{
    if(e.target.matches('[role=switch]'))toast('设计演示：'+(e.target.checked?'已开启':'已关闭')+'，不会改变手机或后台设置。');
    if(e.target.matches('.choice input') && ['pickup-match','pickup-multi'].includes(active)){
      const checked=document.querySelectorAll('#phone-host .choice input:checked').length;
      const primary=document.querySelector('#phone-host .page-footer .btn.primary');
      if(primary){primary.disabled=checked===0;primary.textContent=active==='pickup-match'?`确认关联所选 ${checked} 件`:`标记所选 ${checked} 件已取`;}
      if(active==='pickup-match'){const badge=document.querySelector('#phone-host .page-content > .stack > .hrow .badge');if(badge)badge.textContent=`已选 ${checked} / 2 件`;}
    }
  });
  document.querySelector('#overview-button').addEventListener('click',()=>document.querySelector('#overview').hidden?overview():render(active));
  document.querySelector('#scene-search').addEventListener('input',e=>renderNav(e.target.value));
  document.querySelector('#scene-select').innerHTML=groups.map(g=>`<optgroup label="${g}">${window.SCENES.filter(s=>s.group===g).map(s=>`<option value="${s.id}">${U.escape(displayName(s))}</option>`).join('')}</optgroup>`).join('');
  document.querySelector('#scene-select').addEventListener('change',e=>render(e.target.value));
  for(const [selector,delta] of [['#previous-scene',-1],['#next-scene',1]])document.querySelector(selector).addEventListener('click',()=>render(window.SCENES[(window.SCENES.findIndex(s=>s.id===active)+delta+window.SCENES.length)%window.SCENES.length].id));
  window.addEventListener('hashchange',()=>render(location.hash.slice(1),false));
  window.designPreview={render,overview,phoneHTML,setWidth(w){width=w;render(active);},get active(){return active;}};
  render(location.hash.slice(1)||'pickup',false);
  const query=new URLSearchParams(location.search);
  if(query.has('board')){document.body.classList.add('board');const requested=Number(query.get('sheet'));overview(query.has('sheet')&&requested>=1&&requested<=Math.ceil(window.SCENES.length/6)?requested-1:undefined);}
})();
