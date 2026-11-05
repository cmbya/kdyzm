import { fail, hash } from './security.mjs';
import { requestAiJson, contentJson, safeFailure, aiError, STATION_SYSTEM } from './station-ai.mjs';
import { TEMPLATE_SYSTEM, validateTemplateInput, validateTemplateCandidate, testAiCapabilities } from './ai-templates.mjs';

const TIMEOUT = 11000, CACHE_TTL = 5 * 60000, CACHE_LIMIT = 100;

export class AiAssistance {
  constructor({ stations, now = Date.now, request = requestAiJson }) {
    this.stations = stations; this.now = now; this.transport = request;
    this.controllers = new Map(); this.cache = new Map(); this.pending = new Map(); this.closed = false;
    this.unsubscribe = stations.onAiConfigChange(({ channelId, credentialsChanged }) => {
      if (!credentialsChanged) return;
      for (const [controller, context] of this.controllers) if (context.id === channelId) controller.abort(aiError('AI_CONFIG_CHANGED'));
      for (const [key, entry] of this.cache) if (entry.channelId === channelId) this.cache.delete(key);
    });
  }
  channels() {
    const channels = this.stations.aiChannels().filter(channel => channel.enabled && channel.hasApiKey && channel.name && channel.baseUrl && channel.model)
      .map(({ id, name, model }) => ({ id, name, model, capabilities: ['station_alias', 'sms_template'] }));
    const selected = this.stations.aiConfig().channelId;
    return { channels, defaultChannelId: channels.some(channel => channel.id === selected) ? selected : '' };
  }
  channel(id, allowDisabled = false) {
    if (this.closed) fail(503, 'SERVICE_STOPPING', '服务正在停止');
    const channel = this.stations.aiChannelCredentials(id);
    if (!channel || !allowDisabled && !channel.enabled || !channel.name || !channel.baseUrl || !channel.model || !channel.apiKey) fail(409, 'AI_CHANNEL_UNAVAILABLE', '所选AI渠道已暂停或未配置，请重新选择');
    return channel;
  }
  async call(id, messages, { allowDisabled = false } = {}) {
    const channel = this.channel(id, allowDisabled);
    if (!this.stations.reserveAiCall()) throw aiError('AI_DAILY_LIMIT');
    const controller = new AbortController(); this.controllers.set(controller, { id, revision: channel.revision });
    let timer, onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason || aiError('AI_CONFIG_CHANGED')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(aiError('AI_TIMEOUT')); reject(aiError('AI_TIMEOUT')); }, TIMEOUT); });
    try {
      const response = await Promise.race([this.transport({ url: channel.baseUrl, headers: { Authorization: `Bearer ${channel.apiKey}` }, signal: controller.signal,
        body: JSON.stringify({ model: channel.model, stream: false, temperature: 0, max_tokens: 700, ...(channel.jsonMode ? { response_format: { type: 'json_object' } } : {}), messages }) }), aborted, timeout]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.channel(id, allowDisabled).revision !== channel.revision) throw aiError('AI_CONFIG_CHANGED');
      return response;
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); this.controllers.delete(controller); }
  }
  async template(body, identity, authorize) {
    const input = validateTemplateInput(body), channel = this.channel(input.channelId);
    authorize();
    const key = hash(JSON.stringify([identity, input.channelId, channel.revision, input.sample, input.expectedCode]));
    for (const [entryKey, entry] of this.cache) if (entry.until <= this.now()) this.cache.delete(entryKey);
    const cached = this.cache.get(key);
    if (cached) { authorize(); return structuredClone(cached.result); }
    let promise = this.pending.get(key)?.promise;
    if (!promise) {
      if (this.pending.size >= 4 || [...this.pending.values()].some(entry => entry.identity === identity)) fail(429, 'AI_BUSY', 'AI正在准备建议，请稍后重试');
      promise = (async () => {
        const response = await this.call(input.channelId, [{ role: 'system', content: TEMPLATE_SYSTEM }, { role: 'user', content: JSON.stringify({ sample: input.sample, expectedCode: input.expectedCode }) }]);
        authorize();
        const result = validateTemplateCandidate(contentJson(response), input.sample, input.expectedCode);
        if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { channelId: input.channelId, until: this.now() + CACHE_TTL, result });
        return result;
      })();
      this.pending.set(key, { promise, identity });
      promise.finally(() => this.pending.delete(key)).catch(() => {});
    }
    try { const result = await promise; authorize(); return structuredClone(result); }
    catch (error) {
      authorize();
      if (error.status && ['DEVICE_UNAUTHORIZED', 'SCOPE_FORBIDDEN'].includes(error.code)) throw error;
      const safe = safeFailure(error);
      fail(safe.code === 'AI_DAILY_LIMIT' ? 429 : safe.code === 'AI_CONFIG_CHANGED' || safe.code === 'AI_CHANNEL_UNAVAILABLE' ? 409 : 502, safe.code, safe.message);
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
