const get = id => document.getElementById(id);
const labels = { pending: '等待分析', failed: '等待重试', review: '待核对', applied: '已应用', rolled_back: '已回滚' };
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '—';

export function initPickupCompletionAdmin({ api, notice }) {
  const view = get('pickup-completion-settings-view'); if (!view) return;
  const state = { loaded: false, pending: false, dirty: false, generation: 0, editing: null };
  const node = (tag, text, className) => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };
  const status = text => { get('pickup-completion-status').textContent = text; };
  function controls() {
    view.setAttribute('aria-busy', String(state.pending));
    get('pickup-completion-enabled').disabled = state.pending || !state.loaded;
    get('pickup-completion-ai-enabled').disabled = state.pending || !state.loaded;
    get('pickup-completion-save').disabled = state.pending || !state.loaded || !state.dirty;
    get('pickup-completion-reload').disabled = state.pending;
    get('pickup-rule-new').disabled = state.pending || !state.loaded;
    for (const id of ['pickup-rule-save', 'pickup-rule-cancel', 'pickup-rule-kind', 'pickup-rule-keywords', 'pickup-rule-enabled']) get(id).disabled = state.pending;
    for (const button of get('pickup-completion-rules').querySelectorAll('button')) button.disabled = state.pending;
    for (const button of get('pickup-completion-history').querySelectorAll('button')) button.disabled = state.pending;
  }
  function list(id, items, render, empty, limit = 30) {
    const target = get(id); target.replaceChildren();
    if (!items.length) target.append(node('li', empty, 'hint'));
    for (const item of items.slice(0, limit)) { const row = node('li', ''); render(row, item); target.append(row); }
  }
  function accept(data) {
    state.loaded = true;
    if (!state.dirty) {
      get('pickup-completion-enabled').checked = data.config.enabled;
      get('pickup-completion-ai-enabled').checked = data.config.aiEnabled;
    }
    const stats = data.stats || {};
    list('pickup-completion-rules', data.monitorRules || [], (row, item) => {
      row.append(node('p', (item.keywords || []).join(' ＋ ') + ' · ' + item.label + (item.enabled === false ? ' · 已停用' : '')));
      if (item.editable) {
        const actions = node('div', '', 'actions');
        const edit = node('button', '编辑', 'secondary'); edit.type = 'button'; edit.addEventListener('click', () => editRule(item));
        const toggle = node('button', item.enabled === false ? '启用' : '停用', 'secondary'); toggle.type = 'button';
        toggle.addEventListener('click', () => {
          if (item.isExample && !confirm('停用这一类内置规则的全部示例？以后可点“恢复内置”恢复全部默认识别。')) return;
          if (!editRule(item)) return; get('pickup-rule-enabled').checked = item.enabled === false; return saveRule();
        });
        actions.append(edit, toggle);
        if (!item.isExample) {
          const builtin = item.ruleId.startsWith('builtin-');
          const remove = node('button', builtin ? '恢复内置' : '删除', 'secondary'); remove.type = 'button';
          remove.addEventListener('click', () => removeRule(item, builtin)); actions.append(remove);
        }
        row.append(actions);
      } else if (item.isExample) row.append(node('p', '平台状态证据，无需填写关键词。', 'hint'));
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
    catch (error) { if (generation === state.generation) { const message = error.message || '操作未完成，请重试。'; status(message); if (state.editing) get('pickup-rule-error').textContent = message; notice(message, true); } }
    finally { if (generation === state.generation) { state.pending = false; controls(); (focusId ? get(focusId) : focused)?.focus(); } }
  }
  async function load() {
    if ((state.dirty || state.editing) && !confirm('刷新将丢弃未保存的设置或规则，继续吗？')) return;
    state.dirty = false; closeEditor();
    await perform(async current => { const data = await api('/v1/admin/pickup-completion'); if (!current()) return; accept(data); status('设置与记录已更新。'); });
  }
  async function save() {
    if (!state.loaded || !state.dirty) return;
    await perform(async current => {
      const data = await api('/v1/admin/pickup-completion', { method: 'PUT', body: JSON.stringify({ enabled: get('pickup-completion-enabled').checked, aiEnabled: get('pickup-completion-ai-enabled').checked }) });
      if (!current()) return; state.dirty = false; accept(data); status('取件自动监测设置已保存。'); notice('取件自动监测设置已保存。');
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
  function closeEditor() { state.editing = null; get('pickup-rule-form').hidden = true; get('pickup-rule-keywords').value = ''; get('pickup-rule-error').textContent = ''; }
  function editRule(item) {
    if (state.pending || state.editing && !confirm('放弃当前未保存的规则编辑？')) return false;
    // getRandomValues also works on the NAS's plain HTTP admin page.
    state.editing = item || { ruleId: `manual_${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`, expectedVersion: 0, kind: 'user_collected', keywords: [], enabled: true };
    const rule = state.editing;
    get('pickup-rule-heading').textContent = item ? '编辑监测规则' : '新增监测规则';
    get('pickup-rule-note').textContent = rule.ruleId.startsWith('builtin-') ? '修改会替换这一类内置规则的全部示例。保存后可点“恢复内置”；若只想增加一种说法，请使用“新增规则”。' : '保存后会重新核对已有物流，手动取件操作优先保留。';
    get('pickup-rule-kind').value = rule.kind; get('pickup-rule-keywords').value = rule.keywords.join('\n');
    get('pickup-rule-enabled').checked = rule.enabled !== false; get('pickup-rule-error').textContent = '';
    get('pickup-rule-form').hidden = false; get('pickup-rule-keywords').focus(); return true;
  }
  async function saveRule() {
    if (!state.editing || state.pending) return;
    const item = state.editing;
    await perform(async current => {
      const data = await api(`/v1/admin/pickup-completion/rules/${encodeURIComponent(item.ruleId)}`, { method: 'PUT', body: JSON.stringify({
        kind: get('pickup-rule-kind').value, keywords: get('pickup-rule-keywords').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        enabled: get('pickup-rule-enabled').checked, expectedVersion: item.expectedVersion
      }) });
      if (!current()) return; closeEditor(); accept(data); status('规则已保存，已有物流已重新核对。'); notice('监测规则已保存。');
    });
  }
  async function removeRule(item, builtin) {
    if (state.pending || !confirm(builtin ? '恢复这一类内置规则？已有自动判断会重新核对。' : '删除这条规则？已有自动判断会重新核对，手动取件记录保留。')) return;
    await perform(async current => {
      const data = await api(`/v1/admin/pickup-completion/rules/${encodeURIComponent(item.ruleId)}`, { method: 'DELETE' });
      if (!current()) return; closeEditor(); accept(data); status(builtin ? '已恢复内置规则。' : '规则已删除。');
    });
  }
  get('pickup-rule-new').addEventListener('click', () => editRule());
  get('pickup-rule-cancel').addEventListener('click', closeEditor);
  get('pickup-rule-form').addEventListener('submit', event => { event.preventDefault(); return saveRule(); });
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
    closeEditor();
    get('pickup-completion-enabled').checked = true; get('pickup-completion-ai-enabled').checked = true;
    for (const id of ['rules', 'recent', 'candidates', 'history']) get(`pickup-completion-${id}`).replaceChildren();
    get('pickup-completion-ai-state').textContent = '尚未读取 AI 状态。'; status('尚未读取设置。'); controls();
  } };
}
