import { stationDisplayName, pickupCabinet } from './station-presentation.js';

export const MAX_SHARE_ITEMS = 40;
export const MAX_SHARE_HEIGHT = 12000;
export const MAX_SHARE_BYTES = 1350000;
const WIDTH = 960, MARGIN = 40, ROW_HEIGHT = 148, GROUP_HEIGHT = 84;
const clean = (value, limit) => Array.from(typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim() : '').slice(0, limit).join('');
const arrived = (value, now) => Number.isFinite(value) && value > 0 && value <= now;

// Project an allowlist: raw messages, order identifiers and prices never reach the renderer.
export function pickupShareRows(snapshot, now = Date.now()) {
  const shipments = new Map(), seen = new Set(), rows = [];
  for (const order of snapshot?.packages || []) for (const shipment of order.shipments || []) shipments.set(shipment.id, { order, shipment });
  for (const item of snapshot?.codes || []) {
    if (!item.id || item.hidden || item.deleted || item.isPicked || item.needsPickupAssignment || item.conflicts?.length ||
        !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(item.code || '') || !/\d/.test(item.code) || item.code.length < 3 || item.code.length > 12 || /^\d{9,}$/.test(item.code)) continue;
    const smsArrival = arrived(item.arrivalAt, now) && (item.sources?.some(source => !source.ignored && source.kind !== 'reminder') || !!item.sourceId);
    const members = item.members?.length ? item.members : [{ id: item.id, picked: item.isPicked }];
    for (const member of members) {
      if (member.picked || member.closedCycleId) continue;
      const linked = shipments.get(member.shipmentId), independent = item.needsMatchReview || typeof member.independentPicked === 'boolean';
      if (linked && (linked.order.hidden || linked.order.archived || linked.shipment.hidden || linked.shipment.archived)) continue;
      if (member.shipmentId && !independent && (!linked || linked.shipment.picked || linked.shipment.canPick === false || linked.shipment.isHomeDelivery || linked.shipment.pickupConflict || ['returning', 'returned'].includes(linked.shipment.status))) continue;
      const shipment = !independent && linked?.shipment;
      if (!smsArrival && !item.isManual && !(shipment && arrived(shipment.arrivalAt, now))) continue;
      const key = !independent && member.shipmentId ? 'shipment:' + member.shipmentId : JSON.stringify([item.id, member.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ key, station: clean(stationDisplayName(item, '未识别站点'), 80), cabinet: clean(pickupCabinet(item), 20),
        code: item.code, carrier: clean(shipment?.carrier || item.company, 24), title: clean(shipment ? linked.order.title : '', 15), count: 1 });
    }
  }
  return rows;
}

export function groupShareRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.station)) groups.set(row.station, { station: row.station, rows: [], count: 0 });
    const group = groups.get(row.station); group.rows.push(row); group.count += row.count;
  }
  return [...groups.values()];
}

export function shareImageLayout(rows) {
  if (!rows.length) throw new Error('请先选择要分享的包裹');
  if (rows.length > MAX_SHARE_ITEMS) throw new Error(`一次最多生成 ${MAX_SHARE_ITEMS} 件，请分批选择`);
  const groups = groupShareRows(rows), height = 180 + groups.length * GROUP_HEIGHT + rows.length * ROW_HEIGHT + MARGIN;
  if (height > MAX_SHARE_HEIGHT || WIDTH * height > 12000000) throw new Error('长图过大，请减少所选包裹后重试');
  return { width: WIDTH, height, groups };
}

function rounded(ctx, x, y, width, height, radius) {
  ctx.beginPath(); ctx.moveTo(x + radius, y); ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius); ctx.arcTo(x, y + height, x, y, radius); ctx.arcTo(x, y, x + width, y, radius); ctx.closePath();
}
function label(ctx, value, x, y, size, maxWidth, bold = false, color = '#172234') {
  ctx.font = `${bold ? 700 : 400} ${size}px system-ui, -apple-system, "Microsoft YaHei", sans-serif`; ctx.fillStyle = color;
  let text = value;
  while (text && ctx.measureText(text).width > maxWidth) text = Array.from(text).slice(0, -1).join('');
  ctx.fillText(text === value ? text : text + '…', x, y);
}

export async function renderPickupShare(rows, documentRef = globalThis.document) {
  const layout = shareImageLayout(rows);
  if (!documentRef?.createElement) throw new Error('当前环境无法生成图片，请使用 Android 安装版或浏览器');
  await documentRef.fonts?.ready;
  const canvas = documentRef.createElement('canvas'); canvas.width = layout.width; canvas.height = layout.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片生成不可用，请重试');
    ctx.fillStyle = '#eaf0f7'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.textBaseline = 'middle';
    label(ctx, '取件清单', MARGIN, 76, 54, 440, true);
    label(ctx, `${rows.length} 件 · ${layout.groups.length} 个站点`, 570, 80, 29, 350, false, '#52637c');
    ctx.strokeStyle = '#c4d3e5'; ctx.beginPath(); ctx.moveTo(MARGIN, 136); ctx.lineTo(WIDTH - MARGIN, 136); ctx.stroke();
    let y = 158;
    for (const group of layout.groups) {
      label(ctx, group.station, MARGIN + 4, y + 36, 35, WIDTH - MARGIN * 2 - 100, true);
      label(ctx, `${group.count} 件`, WIDTH - 120, y + 36, 29, 80, false, '#0867ff'); y += GROUP_HEIGHT;
      for (const row of group.rows) {
        const h = ROW_HEIGHT - 20, divider = 245;
        rounded(ctx, MARGIN, y, WIDTH - MARGIN * 2, h, 22); ctx.fillStyle = '#f7faff'; ctx.fill(); ctx.strokeStyle = '#c6d6e8'; ctx.lineWidth = 2; ctx.stroke();
        ctx.save(); rounded(ctx, MARGIN, y, WIDTH - MARGIN * 2, h, 22); ctx.clip(); ctx.fillStyle = '#e0f2ed'; ctx.fillRect(MARGIN, y, divider - MARGIN, h); ctx.restore();
        label(ctx, row.cabinet || '取件', MARGIN + 24, y + 45, 34, divider - MARGIN - 46, true, '#087d6c');
        label(ctx, `${row.count}件`, MARGIN + 24, y + 91, 28, 150, false, '#52637c');
        ctx.strokeStyle = '#bbd2d8'; ctx.setLineDash([8, 7]); ctx.beginPath(); ctx.moveTo(divider, y); ctx.lineTo(divider, y + h); ctx.stroke(); ctx.setLineDash([]);
        let size = 58; ctx.font = `700 ${size}px system-ui, sans-serif`;
        while (size > 36 && ctx.measureText(row.code).width > WIDTH - divider - MARGIN - 54) { size -= 2; ctx.font = `700 ${size}px system-ui, sans-serif`; }
        label(ctx, row.code, divider + 28, y + 47, size, WIDTH - divider - MARGIN - 44, true);
        label(ctx, [row.carrier, row.title].filter(Boolean).join(' · '), divider + 28, y + 99, 27, WIDTH - divider - MARGIN - 50, false, '#52637c');
        ctx.fillStyle = '#eaf0f7';
        for (const x of [MARGIN, WIDTH - MARGIN]) { ctx.beginPath(); ctx.arc(x, y + h / 2, 9, 0, Math.PI * 2); ctx.fill(); }
        y += ROW_HEIGHT;
      }
    }
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片生成失败，请减少所选包裹后重试')), 'image/png'));
    if (blob.size > MAX_SHARE_BYTES) throw new Error('长图文件过大，请分批生成');
    const filename = '取件清单-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败，请重试')); reader.readAsDataURL(blob); });
    return { blob, dataUrl, filename, width: layout.width, height: layout.height, file: typeof File === 'function' ? new File([blob], filename, { type: 'image/png' }) : null };
  } finally { canvas.width = 0; canvas.height = 0; }
}

export function browserShareSupported(image, navigatorRef = globalThis.navigator) {
  return !!(image?.file && navigatorRef?.share && navigatorRef?.canShare?.({ files: [image.file] }));
}
export function shareInBrowser(image, navigatorRef = globalThis.navigator) {
  if (!browserShareSupported(image, navigatorRef)) throw new Error('当前浏览器不支持图片分享，请先保存长图后分享');
  return navigatorRef.share({ files: [image.file], title: '取件清单' });
}
export function saveInBrowser(image, documentRef = globalThis.document) {
  const url = URL.createObjectURL(image.blob), link = documentRef.createElement('a');
  link.href = url; link.download = image.filename; documentRef.body.appendChild(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
