const get = id => document.getElementById(id);
const labels = { pending: '等待分析', failed: '等待重试', review: '待核对', applied: '已应用', rolled_back: '已回滚' };
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '—';

export function initPickupCompletionAdmin({ api, notice }) {
  const view = get('pickup-completion-settings-view'); if (!view) return;
  const state = { loaded: false, pending: false, dirty: false, generation: 0 };
  const node = (tag, text, className) => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };
  const status = text => { get('pickup-completion-status').textContent = text; };
  function controls() {
    view.setAttribute('aria-busy', String(state.pending));
    get('pickup-completion-enabled').disabled = state.pending || !state.loaded;
    get('pickup-completion-ai-enabled').disabled = state.pending || !state.loaded;
    get('pickup-completion-save').disabled = state.pending || !state.loaded || !state.dirty;
    get('pickup-completion-reload').disabled = state.pending;
    for (const button of get('pickup-completion-history').querySelectorAll('button')) button.disabled = state.pending;
  }
  function list(id, items, render, empty, limit = 30) {
    const target = get(id); target.replaceChildren();
    if (!items.length) target.append(node('li', empty, 'hint'));
    for (const item of items.slice(0, limit)) { const row = node('li', ''); render(row, item); target.append(row); }
  }
  function accept(data) {
    state.loaded = true; state.dirty = false;
    get('pickup-completion-enabled').checked = data.config.enabled;
    get('pickup-completion-ai-enabled').checked = data.config.aiEnabled;
    const stats = data.stats || {};
    list('pickup-completion-rules', data.monitorRules || [], (row, item) => {
      row.append(node('p', (item.keywords || []).join(' ＋ ') + ' · ' + item.label + (item.enabled === false ? ' · 已停用' : '')));
    }, '暂无监测词组。', 120);
    get('pickup-completion-ai-state').textContent = `${data.aiReady ? (data.running ? 'AI 正在分析' : 'AI 自动优化已就绪') : 'AI 暂未运行，请检查全局开关与默认渠道'} · 今日共享用量 ${stats.usageToday || 0}/${stats.dailyLimit || 20} · ${stats.review || 0} 条待核对`;
    list('pickup-completion-recent', data.recent || [], (row, item) => {
      row.append(node('p', `${item.fragment} · ${date(item.completedAt)}${item.manualOverride === 'pending' ? ' · 已手动撤销' : ''}`));
    }, '暂无自动完成记录。');
    list('pickup-completion-candidates', data.candidates || [], (row, item) => {
      row.append(node('p', `${item.fragment} · ${labels[item.status] || '待核对'}`));
      if (item.error) row.append(node('p', item.error, 'hint'));
    }, '暂无新的关键词建议。');
    list('pickup-completion-history', data.history || [], (row, item) => {
      row.append(node('p', `${item.summary} · ${labels[item.status] || '已应用'} · ${date(item.appliedAt)}`));
      if (item.canRollback) {
        const button = node('button', '回滚关键词', 'secondary'); button.type = 'button';
        button.setAttribute('aria-label', `回滚关键词：${item.summary}`);
        button.addEventListener('click', () => rollback(item)); row.append(button);
      }
    }, '尚无自动应用的关键词。');
  }
  async function perform(handler, focusId) {
    if (state.pending) return;
    const focused = document.activeElement;
    const generation = state.generation; state.pending = true; controls();
    try { await handler(() => generation === state.generation); }
    catch (error) { if (generation === state.generation) { const message = error.message || '操作未完成，请重试。'; status(message); notice(message, true); } }
    finally { if (generation === state.generation) { state.pending = false; controls(); (focusId ? get(focusId) : focused)?.focus(); } }
  }
  async function load() {
    if (state.dirty && !confirm('刷新将丢弃未保存的领取设置，继续吗？')) return;
    await perform(async current => { const data = await api('/v1/admin/pickup-completion'); if (!current()) return; accept(data); status('设置与记录已更新。'); });
  }
  async function save() {
    if (!state.loaded || !state.dirty) return;
    await perform(async current => {
      const data = await api('/v1/admin/pickup-completion', { method: 'PUT', body: JSON.stringify({ enabled: get('pickup-completion-enabled').checked, aiEnabled: get('pickup-completion-ai-enabled').checked }) });
      if (!current()) return; accept(data); status('取件自动监测设置已保存。'); notice('取件自动监测设置已保存。');
    });
  }
  async function rollback(item) {
    if (state.pending || !confirm(`回滚“${item.summary}”？将撤回此关键词带来的自动判断，手动操作保留。`)) return;
    await perform(async current => {
      await api('/v1/admin/pickup-completion/rollback', { method: 'POST', body: JSON.stringify({ historyId: item.id }) });
      if (!current()) return;
      const data = await api('/v1/admin/pickup-completion'); if (!current()) return;
      accept(data); status('关键词已回滚，自动判断已重算。'); notice('关键词已回滚。');
    }, 'pickup-completion-reload');
  }
  for (const id of ['pickup-completion-enabled', 'pickup-completion-ai-enabled']) get(id).addEventListener('change', () => { state.dirty = true; controls(); status('有未保存的设置。'); });
  get('pickup-completion-form').addEventListener('submit', event => { event.preventDefault(); return save(); });
  get('pickup-completion-reload').addEventListener('click', load);
  for (const id of ['basic-settings-tab', 'station-settings-tab', 'logistics-settings-tab']) get(id).addEventListener('click', () => { view.hidden = true; get('pickup-completion-settings-tab').classList.remove('active'); });
  get('pickup-completion-settings-tab').addEventListener('click', () => {
    get('basic-settings-tab').click(); get('settings-basic-view').hidden = true; get('basic-settings-tab').classList.remove('active');
    view.hidden = false; get('pickup-completion-settings-tab').classList.add('active'); get('settings-page-title').textContent = '取件自动监测';
    if (!state.loaded) return load();
  });
  return { reset() {
    state.generation++; state.loaded = false; state.dirty = false; state.pending = false;
    get('pickup-completion-enabled').checked = true; get('pickup-completion-ai-enabled').checked = true;
    for (const id of ['rules', 'recent', 'candidates', 'history']) get(`pickup-completion-${id}`).replaceChildren();
    get('pickup-completion-ai-state').textContent = '尚未读取 AI 状态。'; status('尚未读取设置。'); controls();
  } };
}
