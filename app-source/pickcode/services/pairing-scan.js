const CODE = /^[A-Za-z0-9-]{4,128}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
let serial = 0;

export function normalizePairingBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value)) throw new Error('服务地址格式不正确');
  let url;
  try { url = new URL(value.trim()); } catch (_) { throw new Error('请填写完整的 HTTPS 服务地址'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) || !url.hostname
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || url.port === '0') {
    throw new Error('服务地址须使用 HTTPS，不能包含账号密码、路径或查询参数；HTTP 仅限本机联调');
  }
  return url.origin;
}

function binding(baseUrl, code, fallback) {
  if (typeof code !== 'string' || !CODE.test(code.trim())) throw new Error('未识别到有效授权码，请核对或手动输入');
  const address = baseUrl || fallback;
  return { baseUrl: address ? normalizePairingBaseUrl(address) : '', code: code.trim(), needsBaseUrl: !address };
}

export function parsePairingInput(value, fallbackBaseUrl = '') {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('授权信息为空或过长，请重新识别');
  const text = value.trim();
  if (text.startsWith('{')) {
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('二维码内容不完整，请重新扫描或手动输入'); }
    if (!data || Array.isArray(data) || (data.schemaVersion !== undefined && data.schemaVersion !== 1)) throw new Error('暂不支持这种授权二维码');
    return binding(data.baseUrl, data.code, fallbackBaseUrl);
  }
  if (CODE.test(text)) return binding('', text, fallbackBaseUrl);
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\\\r\n]/.test(text)) throw new Error('授权链接格式不安全');
    if (url.searchParams.has('code')) return binding(url.searchParams.get('baseUrl'), url.searchParams.get('code'), fallbackBaseUrl);
  } catch (error) { if (error.message === '授权链接格式不安全') throw error; }
  const addresses = [...new Set((text.match(/https?:\/\/[^\s<>"{}，。；、]+/gi) || []).map(v => v.replace(/[,;.)]+$/, '')))];
  const codes = [...text.matchAll(/(?:授权码|绑定码|一次性码|code)["'\s]*[:：]\s*["']?([A-Za-z0-9-]{4,128})(?![A-Za-z0-9-])/gi)].map(v => v[1]);
  if (addresses.length > 1 || new Set(codes).size > 1) throw new Error('发现多组授权信息，请裁剪图片或手动选择一组');
  if (codes.length) return binding(addresses[0], codes[0], fallbackBaseUrl);
  throw new Error('未识别到服务地址和授权码，可修改识别文字或手动输入');
}

export function parsePairingRecognition(result, fallbackBaseUrl = '') {
  if (!result || !Array.isArray(result.texts) || result.texts.length > 8) throw new Error('未取得有效识别结果，请重试');
  const found = new Map();
  let lastError;
  for (const text of result.texts) {
    try { const value = parsePairingInput(text, fallbackBaseUrl); found.set(value.baseUrl + '\n' + value.code, value); }
    catch (error) { lastError = error; }
  }
  if (found.size > 1) throw new Error('发现多组授权信息，请每次只扫描一个二维码');
  if (!found.size) throw lastError || new Error('没有识别到授权信息，请重试');
  return [...found.values()][0];
}

function bridge() { return typeof window !== 'undefined' && window.PickCodeNative; }

function nativeRequest(action, payload, signal) {
  return new Promise((resolve, reject) => {
    const native = bridge(), id = 'pairing-' + (++serial) + '-' + Date.now();
    let timer;
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('pickcode-native', receive); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); if (action === 'scanPairing') { try { native.request('cancel-' + id, JSON.stringify({ action: 'cancelPairingScan' })); } catch (_) {} } reject(new Error('已取消识别')); };
    const receive = event => {
      if (event.detail?.id !== id) return;
      cleanup();
      if (event.detail.ok) resolve(event.detail.data); else reject(new Error(event.detail.error || '操作未完成，请重试'));
    };
    if (signal?.aborted) { reject(new Error('已取消识别')); return; }
    window.addEventListener('pickcode-native', receive); signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { cleanup(); if (action === 'scanPairing') { try { native.request('cancel-' + id, JSON.stringify({ action: 'cancelPairingScan' })); } catch (_) {} } reject(new Error('操作超时，请重试')); }, action === 'scanPairing' ? 300000 : 30000);
    try { native.request(id, JSON.stringify({ action, payload })); } catch (_) { cleanup(); reject(new Error('原生识别服务暂不可用，请重启应用重试')); }
  });
}

async function browserDetector() {
  if (typeof window === 'undefined' || !window.BarcodeDetector || !window.isSecureContext) throw new Error('此浏览器不支持二维码识别，请使用 Android 安装版，或粘贴、手动输入');
  if (!(await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) throw new Error('此浏览器不支持二维码识别，请使用 Android 安装版');
  return new window.BarcodeDetector({ formats: ['qr_code'] });
}

function browserImage(detector, signal) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.style.display = 'none';
    const finish = (error, result) => { signal?.removeEventListener('abort', abort); input.remove(); error ? reject(error) : resolve(result); };
    const abort = () => finish(new Error('已取消识别'));
    input.addEventListener('cancel', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file) return abort();
      if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) return finish(new Error('请选择小于 20 MB 的图片'));
      let bitmap;
      try {
        bitmap = await createImageBitmap(file);
        if (signal?.aborted) return abort();
        const values = await detector.detect(bitmap);
        if (!values.length) throw new Error('未识别到二维码；图片文字授权码请用 Android 安装版识别，或粘贴、手动输入');
        finish(null, { texts: values.slice(0, 8).map(v => v.rawValue), source: 'image-qr' });
      } catch (error) { finish(error); } finally { bitmap?.close(); }
    }, { once: true });
    document.body.appendChild(input); input.click();
  });
}

async function browserCamera(detector, signal) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('此浏览器无法调用相机，请使用 Android 安装版或相册识别');
  return new Promise((resolve, reject) => {
    const cover = document.createElement('div'), video = document.createElement('video'), close = document.createElement('button'), hint = document.createElement('p');
    cover.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#102036;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;color:white';
    video.style.cssText = 'width:100%;max-width:560px;max-height:70vh;object-fit:contain;border-radius:12px'; video.autoplay = true; video.playsInline = true; video.muted = true;
    close.type = 'button'; close.textContent = '取消扫码'; close.style.cssText = 'background:#1673ff;border:0;border-radius:8px;color:#fff;padding:12px 28px;font-size:16px;margin-top:20px';
    hint.textContent = '对准后台生成的授权二维码'; cover.append(hint, video, close); document.body.appendChild(cover); close.focus();
    let stream, frame, stopped = false, timer;
    const finish = (error, result) => { if (stopped) return; stopped = true; cancelAnimationFrame(frame); clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); cover.remove(); signal?.removeEventListener('abort', abort); document.removeEventListener('keydown', key); error ? reject(error) : resolve(result); };
    const abort = () => finish(new Error('已取消识别')), key = e => { if (e.key === 'Escape') abort(); };
    close.onclick = abort; signal?.addEventListener('abort', abort, { once: true }); document.addEventListener('keydown', key);
    const detect = async () => {
      if (stopped) return;
      try { if (video.readyState >= 2) { const values = await detector.detect(video); if (values.length) return finish(null, { texts: values.slice(0, 8).map(v => v.rawValue), source: 'camera' }); } }
      catch (_) { return finish(new Error('相机识别未完成，请重试或使用相册')); }
      if (!stopped) frame = requestAnimationFrame(detect);
    };
    timer = setTimeout(() => finish(new Error('扫码超时，可重试或使用手动输入')), 120000);
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(async value => {
      stream = value; if (stopped || signal?.aborted) { stream.getTracks().forEach(t => t.stop()); return abort(); }
      video.srcObject = stream; try { await video.play(); detect(); } catch (_) { finish(new Error('无法启动相机，请重试')); }
    }, error => finish(new Error(error.name === 'NotAllowedError' ? '相机权限被拒绝，可重新允许权限或使用相册、手动输入' : '无法打开相机，请使用相册或手动输入')));
  });
}

export async function scanPairingInformation(source, { signal } = {}) {
  if (!['camera', 'image'].includes(source)) throw new Error('不支持这种识别来源');
  if (signal?.aborted) throw new Error('已取消识别');
  if (bridge()) return nativeRequest('scanPairing', { source }, signal);
  const detector = await browserDetector();
  return source === 'camera' ? browserCamera(detector, signal) : browserImage(detector, signal);
}

const safeName = value => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export function normalizePairingPreview(data, requestedBaseUrl) {
  const baseUrl = normalizePairingBaseUrl(requestedBaseUrl), scope = data?.scope;
  if (!data?.service || !safeName(data.service.name) || !scope || !Array.isArray(scope.familyIds) || !Array.isArray(scope.accountIds)
      || !Array.isArray(scope.families) || !Array.isArray(scope.accounts) || scope.familyIds.length > 100 || scope.accountIds.length > 200
      || scope.families.length > 100 || scope.accounts.length > 200) throw new Error('后台未返回完整授权范围，请升级后台后重试');
  if (data.service.baseUrl && normalizePairingBaseUrl(data.service.baseUrl) !== baseUrl) throw new Error('后台返回的服务地址不一致，已停止绑定');
  const ids = [...scope.familyIds, ...scope.accountIds];
  if (!ids.every(id => typeof id === 'string' && ID.test(id)) || new Set(scope.familyIds).size !== scope.familyIds.length || new Set(scope.accountIds).size !== scope.accountIds.length) throw new Error('后台返回的授权范围格式无效');
  const families = scope.families.map(f => { if (!f || !ID.test(f.id || '') || !safeName(f.name) || !Number.isSafeInteger(f.accountCount) || f.accountCount < 0 || f.accountCount > 100000) throw new Error('后台家人信息无效'); return { id: f.id, name: f.name, accountCount: f.accountCount }; });
  const accounts = scope.accounts.map(a => { if (!a || !ID.test(a.id || '') || !safeName(a.label)) throw new Error('后台账号信息无效'); return { id: a.id, label: a.label, platform: typeof a.platform === 'string' ? a.platform.slice(0, 40) : '' }; });
  if (!scope.familyIds.every(id => families.some(f => f.id === id)) || !scope.accountIds.every(id => accounts.some(a => a.id === id)) || (!ids.length)) throw new Error('授权范围为空或不完整，请重新生成授权码');
  if (scope.familyIds.length && scope.includeFutureAccounts !== true) throw new Error('后台未确认家人持续授权，请重新生成授权码');
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : Date.parse(data.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('授权码已过期，请从后台重新生成');
  return { service: { name: data.service.name, baseUrl }, scope: { familyIds: [...scope.familyIds], accountIds: [...scope.accountIds], families, accounts, includeFutureAccounts: scope.includeFutureAccounts === true }, expiresAt };
}

export async function previewPairingBinding(address, inputCode) {
  const baseUrl = normalizePairingBaseUrl(address), code = typeof inputCode === 'string' ? inputCode.trim() : '';
  if (!CODE.test(code)) throw new Error('请填写后台生成的一次性授权码');
  if (bridge()) return normalizePairingPreview(await nativeRequest('previewPairing', { baseUrl, code }), baseUrl);
  if (!LOOPBACK.has(new URL(baseUrl).hostname)) throw new Error('网页预览仅支持本机联调服务；真实服务请使用 Android 安装版');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(baseUrl + '/v1/pairing-codes/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
    if ([400, 401, 404, 409, 410].includes(response.status)) throw new Error('授权码无效、已使用或已过期，请从后台重新生成；旧后台需先升级');
    if (!response.ok) throw new Error(response.status === 429 ? '核验过于频繁，请稍后重试' : '授权核验失败，请稍后重试');
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > 131072) throw new Error('后台返回的授权信息格式无效');
    const raw = await response.text(); if (raw.length > 131072) throw new Error('后台返回的授权信息过大');
    return normalizePairingPreview(JSON.parse(raw), baseUrl);
  } catch (error) { if (error.name === 'AbortError') throw new Error('授权核验超时，请检查网络后重试'); if (error instanceof TypeError) throw new Error('无法核验服务，请检查地址、网络及后台是否允许本机联调'); throw error; }
  finally { clearTimeout(timer); }
}
