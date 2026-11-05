import { fail, hash } from './security.mjs';
import { requestAiJson, contentJson, safeFailure, aiError, STATION_SYSTEM } from './station-ai.mjs';
import { TEMPLATE_SYSTEM, validateTemplateInput, validateTemplateCandidate, testAiCapabilities } from './ai-templates.mjs';

const TIMEOUT = 11000, CACHE_TTL = 5 * 60000, CACHE_LIMIT = 100;
const readinessMessages = {
  AI_READY: '使用后台默认AI服务', AI_NOT_CONFIGURED: '后台尚未配置AI服务，请在后台设置中添加',
  AI_DEFAULT_MISSING: '后台未选定有效的默认AI服务，请在后台设置中选择',
  AI_CHANNEL_DISABLED: '后台默认AI服务已暂停，请在后台设置中启用',
  AI_CHANNEL_INCOMPLETE: '后台默认AI服务配置不完整，请在后台补全渠道名称、地址、模型和密钥',
};

export class AiAssistance {
  constructor({ stations, now = Date.now, request = requestAiJson }) {
    this.stations = stations; this.now = now; this.transport = request;
    this.controllers = new Map(); this.cache = new Map(); this.pending = new Map(); this.closed = false;
    this.unsubscribe = stations.onAiConfigChange(({ channelId, credentialsChanged }) => {
      const revision = this.service().revision;
      for (const [controller, context] of this.controllers) {
        if (context.defaultRevision && context.defaultRevision !== revision || credentialsChanged && context.id === channelId) controller.abort(aiError('AI_CONFIG_CHANGED'));
      }
      for (const [key, entry] of this.cache) if (entry.defaultRevision !== revision || credentialsChanged && entry.channelId === channelId) this.cache.delete(key);
      for (const [key, entry] of this.pending) if (entry.defaultRevision !== revision) this.pending.delete(key);
    });
  }
  service() {
    const config = this.stations.aiConfig(), channel = this.stations.aiChannel(config.channelId);
    const code = !config.channelId ? this.stations.aiChannels().length ? 'AI_DEFAULT_MISSING' : 'AI_NOT_CONFIGURED'
      : !channel ? 'AI_DEFAULT_MISSING' : !channel.enabled ? 'AI_CHANNEL_DISABLED'
        : !channel.hasApiKey || !channel.name || !channel.baseUrl || !channel.model ? 'AI_CHANNEL_INCOMPLETE' : 'AI_READY';
    return { mode: 'backend_default', available: code === 'AI_READY', code, message: readinessMessages[code],
      channelId: config.channelId, channelName: channel?.name || '', model: channel?.model || '',
      revision: hash(JSON.stringify([config.channelId, channel?.revision || 0, config.defaultSelectionRevision])) };
  }
  channels() {
    const service = this.service();
    const channels = service.available ? [{ id: service.channelId, name: service.channelName, model: service.model, capabilities: ['station_alias', 'sms_template', 'logistics_rule'] }] : [];
    return { channels, defaultChannelId: service.available ? service.channelId : '', service };
  }
  defaultRoute(requestedId) {
    if (this.closed) fail(503, 'SERVICE_STOPPING', '服务正在停止');
    const service = this.service();
    if (!service.available) fail(409, service.code, service.message);
    if (requestedId && requestedId !== service.channelId) fail(409, 'AI_CONFIG_CHANGED', '后台默认AI服务已更改，请刷新后重试');
    return service;
  }
  assertDefault(route) {
    if (this.closed) fail(503, 'SERVICE_STOPPING', '服务正在停止');
    const current = this.service();
    if (!current.available || current.channelId !== route.channelId || current.revision !== route.revision) fail(409, 'AI_CONFIG_CHANGED', '后台默认AI服务已更改，本次建议已停止，请刷新后重试');
  }
  channel(id, allowDisabled = false) {
    if (this.closed) fail(503, 'SERVICE_STOPPING', '服务正在停止');
    const channel = this.stations.aiChannelCredentials(id);
    if (!channel || !allowDisabled && !channel.enabled || !channel.name || !channel.baseUrl || !channel.model || !channel.apiKey) fail(409, 'AI_CHANNEL_UNAVAILABLE', '所选AI渠道已暂停或未配置，请重新选择');
    return channel;
  }
  async call(id, messages, { allowDisabled = false, signal, defaultRoute } = {}) {
    if (signal?.aborted) throw signal.reason || aiError('AI_CONFIG_CHANGED');
    if (defaultRoute) {
      this.assertDefault(defaultRoute);
      if (id !== defaultRoute.channelId) throw aiError('AI_CONFIG_CHANGED');
    }
    const channel = this.channel(id, allowDisabled);
    if (!this.stations.reserveAiCall()) throw aiError('AI_DAILY_LIMIT');
    const controller = new AbortController(); this.controllers.set(controller, { id, revision: channel.revision, defaultRevision: defaultRoute?.revision });
    const parentAborted = () => controller.abort(signal.reason || aiError('AI_CONFIG_CHANGED'));
    signal?.addEventListener('abort', parentAborted, { once: true });
    let timer, onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason || aiError('AI_CONFIG_CHANGED')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(aiError('AI_TIMEOUT')); reject(aiError('AI_TIMEOUT')); }, TIMEOUT); });
    try {
      const response = await Promise.race([this.transport({ url: channel.baseUrl, headers: { Authorization: `Bearer ${channel.apiKey}` }, signal: controller.signal,
        body: JSON.stringify({ model: channel.model, stream: false, temperature: 0, max_tokens: 700, ...(channel.jsonMode ? { response_format: { type: 'json_object' } } : {}), messages }) }), aborted, timeout]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.channel(id, allowDisabled).revision !== channel.revision) throw aiError('AI_CONFIG_CHANGED');
      if (defaultRoute) this.assertDefault(defaultRoute);
      return response;
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); signal?.removeEventListener('abort', parentAborted); this.controllers.delete(controller); }
  }
  async template(body, identity, authorize) {
    const input = validateTemplateInput(body);
    authorize();
    const route = this.defaultRoute(input.channelId);
    const key = hash(JSON.stringify([identity, route.revision, input.sample, input.expectedCode]));
    for (const [entryKey, entry] of this.cache) if (entry.until <= this.now()) this.cache.delete(entryKey);
    const cached = this.cache.get(key);
    if (cached) { authorize(); this.assertDefault(route); return structuredClone(cached.result); }
    let promise = this.pending.get(key)?.promise;
    if (!promise) {
      if (this.pending.size >= 4 || [...this.pending.values()].some(entry => entry.identity === identity)) fail(429, 'AI_BUSY', 'AI正在准备建议，请稍后重试');
      promise = (async () => {
        const response = await this.call(route.channelId, [{ role: 'system', content: TEMPLATE_SYSTEM }, { role: 'user', content: JSON.stringify({ sample: input.sample, expectedCode: input.expectedCode }) }], { defaultRoute: route });
        authorize();
        this.assertDefault(route);
        const result = validateTemplateCandidate(contentJson(response), input.sample, input.expectedCode);
        if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { channelId: route.channelId, defaultRevision: route.revision, until: this.now() + CACHE_TTL, result });
        return result;
      })();
      this.pending.set(key, { promise, identity, defaultRevision: route.revision });
      promise.finally(() => this.pending.delete(key)).catch(() => {});
    }
    try { const result = await promise; authorize(); this.assertDefault(route); return structuredClone(result); }
    catch (error) {
      authorize();
      if (error.status && ['DEVICE_UNAUTHORIZED', 'SCOPE_FORBIDDEN'].includes(error.code)) throw error;
      const safe = safeFailure(error);
      fail(safe.code === 'AI_DAILY_LIMIT' ? 429 : safe.code === 'SERVICE_STOPPING' ? 503 : ['AI_CONFIG_CHANGED', 'AI_CHANNEL_UNAVAILABLE', 'AI_DEFAULT_MISSING', 'AI_CHANNEL_DISABLED', 'AI_CHANNEL_INCOMPLETE'].includes(safe.code) ? 409 : 502, safe.code, safe.message);
    }
  }
  async test(id) {
    const revision = this.channel(id, true).revision;
    return testAiCapabilities(messages => {
      if (this.channel(id, true).revision !== revision) throw aiError('AI_CONFIG_CHANGED');
      return this.call(id, messages, { allowDisabled: true });
    }, contentJson, safeFailure, STATION_SYSTEM);
  }
  close() { this.closed = true; this.unsubscribe(); for (const controller of this.controllers.keys()) controller.abort(aiError('SERVICE_STOPPING')); this.cache.clear(); }
}
