<template>
  <view class="ai-panel sf-surface">
    <view class="panel-heading"><text class="panel-title">短信 AI 建议</text><text class="state-label">{{ state.enabled ? '自动准备' : '已暂停' }}</text></view>

    <text class="field-label">后台统一 AI 服务</text>
    <view class="channel-picker" role="status" aria-live="polite">{{ channelName }}</view>

    <text v-if="serviceLoaded && !service.available && !error" class="hint">{{ service.message }}</text>
    <view class="toggle-row"><label for="sms-ai-enabled">自动准备优化建议</label><button id="sms-ai-enabled" class="ai-toggle" :class="{ enabled: state.enabled }" role="switch" :aria-checked="state.enabled" aria-label="自动准备优化建议" :tabindex="busy || loading || !native || (!state.enabled && !canEnable) ? -1 : 0" :disabled="busy || loading || !native || (!state.enabled && !canEnable)" @click="toggle({ detail: { value: !state.enabled } })"><view></view></button></view>
    <text v-if="!native" class="hint">自动识别在 Android 应用中运行。</text>
    <text v-if="error" class="error" role="alert">{{ error }}</text>
    <view class="panel-tools"><button role="button" :tabindex="busy || loading ? -1 : 0" :disabled="busy || loading" @click="reload(true)">{{ loading ? '正在读取…' : '刷新服务状态' }}</button><button role="button" :tabindex="busy || !state.enabled ? -1 : 0" v-if="hasFailed" :disabled="busy || !state.enabled" @click="retry">重试未完成</button></view>
    <text v-if="state.enabled && !state.pending.length" class="empty-hint">暂无待确认建议。下次扫描发现合适样例时会自动分析。</text>
    <view v-for="item in state.pending" :key="item.id" class="proposal">
      <view class="proposal-heading"><text>{{ item.candidate?.name || '识别新短信' }}</text><text class="state-label">{{ statusText(item.status) }}</text></view>
      <template v-if="item.status === 'ready'">
        <text class="result-code">取件码 {{ item.expectedCode }}</text>
        <text class="hint">已通过本机样例及验证码反例校验</text>
        <button role="button" tabindex="0" class="details-button" :aria-expanded="expandedId === item.id" @click="expandedId = expandedId === item.id ? '' : item.id">{{ expandedId === item.id ? '收起样例与规则' : '核对样例与规则' }}</button>
        <view v-if="expandedId === item.id" class="proposal-details">
          <text class="source-sample">{{ item.sourceSample }}</text>
          <text>适用签名：{{ item.candidate.signature || '不限签名' }}</text>
          <text>提取位置：{{ item.candidate.rules.code.start }} → {{ item.candidate.rules.code.end || '下一个完整取件码' }}</text>
          <text v-if="item.candidate.keywords?.length">必要文字：{{ item.candidate.keywords.join('、') }}</text>
        </view>
      </template>
      <text v-else-if="item.status === 'failed'" class="error">{{ item.error || '未通过校验，可重试或手动设置' }}</text>
      <view class="proposal-actions">
        <button role="button" :tabindex="busy || !state.enabled ? -1 : 0" v-if="item.status === 'ready'" class="primary" :disabled="busy || !state.enabled" @click="resolve(item.id, true)">确认使用</button>
        <button role="button" :tabindex="busy ? -1 : 0" :disabled="busy" @click="resolve(item.id, false)">忽略</button>
      </view>
    </view>
    <text class="privacy-note">只发送合成模板片段；原短信与真实取件码留在本机。建议确认后才生效。</text>
  </view>
</template>

<script>
import { getRuntimeStatus, getAiChannels, getAiOptimizationStatus, configureAiOptimization, approveAiProposal, ignoreAiProposal, analyzeAiProposals } from '@/services/assistant.js';
import { backendAiService } from '@/services/ai-service-view.js';

export default {
  props: { active: { type: Boolean, default: true } },
  data() { return { native: false, service: { available: false, channelName: '' }, serviceLoaded: false, state: { enabled: false, pending: [] }, loading: false, busy: false, error: '', expandedId: '', switchKey: 0, timer: null, epoch: 0 }; },
  computed: {
    channelName() { return this.service.channelName || (this.loading ? '读取中…' : this.error ? '暂时无法读取后台服务' : this.serviceLoaded ? '后台服务暂不可用' : '等待读取后台服务'); },
    hasFailed() { return this.state.pending.some(item => item.status === 'failed'); },
    canEnable() { return this.serviceLoaded && this.service.available && !this.error; }
  },
  watch: { active(value) { if (value) this.reload(true); else this.stop(); } },
  mounted() { this.$el?.addEventListener?.('keydown', this.keyboardActivate); this.$el?.addEventListener?.('keyup', this.keyboardActivate); if (this.active) this.reload(true); },
  beforeUnmount() { this.$el?.removeEventListener?.('keydown', this.keyboardActivate); this.$el?.removeEventListener?.('keyup', this.keyboardActivate); this.stop(); },
  methods: {
    keyboardActivate(event) {
      if (!['Enter', ' '].includes(event.key)) return;
      const element = event.target?.closest?.('[role="button"], [role="switch"]');
      if (!element || ['BUTTON', 'INPUT'].includes(element.tagName)) return;
      event.preventDefault(); event.stopPropagation();
      // uni-modal listens on document keyup; activate after swallowing this key release
      // so the opening Enter cannot also consent to a newly created modal.
      if (event.type === 'keydown') return;
      if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return;
      element.click();
    },
    stop() { clearTimeout(this.timer); this.timer = null; this.epoch++; this.loading = false; },
    schedule() { clearTimeout(this.timer); if (this.active) this.timer = setTimeout(() => this.reload(false), 5000); },
    async reload(loadChannels = false) {
      if (!this.active || this.loading || this.busy) { this.schedule(); return; }
      const epoch = ++this.epoch;
      this.loading = true;
      try {
        const [runtime, status] = await Promise.all([getRuntimeStatus(), getAiOptimizationStatus()]);
        if (epoch !== this.epoch) return;
        this.native = runtime.native; this.state = status;
        if (status.service) { this.service = backendAiService({ service: status.service }); this.serviceLoaded = true; }
        if (loadChannels) {
          const result = await getAiChannels();
          if (epoch !== this.epoch) return;
          this.service = backendAiService(result); this.serviceLoaded = true;
          this.error = '';
        }
      } catch (error) { if (epoch === this.epoch) this.error = error.message || 'AI 状态读取失败'; }
      finally { if (epoch === this.epoch) { this.loading = false; this.switchKey++; this.schedule(); } }
    },
    statusText(status) { return ({ queued: '等待分析', generating: '分析中', ready: '待确认', failed: '需重试' })[status] || '待处理'; },
    async save(enabled) {
      if (this.busy) return;
      this.busy = true; this.error = ''; this.epoch++;
      try { this.state = await configureAiOptimization(enabled); if (this.state.service) this.service = backendAiService({ service: this.state.service }); }
      catch (error) { this.error = error.message || '设置未保存'; }
      finally { this.busy = false; this.loading = false; this.switchKey++; this.schedule(); }
    },
    toggle(event) {
      if (this.busy || !this.native || (!this.state.enabled && !this.canEnable)) return;
      const enabled = event.detail.value; this.switchKey++;
      if (enabled) {
        uni.showModal({ title: '开启自动优化建议', content: '将未识别取件短信转换为合成模板片段，通过后台统一 AI 服务分析，并跟随后台服务设置。真实短信、姓名、电话、地址和取件码不发送。确认结果后才保存识别规则。', confirmText: '开启', success: result => { if (result.confirm) this.save(true); else this.switchKey++; } });
      } else if (this.state.pending.length) {
        uni.showModal({ title: '暂停自动优化？', content: '未确认建议将清除，已保存的规则继续有效。', success: result => { if (result.confirm) this.save(false); else this.switchKey++; } });
      } else this.save(false);
    },
    async resolve(id, approve) {
      if (this.busy) return;
      this.busy = true; this.error = ''; this.epoch++;
      try { this.state = await (approve ? approveAiProposal(id) : ignoreAiProposal(id)); if (approve) uni.showToast({ title: '规则已生效', icon: 'success' }); }
      catch (error) { this.error = error.message || '处理失败，请刷新后重试'; }
      finally { this.busy = false; this.loading = false; this.schedule(); }
    },
    async retry() {
      if (this.busy) return;
      this.busy = true; this.error = ''; this.epoch++;
      try { this.state = await analyzeAiProposals(); }
      catch (error) { this.error = error.message || '暂时无法重试'; }
      finally { this.busy = false; this.loading = false; this.schedule(); }
    }
  }
};
</script>

<style lang="scss" scoped>
.ai-panel { border-radius: 24px; padding: 18px; margin-bottom: 14px; font-size: 15px; color: var(--sf-text); }
.panel-heading, .proposal-heading, .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.panel-heading > text:first-child, .proposal-heading > text:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }.panel-title { font-size: 18px; font-weight: 650; line-height: 1.5; }.state-label { color: var(--sf-muted); font-size: 12px; flex: none; padding: 3px 7px; border-radius: 7px; background: rgba(222,231,245,.5); }
.hint, .privacy-note, .empty-hint { display: block; color: var(--sf-muted); font-size: 13px; line-height: 1.75; margin-top: 10px; }.privacy-note { padding-top: 14px; border-top: 1px solid rgba(98,118,145,.13); }.field-label { display: block; margin: 18px 0 8px; color: var(--sf-muted); font-size: 13px; }.channel-picker { display: flex; align-items: center; min-height: 48px; padding: 10px 12px; box-sizing: border-box; border: 1px solid rgba(98,118,145,.2); border-radius: 12px; font-size: 15px; }
.toggle-row { min-height: 58px; }.toggle-row label { flex: 1; min-width: 0; }.ai-toggle { position: relative; flex: none; width: 52px; min-height: 44px; height: 44px; margin: 0; padding: 12px 4px; border: 0; border-radius: 0; background: transparent; box-sizing: border-box; &::before { content: ''; position: absolute; inset: 8px 0; border-radius: 20px; background: #b2bfce; } view { position: relative; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px #17223325; } &.enabled::before { background: var(--sf-blue); } &.enabled view { margin-left: 24px; } }
.panel-tools, .proposal-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }button { min-height: 48px; height: auto; font-size: 14px; line-height: 1.5; margin: 0; color: var(--sf-blue); background: rgba(8,103,255,.08); padding: 12px; border-radius: 14px; }button::after { border: 0; }button[disabled] { opacity: .5; }
.proposal { border-top: 1px solid rgba(98,118,145,.15); padding-top: 18px; margin-top: 18px; }.proposal-heading { font-size: 16px; font-weight: 600; }.proposal-heading .state-label { font-weight: 400; }.result-code { display: block; font-size: 24px; line-height: 1.4; font-weight: 700; color: var(--sf-text); margin-top: 12px; overflow-wrap: anywhere; }.details-button { background: transparent; padding-inline: 0; text-align: left; }.proposal-details { padding: 14px; background: rgba(222,231,245,.4); border-radius: 14px; overflow-wrap: anywhere; text { display: block; font-size: 14px; line-height: 1.75; } }.source-sample { margin-bottom: 12px; }.proposal-actions button { flex: 1; }.primary { background: var(--sf-blue); color: #fff; }.error { display: block; color: #aa343b; font-size: 14px; margin-top: 12px; line-height: 1.7; }
</style>
