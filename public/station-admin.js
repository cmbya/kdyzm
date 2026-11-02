const get = id => document.getElementById(id);

const text = value => value === null || value === undefined ? '' : String(value);
const first = (...values) => values.find(value => value !== undefined && value !== null && text(value).trim() !== '') || '';

function aliasOf(value) {
  if (typeof value === 'string') return { id: '', name: value, source: '手动', subLocation: '' };
  return {
    id: first(value?.id),
    name: first(value?.name, value?.alias, value?.text),
    source: first(value?.sourceLabel, value?.source, '手动'),
    subLocation: first(value?.subLocation, value?.sub, value?.location),
  };
}

function stationOf(value) {
  const rawRegion = value?.region;
  const region = rawRegion && typeof rawRegion === 'object'
    ? [rawRegion.province, rawRegion.city, rawRegion.district, rawRegion.name].filter(Boolean).join(' · ')
    : first(rawRegion, value?.regionName);
  return {
    id: first(value?.id, value?.stationId),
    name: first(value?.name, value?.canonicalName, value?.canonical),
    region,
    enabled: value?.enabled !== false,
    aliases: (Array.isArray(value?.aliases) ? value.aliases : []).map(aliasOf).filter(alias => alias.name),
    raw: value,
  };
}

function candidateOf(value) {
  const suggested = value?.suggestedStation || value?.targetStation || {};
  const suggestion = value?.suggestion || {};
  const source = value?.source || {};
  return {
    id: first(value?.id, value?.candidateId),
    status: first(value?.status, value?.state, 'pending_review'),
    title: first(value?.title, value?.suggestedName, suggestion?.suggestedName, value?.name, value?.stationName, value?.rawSnippet, value?.snippet, '待核对站点片段'),
    rawText: first(value?.rawText, value?.fragment, value?.snippet, value?.rawSnippet, value?.sms, value?.sourceText),
    sms: first(value?.sms, value?.smsName, value?.messageSnippet, source.sms),
    logistics: first(value?.logistics, value?.logisticsName, value?.platformStation, source.logistics),
    region: first(value?.sourceRegion, value?.region, value?.regionName, source.region),
    suggestedStationId: first(value?.stationId, value?.suggestedStationId, suggestion?.targetStationId, suggested.id),
    suggestedName: first(value?.suggestedStationName, value?.target, value?.targetName, suggestion?.suggestedName, suggested.name),
    alias: first(value?.alias, suggestion?.alias),
    subLocation: first(value?.subLocation, value?.sub, value?.locker, value?.lockerNo, suggestion?.subLocation),
    evidence: Array.isArray(value?.evidence) ? value.evidence.join('；') : Array.isArray(suggestion?.evidence) ? suggestion.evidence.join('；') : first(value?.evidence, suggestion?.evidence, value?.reason, value?.basis, '请核对原文与地区信息。'),
    occurrenceCount: Number(first(value?.occurrenceCount, value?.occurrences, value?.count, value?.times, 1)) || 1,
    raw: value,
  };
}

function cloneStation(station) {
  return { id: station.id, name: station.name, region: station.region, enabled: station.enabled, aliases: station.aliases.map(alias => ({ ...alias })) };
}

function sourceLabel(source) {
  const value = text(source).toLowerCase();
  if (value === 'platform') return '物流';
  if (value === 'sms') return '短信';
  if (value === 'manual') return '手动';
  if (value === 'ai') return 'AI辅助';
  if (value.includes('logistic') || value.includes('平台') || value.includes('物流')) return '物流';
  if (value.includes('sms') || value.includes('短信')) return '短信';
  if (value.includes('ai')) return 'AI辅助';
  return source || '手动';
}

export function compareStationNames(a, b, stations) {
  const key = value => text(value).normalize('NFKC').replace(/[零〇一二两三四五六七八九十]+(?=卡|号(?:柜|快递柜|自提柜|楼|门)|栋|幢)/gu, raw => {
    const digits = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
    const parts = raw.split('十'); return parts.length === 2 ? String((parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0)) : [...raw].map(c => digits[c]).join('');
  }).replace(/[\s\p{P}]+/gu, '').toLowerCase();
  const location = value => { const s = key(value); return [/(\d+)号?(?:快递柜|自提柜|柜)/u.exec(s)?.[1], /(东|西|南|北)(?:大)?门/u.exec(s)?.[1], /(\d+)卡/u.exec(s)?.[1], /(\d+)(?:栋|幢|号楼)/u.exec(s)?.[1]]; };
  const x = location(a), y = location(b);
  if (x.some((part, i) => part && y[i] && part !== y[i])) return { same: false, conflict: true };
  const lookup = value => stations.filter(s => s.enabled && [s.name, ...s.aliases.map(alias => alias.name)].some(name => key(name) === key(value)));
  const first = lookup(a), second = lookup(b);
  if (first.length > 1 || second.length > 1) return { same: false, conflict: false };
  return { same: !!key(a) && (key(a) === key(b) || first.length === 1 && second.length === 1 && first[0].id === second[0].id), conflict: first.length === 1 && second.length === 1 && first[0].id !== second[0].id };
}

export function createAnalysisDetails(analysis, { running = false } = {}) {
  const details = document.createElement('details'); details.className = 'analysis-details';
  const summary = document.createElement('summary'); summary.textContent = '分析详情'; details.append(summary);
  const note = value => { const row = document.createElement('p'); row.textContent = value; details.append(row); };
  if (!analysis || typeof analysis !== 'object') { note('尚未分析（尚无实际 AI 输入或返回）。'); return details; }
  const time = value => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString('zh-CN') : '';
  const startedAt = time(analysis.startedAt), finishedAt = time(analysis.finishedAt);
  if (startedAt) note(`最近调用：${startedAt}${finishedAt ? ` · 结束：${finishedAt}` : ''}`);
  if (!finishedAt) note(running ? '尚未完成（后台任务仍在运行）。' : '未完成（任务已停止或中断）。');
  const json = (label, value) => {
    const heading = document.createElement('p'); heading.className = 'analysis-label'; heading.textContent = label;
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(value, null, 2); details.append(heading, pre);
  };
  if (analysis.input && typeof analysis.input === 'object') {
    const input = {};
    for (const key of ['fragment', 'region', 'knownStations', 'knownStationsTruncated']) if (Object.prototype.hasOwnProperty.call(analysis.input, key)) input[key] = analysis.input[key];
    json('实际脱敏输入', input);
  } else note('没有已记录的实际脱敏输入。');
  if (analysis.result !== null && analysis.result !== undefined) json('校验后的返回结构', analysis.result);
  else note('尚无通过校验的返回结构。');
  if (analysis.error && typeof analysis.error === 'object') {
    const error = document.createElement('p'); error.className = 'analysis-error'; error.textContent = `安全错误：${text(analysis.error.message)}${analysis.error.code ? `（${text(analysis.error.code)}）` : ''}`; details.append(error);
  }
  return details;
}

export function initStationAdmin({ api, notice }) {
  if (!get('station-settings-view')) return;

  const state = {
    loaded: false,
    open: false,
    stations: [],
    candidates: [],
    selectedId: '',
    draft: null,
    newStation: false,
    dirty: false,
    query: '',
    queueOpen: false,
    aiConfig: null,
    aiDirty: false,
    aiRunning: false,
    aiPollTimer: null,
    aiPollStarted: 0,
    reviewCandidate: null,
    analysisOpen: new Set(),
  };

  const setHidden = (id, hidden) => { get(id).hidden = hidden; };
  const setText = (id, value) => { get(id).textContent = text(value); };
  const button = (label, handler, className = 'secondary') => {
    const element = document.createElement('button');
    element.type = 'button'; element.className = className; element.textContent = label;
    element.addEventListener('click', async () => { if (element.disabled) return; element.disabled = true; try { await handler(); } catch (error) { notice(error.message || '操作未完成，请重试。', true); } finally { element.disabled = false; } }); return element;
  };

  function normalized(value) { return text(value).trim().toLowerCase().replace(/[\s\p{P}]+/gu, ''); }
  function currentStation() { return state.stations.find(station => station.id === state.selectedId); }
  function selectedOrDraft() { return state.draft || currentStation(); }

  function renderDirectory() {
    const list = get('station-list');
    const query = state.query.toLowerCase();
    const visible = state.stations.filter(station => !query || [station.name, station.region, ...station.aliases.map(alias => alias.name)].some(value => text(value).toLowerCase().includes(query)));
    setText('station-total', `${state.stations.length} 个`);
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p'); empty.className = 'station-list-empty'; empty.textContent = state.stations.length ? '没有匹配的站点' : '尚无站点'; list.append(empty);
    }
    for (const station of visible) {
      const item = document.createElement('button'); item.type = 'button'; item.className = `station-item ${station.id === state.selectedId && !state.queueOpen ? 'active' : ''}`;
      item.setAttribute('aria-current', station.id === state.selectedId && !state.queueOpen ? 'true' : 'false');
      const nameRow = document.createElement('span'); nameRow.className = 'station-name-row';
      const name = document.createElement('strong'); name.textContent = station.name || '未命名站点'; nameRow.append(name, document.createTextNode('›'));
      const meta = document.createElement('span'); meta.className = 'station-meta'; meta.textContent = `${station.region || '未填写地区'} · ${station.aliases.length} 个名称`;
      const status = document.createElement('span'); status.className = `station-status ${station.enabled ? '' : 'paused'}`; status.textContent = station.enabled ? '启用中' : '已暂停';
      item.append(nameRow, meta, status); item.addEventListener('click', () => selectStation(station.id)); list.append(item);
    }
    setText('station-queue-count', state.candidates.length);
    setText('candidate-count', `${state.candidates.length} 条待核对`);
  }

  function renderAliases() {
    const list = get('alias-list'); list.replaceChildren();
    const draft = selectedOrDraft();
    const aliases = draft?.aliases || [];
    setText('alias-count', `${aliases.length} 个名称`);
    if (!aliases.length) {
      const empty = document.createElement('p'); empty.className = 'no-alias'; empty.textContent = '暂无别名，添加物流或短信中的站点名称'; list.append(empty); return;
    }
    aliases.forEach((alias, index) => {
      const row = document.createElement('div'); row.className = 'alias-row';
      const source = document.createElement('select'); source.setAttribute('aria-label', `别名 ${index + 1} 来源`);
      for (const optionValue of ['物流', '短信', '手动', 'AI辅助']) { const option = document.createElement('option'); option.value = optionValue; option.textContent = optionValue; source.append(option); }
      source.value = sourceLabel(alias.source);
      const name = document.createElement('input'); name.value = alias.name; name.maxLength = 200; name.setAttribute('aria-label', `别名 ${index + 1} 原始名称`);
      const location = document.createElement('input'); location.value = alias.subLocation; location.maxLength = 120; location.placeholder = '例如：2号柜'; location.setAttribute('aria-label', `别名 ${index + 1} 子位置`);
      const actions = document.createElement('span'); actions.className = 'alias-actions';
      const remove = button('删除', () => {
        if (!confirm('移除这个别名？已确认的历史关联不会被拆开。')) return;
        aliases.splice(index, 1); state.dirty = true; renderAliases(); renderDirectory();
      }, 'textbtn danger-text');
      actions.append(remove); row.append(source, name, location, actions); list.append(row);
      const update = () => { alias.source = source.value; alias.name = name.value; alias.subLocation = location.value; state.dirty = true; renderDirectory(); };
      source.addEventListener('change', update); name.addEventListener('input', update); location.addEventListener('input', update);
    });
  }

  function renderDetail() {
    const draft = selectedOrDraft();
    const hasStation = Boolean(draft);
    setHidden('station-detail-body', !hasStation || state.queueOpen);
    setHidden('station-empty', hasStation || state.queueOpen);
    setHidden('station-queue-view', !state.queueOpen);
    if (!hasStation || state.queueOpen) return;
    setText('station-detail-name', draft.name || '新增站点'); setText('station-detail-subtitle', draft.region || '填写地区，避免同名门店混淆');
    get('station-id').value = draft.id || ''; get('station-name').value = draft.name; get('station-region').value = draft.region;
    const toggle = get('station-enabled'); toggle.setAttribute('aria-checked', String(draft.enabled)); toggle.classList.toggle('off', !draft.enabled);
    setText('station-enabled-label', draft.enabled ? '启用站点' : '已暂停站点'); renderAliases();
  }

  function selectStation(id) {
    if (state.dirty && !confirm('当前站点有未保存更改，切换后将丢失。继续？')) return;
    state.selectedId = id; state.draft = cloneStation(state.stations.find(station => station.id === id)); state.newStation = false; state.dirty = false; state.queueOpen = false; renderDirectory(); renderDetail();
  }

  function newStation() {
    if (state.dirty && !confirm('当前站点有未保存更改，新增后将丢失。继续？')) return;
    state.selectedId = ''; state.draft = { id: '', name: '', region: '', enabled: true, aliases: [] }; state.newStation = true; state.dirty = false; state.queueOpen = false; renderDirectory(); renderDetail(); get('station-name').focus();
  }

  function showQueue() { state.queueOpen = true; setText('station-detail-name', 'AI 待核对'); setText('station-detail-subtitle', '自动分析，确认后加入站点别名'); renderDirectory(); renderDetail(); renderCandidates(); }
  function showStation() { state.queueOpen = false; if (!state.draft && state.stations[0]) selectStation(state.stations[0].id); else { renderDirectory(); renderDetail(); } }

  function renderCandidate(candidate) {
    const article = document.createElement('article'); article.className = `candidate ${candidate.suggestedStationId ? '' : 'muted'}`;
    const head = document.createElement('div'); head.className = 'candidate-head';
    const title = document.createElement('div'); title.className = 'candidate-title';
    const heading = document.createElement('h3'); heading.textContent = candidate.title;
    const sourceLine = document.createElement('p'); sourceLine.textContent = `原文：${candidate.rawText || candidate.sms || '未提供'}${candidate.region ? ` · 地区：${candidate.region}` : ''}`;
    title.append(heading, sourceLine);
    const status = document.createElement('span'); status.className = `candidate-status ${candidate.suggestedStationId ? '' : 'neutral'}`; status.textContent = candidate.status === 'pending' ? '待分析' : candidate.status === 'unknown' ? '无法判断' : candidate.suggestedStationId ? '建议归入已有站点' : '需选择站点'; head.append(title, status); article.append(head);
    const path = document.createElement('div'); path.className = 'candidate-path';
    const logistics = document.createElement('span'); logistics.textContent = `物流已知：${candidate.logistics || '未提供'}`;
    const targetName = candidate.suggestedName || state.stations.find(station => station.id === candidate.suggestedStationId)?.name;
    const target = document.createElement('span'); target.textContent = targetName ? `建议站点：${targetName}` : '请选择标准站点';
    path.append(logistics, document.createTextNode(' → '), target);
    if (candidate.subLocation) { const sub = document.createElement('span'); sub.textContent = `子位置：${candidate.subLocation}`; path.append(document.createTextNode(' · '), sub); }
    article.append(path);
    const evidence = document.createElement('p'); evidence.className = 'evidence'; evidence.textContent = `证据：${candidate.evidence} · 出现 ${candidate.occurrenceCount} 次`; article.append(evidence);
    if (candidate.raw.error) { const error = document.createElement('p'); error.className = 'warning-note'; error.textContent = candidate.raw.error + (candidate.raw.retryAt ? ' · 下次重试：' + new Date(candidate.raw.retryAt).toLocaleString('zh-CN') : ''); article.append(error); }
    const analysis = createAnalysisDetails(candidate.raw.analysis, { running: state.aiRunning }); analysis.open = state.analysisOpen.has(candidate.id);
    analysis.addEventListener('toggle', () => { if (analysis.open) state.analysisOpen.add(candidate.id); else state.analysisOpen.delete(candidate.id); }); article.append(analysis);
    const actions = document.createElement('div'); actions.className = 'candidate-actions';
    actions.append(button('忽略', () => ignoreCandidate(candidate), 'textbtn'), button(candidate.suggestedStationId ? '核对并加入' : '核对并选择', () => openReview(candidate), 'primary')); article.append(actions);
    if (!candidate.suggestedStationId) { const warning = document.createElement('p'); warning.className = 'warning-note'; warning.textContent = '无法唯一确定时必须选择站点；住宅地址和物流中转站不会加入规则。'; article.append(warning); }
    return article;
  }

  function renderCandidates() {
    const list = get('candidate-list'); list.replaceChildren();
    if (!state.candidates.length) { const empty = document.createElement('p'); empty.className = 'candidate-empty'; empty.textContent = '当前没有待核对候选'; list.append(empty); return; }
    state.candidates.forEach(candidate => list.append(renderCandidate(candidate)));
  }

  function fillReviewStations(selectedId = '') {
    const select = get('review-station'); select.replaceChildren();
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = '请选择标准站点'; select.append(blank);
    for (const station of state.stations) { const option = document.createElement('option'); option.value = station.id; option.textContent = `${station.name} · ${station.region || '未填写地区'}`; select.append(option); }
    const create = document.createElement('option'); create.value = '__new__'; create.textContent = '新建站点（需填写名称和地区）'; select.append(create); select.value = selectedId || '';
    setHidden('review-new-fields', select.value !== '__new__');
  }

  function openReview(candidate) {
    state.reviewCandidate = candidate; const evidence = get('review-evidence'); evidence.replaceChildren();
    for (const [label, value] of [['原文片段', candidate.rawText || candidate.sms], ['物流已知', candidate.logistics], ['地区', candidate.region], ['判断依据', candidate.evidence]]) {
      const row = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = `${label}：`; row.append(strong, document.createTextNode(value || '未提供')); evidence.append(row);
    }
    fillReviewStations(candidate.suggestedStationId); get('review-alias').value = candidate.alias || candidate.raw.stationName || candidate.rawText || ''; get('review-new-name').value = candidate.suggestedName || ''; get('review-new-region').value = candidate.region || ''; get('review-sub-location').value = candidate.subLocation || '';
    get('station-review-dialog').showModal();
  }

  async function ignoreCandidate(candidate) {
    await api(`/v1/admin/station-candidates/${encodeURIComponent(candidate.id)}/ignore`, { method: 'POST', body: '{}' });
    await loadCandidates(); notice('候选已忽略。');
  }

  async function loadStations() {
    const data = await api('/v1/admin/stations'); state.stations = (data.stations || []).map(stationOf); state.loaded = true;
    if (!state.selectedId || !state.stations.some(station => station.id === state.selectedId)) state.selectedId = state.stations[0]?.id || '';
    if (!state.draft || (!state.newStation && state.draft.id !== state.selectedId)) state.draft = state.selectedId ? cloneStation(currentStation()) : null;
    renderDirectory(); renderDetail();
  }

  async function loadCandidates() {
    const data = await api('/v1/admin/station-candidates'); state.candidates = (data.candidates || []).map(candidateOf).filter(candidate => !['ignored', 'approved'].includes(candidate.status)); if (data.running !== undefined) state.aiRunning = Boolean(data.running); renderDirectory(); renderCandidates(); scheduleAiPoll();
  }

  function applyConfig(config) {
    state.aiConfig = config || {};
    get('ai-enabled').setAttribute('aria-checked', String(Boolean(config?.enabled))); get('ai-enabled').classList.toggle('off', !config?.enabled);
    get('ai-channel-name').value = first(config?.channelName); get('ai-base-url').value = first(config?.baseUrl); get('ai-model').value = first(config?.model); get('ai-interval').value = String(config?.intervalMinutes === 1440 ? 1440 : 60); get('ai-limit').value = String(config?.dailyLimit || 20); get('ai-api-key').value = '';
    const configured = Boolean(config?.hasApiKey && config?.baseUrl && config?.model && config?.channelName);
    setText('ai-key-state', config?.hasApiKey ? '已配置；输入框留空不会覆盖已保存密钥' : '未配置；输入框留空不会覆盖已保存密钥'); setText('ai-config-state', configured ? '已配置' : '待配置');
    setText('ai-usage', Number.isSafeInteger(config?.usageToday) && config.usageToday >= 0 ? `今日已用 ${config.usageToday} 次 / ${config.dailyLimit || 20} 次` : '当日用量尚未读取');
    setText('ai-frequency-label', !configured ? '尚未配置' : config?.enabled ? config?.intervalMinutes === 1440 ? '每天' : '每小时' : '定期已关闭 · 可手动分析'); state.aiDirty = false;
  }

  async function loadAiConfig() {
    const data = await api('/v1/admin/station-ai'); if (data.config) applyConfig(data.config); if (data.running !== undefined) state.aiRunning = Boolean(data.running); scheduleAiPoll();
  }

  function scheduleAiPoll() {
    clearTimeout(state.aiPollTimer); state.aiPollTimer = null;
    if (!state.open || document.hidden || !state.aiRunning) return;
    if (!state.aiPollStarted) state.aiPollStarted = Date.now();
    if (Date.now() - state.aiPollStarted > 60000) { state.aiRunning = false; notice('分析任务仍在后台处理，可稍后重新打开站点管理查看结果。'); return; }
    state.aiPollTimer = setTimeout(async () => { state.aiPollTimer = null; try { await Promise.all([loadCandidates(), loadAiConfig()]); } catch (error) { notice(error.message || '分析状态暂时无法更新。', true); } }, 3000);
  }

  async function loadWorkspace() {
    if (!state.open) return;
    try { await Promise.all([loadStations(), loadCandidates(), loadAiConfig()]); } catch (error) { notice(error.message || '站点管理暂时无法读取。', true); }
  }

  async function saveStation(event) {
    event.preventDefault(); const draft = selectedOrDraft(); if (!draft) return;
    draft.name = get('station-name').value.trim(); draft.region = get('station-region').value.trim();
    if (!draft.name || !draft.region) throw new Error('请填写标准名称和所在地区。');
    const aliases = draft.aliases.filter(alias => alias.name.trim()).map(alias => ({ id: alias.id || undefined, name: alias.name.trim(), source: ({ 物流: 'platform', 短信: 'sms', 手动: 'manual', AI辅助: 'ai' })[sourceLabel(alias.source)] || sourceLabel(alias.source) || 'manual', subLocation: alias.subLocation.trim() }));
    const body = { name: draft.name, region: draft.region, enabled: draft.enabled, aliases };
    const data = await api(draft.id ? `/v1/admin/stations/${encodeURIComponent(draft.id)}` : '/v1/admin/stations', { method: draft.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    const saved = stationOf(data.station); state.stations = state.stations.filter(station => station.id !== saved.id); state.stations.push(saved); state.selectedId = saved.id; state.draft = cloneStation(saved); state.newStation = false; state.dirty = false; renderDirectory(); renderDetail(); notice('站点规则已保存，授权设备将在同步时获取新版本。');
  }

  function verifyStation() {
    const logistics = get('verify-logistics').value.trim(); const sms = get('verify-sms').value.trim(); const result = get('verify-result');
    if (!logistics || !sms) { result.className = 'verify-result warning'; result.textContent = '请分别填写物流站名和短信站名后再验证。'; return; }
    const { same, conflict } = compareStationNames(logistics, sms, state.stations);
    result.className = `verify-result ${same ? 'ok' : 'warning'}`; result.textContent = same ? '已保存的规则识别为同站点；仍需检查真实到站时间、双方唯一性和其他冲突。' : conflict ? '站点、柜号、卡位、楼栋或门向存在差异，不能自动关联。' : '名称尚未确认为同站点，请先保存并核对别名关系；本次验证使用已保存规则。';
  }

  async function saveAi(event) {
    event.preventDefault(); const body = { channelName: get('ai-channel-name').value.trim(), baseUrl: get('ai-base-url').value.trim(), model: get('ai-model').value.trim(), enabled: get('ai-enabled').getAttribute('aria-checked') === 'true', intervalMinutes: Number(get('ai-interval').value), dailyLimit: Number(get('ai-limit').value) };
    if (!body.baseUrl || !body.model) throw new Error('请填写 AI Base URL 和模型。');
    if (!Number.isSafeInteger(body.dailyLimit) || body.dailyLimit < 1) throw new Error('每日调用上限须为正安全整数。');
    const key = get('ai-api-key').value.trim(); if (key) body.apiKey = key;
    const data = await api('/v1/admin/station-ai', { method: 'PATCH', body: JSON.stringify(body) }); applyConfig(data.config || data); notice('AI 设置已保存。');
  }

  async function clearApiKey() {
    if (!confirm('清除后台已保存的 AI API Key，并暂停定期分析？')) return;
    const data = await api('/v1/admin/station-ai', { method: 'PATCH', body: JSON.stringify({ clearApiKey: true, enabled: false }) }); applyConfig(data.config || data); notice('AI API Key 已清除，定期分析已暂停。');
  }

  async function testAi() {
    if (state.aiDirty) throw new Error('请先保存 AI 设置，再进行连接测试。');
    const data = await api('/v1/admin/station-ai/test', { method: 'POST', body: '{}' }); await loadAiConfig(); if (!data.ok) throw new Error(data.message || '连接测试失败。'); notice(data.message || '连接测试成功。');
  }

  async function runAi() {
    if (state.aiDirty) throw new Error('请先保存 AI 设置，再提交分析。');
    const data = await api('/v1/admin/station-ai/run', { method: 'POST', body: '{}' }); state.aiRunning = Boolean(data.running ?? data.accepted); state.aiPollStarted = Date.now(); scheduleAiPoll(); notice(data.message || (data.accepted ? '分析任务已提交，正在后台处理。' : '分析任务未接受。'), !data.accepted);
  }

  async function approveCandidate(event) {
    event.preventDefault(); const candidate = state.reviewCandidate; if (!candidate) return;
    const stationId = get('review-station').value; if (!stationId) throw new Error('请先选择标准站点。');
    const body = { stationId: stationId === '__new__' ? '' : stationId, alias: get('review-alias').value.trim(), subLocation: get('review-sub-location').value.trim() };
    if (!body.alias) throw new Error('请填写原文中真实的站点别名。');
    if (stationId === '__new__') { body.name = get('review-new-name').value.trim(); body.region = get('review-new-region').value.trim(); if (!body.name || !body.region) throw new Error('新建站点必须填写标准名称和地区。'); }
    await api(`/v1/admin/station-candidates/${encodeURIComponent(candidate.id)}/approve`, { method: 'POST', body: JSON.stringify(body) }); get('station-review-dialog').close(); state.reviewCandidate = null; await Promise.all([loadStations(), loadCandidates()]); notice('候选已人工确认并加入站点规则。');
  }

  function switchSettings(view) {
    const station = view === 'station'; state.open = station; setHidden('settings-basic-view', station); setHidden('station-settings-view', !station); get('basic-settings-tab').classList.toggle('active', !station); get('station-settings-tab').classList.toggle('active', station); setText('settings-page-title', station ? '站点管理' : '服务设置'); clearTimeout(state.aiPollTimer); state.aiPollTimer = null;
    if (station) loadWorkspace();
  }

  get('basic-settings-tab').addEventListener('click', () => switchSettings('basic'));
  get('station-settings-tab').addEventListener('click', () => switchSettings('station'));
  get('station-add').addEventListener('click', newStation);
  get('station-search-input').addEventListener('input', event => { state.query = event.target.value.trim(); renderDirectory(); });
  get('station-queue-entry').addEventListener('click', showQueue);
  get('ai-open-settings').addEventListener('click', () => { showQueue(); get('ai-settings-panel').open = true; get('ai-settings-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  const guarded = (id, handler) => get(id).addEventListener('click', async () => { const element = get(id); if (element.disabled) return; element.disabled = true; try { await handler(); } catch (error) { notice(error.message || '操作未完成，请重试。', true); } finally { element.disabled = false; } });
  guarded('ai-run', runAi);
  guarded('ai-test', testAi);
  guarded('ai-clear-key', clearApiKey);
  get('station-form').addEventListener('submit', event => saveStation(event).catch(error => notice(error.message || '站点未保存。', true)));
  get('station-name').addEventListener('input', () => { state.dirty = true; });
  get('station-region').addEventListener('input', () => { state.dirty = true; });
  get('alias-add').addEventListener('click', () => { const draft = selectedOrDraft(); if (!draft) return; draft.aliases.push({ name: '', source: '手动', subLocation: '' }); state.dirty = true; renderAliases(); renderDirectory(); get('alias-list').querySelector('input')?.focus(); });
  get('station-enabled').addEventListener('click', () => { const draft = selectedOrDraft(); if (!draft) return; draft.enabled = !draft.enabled; state.dirty = true; renderDetail(); });
  get('verify-station').addEventListener('click', verifyStation);
  get('station-review-close').addEventListener('click', () => get('station-review-dialog').close()); get('review-cancel').addEventListener('click', () => get('station-review-dialog').close());
  get('review-station').addEventListener('change', event => setHidden('review-new-fields', event.target.value !== '__new__'));
  get('station-review-form').addEventListener('submit', event => approveCandidate(event).catch(error => notice(error.message || '候选未加入。', true)));
  get('ai-settings-form').addEventListener('submit', event => saveAi(event).catch(error => notice(error.message || 'AI 设置未保存。', true)));
  get('ai-settings-form').addEventListener('input', () => { state.aiDirty = true; });
  get('ai-interval').addEventListener('change', () => { state.aiDirty = true; });
  get('ai-enabled').addEventListener('click', () => { const next = get('ai-enabled').getAttribute('aria-checked') !== 'true'; get('ai-enabled').setAttribute('aria-checked', String(next)); get('ai-enabled').classList.toggle('off', !next); state.aiDirty = true; });
  get('logout').addEventListener('click', () => { state.open = false; clearTimeout(state.aiPollTimer); state.aiPollTimer = null; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(state.aiPollTimer); state.aiPollTimer = null; } else if (state.open) loadWorkspace(); });
  renderDirectory(); renderDetail();
}
