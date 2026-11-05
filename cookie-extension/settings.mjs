import { baseOrigin, problem } from './core.mjs';

const KEY = 'syncSettings', DEFAULT_NAME = '我的 Chrome';
function origin(value) { try { return baseOrigin(value); } catch { return ''; } }
function browserName(value) { return typeof value === 'string' ? value.trim().slice(0, 80) : ''; }

export function createSettings(initialized) {
  let writes = Promise.resolve();
  function serialized(fn) {
    const task = writes.then(fn); writes = task.catch(() => {}); return task;
  }
  async function read() {
    await initialized;
    const data = await chrome.storage.local.get([KEY, 'connections', 'familyConnections', 'familyRequest']);
    const saved = data[KEY] || {}, pending = data.familyRequest || {};
    const families = Array.isArray(data.familyConnections) ? data.familyConnections : [];
    const legacy = Array.isArray(data.connections) ? data.connections : [];
    const candidates = [saved.baseUrl, ...(Array.isArray(saved.baseUrls) ? saved.baseUrls : []), pending.baseUrl,
      ...families.map(item => item.baseUrl), ...legacy.map(item => item.baseUrl)];
    const baseUrls = [...new Set(candidates.map(origin).filter(Boolean))];
    return { baseUrl: origin(saved.baseUrl) || origin(pending.baseUrl) || baseUrls[0] || '',
      name: browserName(saved.name) || browserName(pending.name) || browserName(families[0]?.connection?.name)
        || browserName(legacy[0]?.connection?.name) || DEFAULT_NAME, baseUrls };
  }
  async function get() {
    return serialized(async () => { const settings = await read(); await chrome.storage.local.set({ [KEY]: settings }); return settings; });
  }
  async function save(message) {
    const requestedBaseUrl = message.baseUrl === undefined ? undefined : baseOrigin(message.baseUrl);
    if (message.name !== undefined && typeof message.name !== 'string') throw problem('BAD_MESSAGE');
    return serialized(async () => {
      const previous = await read(), baseUrl = requestedBaseUrl ?? previous.baseUrl;
      const settings = { baseUrl, name: browserName(message.name) || previous.name,
        baseUrls: [...new Set([baseUrl, ...previous.baseUrls].filter(Boolean))] };
      await chrome.storage.local.set({ [KEY]: settings }); return settings;
    });
  }
  return { get, save };
}
