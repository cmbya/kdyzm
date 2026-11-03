const get = id => document.getElementById(id);
const cloneRules = rules => rules.map(rule => ({ ...rule, starts: [...rule.starts], keywords: [...rule.keywords] }));
const lines = value => value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
const kindLabel = rule => rule.kind === 'arrival' ? '到站事件' : '仅站点位置';

export function logisticsTestMessage(result, rule) {
  const matched = Boolean(result.station) && result.station === rule.expectedStation.trim();
  const valid = matched && (rule.kind !== 'arrival' || result.arrival === true);
  const details = [`提取站名：${result.station || '未识别'}`, result.arrival ? '判定为到站事件' : '未判定为到站事件'];
  details.push(rule.expectedStation.trim() ? (matched ? '站名与预期一致' : '站名与预期不一致') : '尚未填写预期站名');
  if (result.reason) details.push(result.reason);
  return { valid, text: details.join('；') };
}

export function initLogisticsAdmin({ api, notice }) {
  if (!get('logistics-settings-view')) return;
  const state = { loaded: false, rules: [], defaults: [], revision: 0, selectedId: '', dirty: false, pending: '', generation: 0 };
  const selected = () => state.rules.find(rule => rule.id === state.selectedId);
  const text = (id, value) => { get(id).textContent = value; };
  const element = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };

  function status(message, error = false) {
    text('logistics-status', message); get('logistics-status').classList.toggle('logistics-error', error);
  }

  function updateControls() {
    const locked = Boolean(state.pending);
    get('logistics-settings-view').setAttribute('aria-busy', String(locked));
    for (const control of get('logistics-settings-view').querySelectorAll('button, input, select, textarea')) control.disabled = locked || !state.loaded;
    get('logistics-reload').disabled = locked;
    get('logistics-save').disabled = locked || !state.loaded || !state.dirty;
    get('logistics-add').disabled = locked || !state.loaded || state.rules.length >= 100;
    get('logistics-restore').disabled = locked || !state.loaded || !state.defaults.length;
    get('logistics-enabled').disabled = locked || !selected();
    text('logistics-save', state.pending === 'save' ? '保存中…' : '保存规则');
    text('logistics-test', state.pending === 'test' ? '测试中…' : '测试当前草稿');
  }

  function renderList() {
    const list = get('logistics-list'); list.replaceChildren();
    text('logistics-total', `${state.rules.length} 条`);
    if (!state.rules.length) list.append(element('p', state.loaded ? '暂无规则，可新增或恢复默认。' : '规则尚未加载。', 'station-list-empty'));
    for (const rule of state.rules) {
      const item = element('button', '', `station-item${rule.id === state.selectedId ? ' active' : ''}`); item.type = 'button';
      item.setAttribute('aria-current', String(rule.id === state.selectedId));
      const name = element('span', '', 'station-name-row'); name.append(element('strong', rule.name || '未命名规则'));
      item.append(name, element('span', `${kindLabel(rule)} · ${rule.origin === 'builtin' ? '内置' : '自定义'}`, 'station-meta'), element('span', rule.enabled ? '启用中' : '已停用', `station-status${rule.enabled ? '' : ' paused'}`));
      item.addEventListener('click', () => { if (state.pending) return; state.selectedId = rule.id; renderList(); renderDetail(); updateControls(); }); list.append(item);
    }
  }

  function resetTest() {
    text('logistics-test-result', '测试只使用当前草稿，不会保存或修改已有物流。'); get('logistics-test-result').className = 'verify-result';
  }

  function renderMeta() {
    const rule = selected();
    text('logistics-detail-name', rule?.name || (rule ? '未命名规则' : '选择一条规则'));
    text('logistics-detail-origin', rule ? `${rule.origin === 'builtin' ? '内置规则 · 可编辑' : '自定义规则'} · ${kindLabel(rule)}` : '编辑后保存整组规则');
    get('logistics-enabled').setAttribute('aria-checked', String(Boolean(rule?.enabled)));
    get('logistics-enabled').classList.toggle('off', !rule?.enabled);
    text('logistics-kind-hint', rule?.kind === 'arrival' ? '识别明确到达取件站点的事件，并保留实际到站时间。' : '仅提取站点位置，不把这条文字作为新的到站证据。');
  }

  function renderDetail() {
    const rule = selected(); renderMeta(); resetTest();
    get('logistics-form').hidden = !rule; get('logistics-empty').hidden = Boolean(rule);
    text('logistics-empty', state.loaded ? '暂无规则，请新增规则或恢复默认。' : '请读取规则，连接失败时可点击“重新读取”。');
    if (!rule) { get('logistics-form').reset(); return; }
    for (const [id, value] of Object.entries({ name: rule.name, kind: rule.kind, starts: rule.starts.join('\n'), end: rule.end, keywords: rule.keywords.join('\n'), sample: rule.sample, expected: rule.expectedStation })) get(`logistics-${id}`).value = value;
  }

  function changed() {
    state.dirty = true; resetTest(); renderMeta(); renderList(); updateControls(); status('有未保存更改。测试通过后，点击“保存规则”使整组规则生效。');
  }

  async function perform(pending, handler) {
    if (state.pending) return;
    const generation = state.generation;
    state.pending = pending; updateControls();
    try { await handler(() => generation === state.generation); }
    catch (error) {
      if (generation !== state.generation) { if (error.status === 401) notice('登录已失效，请重新登录。', true); return; }
      const message = error.status === 409 ? '规则已在其他页面更新，当前草稿仍保留。请复制需要保留的内容，再点击“重新读取”获取最新规则。' : error.message || '操作未完成，请重试。';
      if (pending === 'test') { text('logistics-test-result', message); get('logistics-test-result').className = 'verify-result warning'; }
      status(message, true); notice(message, true);
    } finally { if (generation === state.generation) { state.pending = ''; updateControls(); } }
  }

  function accept(data) {
    state.rules = cloneRules(data.rules); state.defaults = cloneRules(data.defaults); state.revision = data.revision; state.loaded = true; state.dirty = false;
    if (!selected()) state.selectedId = state.rules[0]?.id || '';
    renderList(); renderDetail();
  }

  async function load() {
    if (state.pending || state.dirty && !confirm('重新读取会丢弃当前未保存更改，继续吗？')) return;
    await perform('load', async current => {
      status('正在读取物流识别规则…');
      const data = await api('/v1/admin/logistics-rules'); if (!current()) return;
      accept(data); status('规则已读取。修改仅在点击“保存规则”后生效。');
    });
  }

  async function save() {
    if (!state.loaded || !state.dirty || state.pending || selected() && !get('logistics-form').reportValidity()) return;
    await perform('save', async current => {
      const data = await api('/v1/admin/logistics-rules', { method: 'PATCH', body: JSON.stringify({ revision: state.revision, rules: state.rules }) }); if (!current()) return;
      accept(data); status('已保存。下次采集/刷新物流使用新规则，App 本机规则不受影响。'); notice('后台物流识别规则已保存。');
    });
  }

  async function testRule() {
    const rule = selected(); if (!rule || state.pending || !get('logistics-form').reportValidity()) return;
    if (!rule.sample.trim()) { text('logistics-test-result', '请先填写物流文字样例。'); get('logistics-sample').focus(); return; }
    await perform('test', async current => {
      text('logistics-test-result', '正在测试当前草稿…'); get('logistics-test-result').className = 'verify-result';
      const result = await api('/v1/admin/logistics-rules/test', { method: 'POST', body: JSON.stringify({ rule, sample: rule.sample }) }); if (!current()) return;
      const message = logisticsTestMessage(result, rule); text('logistics-test-result', message.text); get('logistics-test-result').className = `verify-result ${message.valid ? 'ok' : 'warning'}`;
    });
  }

  for (const [id, key] of Object.entries({ name: 'name', kind: 'kind', starts: 'starts', end: 'end', keywords: 'keywords', sample: 'sample', expected: 'expectedStation' })) {
    get(`logistics-${id}`).addEventListener('input', event => {
      const rule = selected(); if (!rule || state.pending) return;
      rule[key] = key === 'starts' || key === 'keywords' ? lines(event.target.value) : event.target.value; changed();
    });
  }
  get('logistics-enabled').addEventListener('click', () => { const rule = selected(); if (!rule || state.pending) return; rule.enabled = !rule.enabled; changed(); });
  get('logistics-add').addEventListener('click', () => {
    if (!state.loaded || state.pending || state.rules.length >= 100) return;
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const rule = { id: `manual_${id}`, name: '新规则', enabled: false, kind: 'arrival', starts: [], end: '', keywords: [], sample: '', expectedStation: '', origin: 'manual' };
    state.rules.unshift(rule); state.selectedId = rule.id; changed(); renderDetail(); get('logistics-name').focus();
  });
  get('logistics-delete').addEventListener('click', () => {
    const rule = selected(); if (!rule || state.pending || !confirm(`删除“${rule.name || '未命名规则'}”？点击“保存规则”后生效。`)) return;
    state.rules = state.rules.filter(item => item.id !== rule.id); state.selectedId = state.rules[0]?.id || ''; changed(); renderDetail();
  });
  get('logistics-restore').addEventListener('click', () => {
    if (!state.loaded || state.pending || !confirm('用内置默认规则替换当前整组规则？自定义规则和未保存更改会被替换，点击“保存规则”后生效。')) return;
    state.rules = cloneRules(state.defaults); state.selectedId = state.rules[0]?.id || ''; changed(); renderDetail();
  });
  get('logistics-reload').addEventListener('click', load);
  get('logistics-save').addEventListener('click', save);
  get('logistics-test').addEventListener('click', testRule);
  get('logistics-form').addEventListener('submit', event => { event.preventDefault(); save(); });
  for (const id of ['basic-settings-tab', 'station-settings-tab']) get(id).addEventListener('click', () => { get('logistics-settings-view').hidden = true; get('logistics-settings-tab').classList.remove('active'); });
  get('logistics-settings-tab').addEventListener('click', () => {
    // Reuse the existing tab handler so station analysis polling closes with its page.
    get('basic-settings-tab').click(); get('settings-basic-view').hidden = true; get('basic-settings-tab').classList.remove('active');
    get('logistics-settings-view').hidden = false; get('logistics-settings-tab').classList.add('active'); text('settings-page-title', '物流识别规则');
    if (!state.loaded && !state.pending) load();
  });
  window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });

  return { reset() {
    state.generation++; state.loaded = false; state.rules = []; state.defaults = []; state.revision = 0; state.selectedId = ''; state.dirty = false; state.pending = '';
    renderList(); renderDetail(); updateControls(); status('尚未读取规则。'); get('basic-settings-tab').click();
  } };
}
