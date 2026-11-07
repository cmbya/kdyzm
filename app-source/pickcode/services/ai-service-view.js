// Older backends expose a channel list; only their explicit default is eligible.
export function backendAiService(result = {}) {
  if (result.service?.mode === 'backend_default') return { ...result.service, available: result.service.available === true };
  const channel = (result.channels || []).find(item => item.id === result.defaultChannelId);
  return { mode: 'backend_default', available: !!channel, channelId: channel?.id || '', channelName: channel?.name || '', model: channel?.model || '',
    code: channel ? 'AI_READY' : 'AI_NOT_CONFIGURED', message: channel ? '' : '请在后台 AI 设置中选择可用的默认服务' };
}
