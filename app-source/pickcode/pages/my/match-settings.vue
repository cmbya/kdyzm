<template>
  <view class="match-settings sf-page">
    <view v-if="loadError" class="notice error">{{ loadError }}</view>
    <view class="input-section sf-surface">
      <text class="section-title">规则名称</text>
      <input class="rule-name-input" v-model="ruleName" placeholder="请输入规则名称" aria-label="规则名称" :disabled="loading || generating || saving" :maxlength="60" />
    </view>
    <view class="input-section sf-surface">
      <text class="section-title">短信内容</text>
      
      <textarea class="sms-input" v-model="smsContent" placeholder="请输入完整的短信内容" aria-label="短信内容" :disabled="loading || generating || saving" :maxlength="4000" />
      <template v-if="kind === 'pickup'">
        <text class="section-title expected-label">正确取件码</text>
        <input class="rule-name-input" v-model="expectedCode" placeholder="请输入这条短信的正确取件码" aria-label="正确取件码" :disabled="loading || generating || saving" :maxlength="12" />
        <text class="section-title expected-label">后台统一 AI 服务</text>
        <view class="channel-picker" role="status" aria-live="polite">{{ aiService.channelName || (aiLoadError ? '暂时无法读取后台服务' : '后台服务暂不可用') }}</view>
        <text class="section-desc">跟随后台设置，无需在手机另选渠道或填写密钥。</text>
        <text v-if="aiLoadError || !aiService.available" class="section-desc error" role="alert">{{ aiLoadError || aiService.message }}</text>
        <button class="refresh-ai" :disabled="aiLoading || generating || saving" @click="loadAiChannels">{{ aiLoading ? '正在读取…' : '刷新服务状态' }}</button>
        <button role="button" :tabindex="canGenerate ? 0 : -1" :aria-disabled="!canGenerate" class="generate-btn" :disabled="!canGenerate" :loading="generating" @click="handleGenerate">{{ generating ? '正在生成并校验' : '生成并验证模板' }}</button>
        <text class="section-desc assist-note">只发送合成模板片段，原短信和真实取件码留在本机。核对下方结果后保存。</text>
      </template>
      <text v-else class="section-desc assist-note">{{ kind === 'arrival' ? '到站通知' : '催取提醒' }}模板不提取取件码，请粘贴对应短信验证。</text>
      <view v-if="candidateNotice" class="notice">{{ candidateNotice }}</view>
    </view>
    <view class="rules-section sf-surface">
      <view class="rules-desc">
        <text>设置规则说明：</text>
        <text>1. 输入要匹配内容的前后文字</text>
        <text>2. 结束文字留空时，取件码读取下一个完整码，其他字段读取至短信结尾</text>
      </view>
      <view class="rule-item" v-for="field in fields" :key="field.key">
        <view class="rule-header"><text class="rule-title">{{ field.label }}</text></view>
        <view class="rule-inputs">
          <input v-model="rules[field.key].start" :placeholder="field.key === 'code' && kind === 'pickup' ? '起始文字（必填）' : '起始文字（可选）'" :aria-label="field.label + '起始文字'" :disabled="loading || generating || saving" :maxlength="80" />
          <text>至</text>
          <input v-model="rules[field.key].end" placeholder="结束文字（可留空）" :aria-label="field.label + '结束文字'" :disabled="loading || generating || saving" :maxlength="80" />
        </view>
        <view class="match-result" v-if="rules[field.key].start">
          <text v-if="preview[field.key]" class="success">匹配结果：{{ preview[field.key] }}</text>
          <text v-else class="error">未匹配，请检查前后文字</text>
        </view>
      </view>
    </view>
    <view class="input-section validation-section sf-surface">
      <text class="section-title">样例验证</text>
      <view class="validation-row"><text>当前短信</text><text :class="validation.valid ? 'success' : 'error'">{{ validation.valid ? (preview.code || '提醒匹配通过') : '未通过' }}</text></view>
      <text class="section-desc validation-note">{{ validation.message }}</text>
      <text v-if="signature" class="section-desc">适用短信签名：{{ signature }}</text>
      <text v-if="keywords.length" class="section-desc">必须包含：{{ keywords.join('、') }}</text>
    </view>
    <view class="btn-section">
      <button class="save-btn" role="button" :tabindex="canSave ? 0 : -1" :aria-disabled="!canSave" :disabled="!canSave" :loading="saving" @click="handleSave">保存规则</button>
    </view>
  </view>
</template>

<script>
import { getSnapshot, mutate, getPresets, previewRule, validateCandidate, getRuntimeStatus, getAiChannels, generateTemplate } from '@/services/assistant.js';
import { backendAiService } from '@/services/ai-service-view.js';

const emptyRules = () => ({ code: { start: '', end: '' }, express: { start: '', end: '' }, address: { start: '', end: '' } });

export default {
  data() {
    return {
      ruleId: '', ruleName: '', smsContent: '', expectedCode: '', rules: emptyRules(),
      signature: '', keywords: [], kind: 'pickup', priority: 100, origin: 'manual', enabled: true, createTime: 0,
      loading: false, loadError: '', generating: false, saving: false, candidateNotice: '', candidateSample: '', candidateCode: '',
      aiService: { available: false, channelName: '', message: '正在读取后台服务' }, aiLoadError: '', aiLoading: false,
      fields: [{ key: 'code', label: '取件码' }, { key: 'express', label: '快递名称' }, { key: 'address', label: '地址' }]
    };
  },
  computed: {
    canGenerate() { return !this.loading && !this.generating && !this.saving && !this.aiLoading && !this.aiLoadError && this.aiService.available && !!this.smsContent.trim() && !!this.expectedCode.trim(); },
    draft() {
      return {
        id: this.ruleId || 'preview', name: this.ruleName.trim() || '未命名规则', enabled: this.enabled,
        priority: this.priority, signature: this.signature, keywords: this.keywords, kind: this.kind,
        rules: this.rules, smsContent: this.smsContent, expectedCode: this.expectedCode.trim(),
        origin: this.origin, createTime: this.createTime || Date.now()
      };
    },
    preview() {
      try { return previewRule(this.smsContent, { ...this.draft, enabled: true }) || {}; }
      catch (_) { return {}; }
    },
    validation() {
      if (!this.smsContent.trim()) return { valid: false, message: '先粘贴一条完整短信进行验证。' };
      if (this.kind === 'pickup' && !this.expectedCode.trim()) return { valid: false, message: '请填写正确取件码，再核对匹配结果。' };
      if (['deepseek', 'ai'].includes(this.origin) && (this.candidateSample !== this.smsContent || this.candidateCode !== this.expectedCode.trim())) return { valid: false, message: '样例或正确取件码已改变，请重新生成候选模板。' };
      try {
        const result = previewRule(this.smsContent, { ...this.draft, enabled: true });
        if (!result || result.ruleId !== this.draft.id || result.kind !== this.kind || (this.kind === 'pickup' && result.code !== this.expectedCode.trim())) throw new Error('匹配结果与正确取件码不一致，请调整规则。');
        return { valid: true, message: this.kind === 'pickup' ? '与正确取件码一致。确认快递名称和地址后保存，日常识别在本机完成。' : '提醒规则匹配通过，不会生成取件码。确认后保存。' };
      } catch (error) {
        return { valid: false, message: error.message || '匹配结果与正确取件码不一致，请调整规则。' };
      }
    },
    canSave() { return this.validation.valid && this.ruleName.trim() && !this.loading && !this.generating && !this.saving && !this.loadError; }
  },
  mounted() { this.$el?.addEventListener?.('keydown', this.keyboardActivate); this.$el?.addEventListener?.('keyup', this.keyboardActivate); },
  beforeUnmount() { this.$el?.removeEventListener?.('keydown', this.keyboardActivate); this.$el?.removeEventListener?.('keyup', this.keyboardActivate); },
  async onLoad(options) {
    this.loading = true;
    try {
      if (options.id) {
        const snapshot = await getSnapshot();
        const rule = snapshot.rules.find(item => item.id === options.id);
        if (!rule) throw new Error('规则不存在，请返回规则列表重试');
        this.applyRule(rule);
      } else if (options.preset) {
        const rule = getPresets().find(item => item.id === options.preset);
        if (!rule) throw new Error('预制规则不存在');
        this.applyRule({ ...rule, id: '', enabled: true, createTime: 0 });
      }
    } catch (error) { this.loadError = error.message || '规则加载失败'; }
    finally { this.loading = false; }
    await this.loadAiChannels();
  },
  methods: {
    keyboardActivate(event) {
      if (!['Enter', ' '].includes(event.key)) return;
      const element = event.target?.closest?.('[role="button"]');
      if (!element || ['BUTTON', 'INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.type === 'keydown' || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return;
      element.click();
    },
    async loadAiChannels() {
      if (this.aiLoading || this.generating || this.saving) return;
      this.aiLoading = true; this.aiLoadError = '';
      try {
        const runtime = await getRuntimeStatus();
        if (!runtime.native) { this.aiLoadError = '请在 Android 应用中生成模板'; return; }
        this.aiService = backendAiService(await getAiChannels());
      } catch (error) { this.aiLoadError = error.message || '无法读取 AI 设置'; }
      finally { this.aiLoading = false; }
    },
    applyRule(rule) {
      this.ruleId = rule.id || '';
      this.ruleName = rule.name || '';
      this.smsContent = rule.smsContent || '';
      this.expectedCode = rule.expectedCode || '';
      this.rules = JSON.parse(JSON.stringify(rule.rules || emptyRules()));
      this.signature = rule.signature || '';
      this.keywords = rule.keywords || [];
      this.kind = rule.kind || 'pickup';
      this.priority = rule.priority === undefined ? 100 : rule.priority;
      this.origin = rule.origin || 'manual';
      this.enabled = rule.enabled !== false;
      this.createTime = rule.createTime || 0;
      this.candidateSample = this.smsContent;
      this.candidateCode = this.expectedCode.trim();
    },
    async handleGenerate() {
      if (!this.canGenerate) return;
      await this.generateCandidate();
    },
    async generateCandidate() {
      if (this.generating) return;
      this.generating = true;
      this.candidateNotice = '';
      const sample = this.smsContent;
      const expected = this.expectedCode.trim();
      try {
        const candidate = await generateTemplate(sample, expected);
        const tested = validateCandidate(candidate, sample, expected);
        if (sample !== this.smsContent || expected !== this.expectedCode.trim()) throw new Error('样例已变更，请为当前样例重新生成');
        const id = this.ruleId;
        const enabled = this.enabled;
        const createTime = this.createTime;
        this.applyRule({ ...tested, id, enabled, createTime, origin: 'ai', smsContent: sample, expectedCode: expected });
        this.candidateNotice = '已生成候选模板，请核对下方匹配结果后保存。';
      } catch (error) { this.candidateNotice = error.message || '生成失败，原规则已保留，请稍后重试'; }
      finally { this.generating = false; }
    },
    async handleSave() {
      if (!this.canSave) return;
      this.saving = true;
      try {
        const snapshot = await getSnapshot();
        if (snapshot.rules.some(rule => rule.name === this.ruleName.trim() && rule.id !== this.ruleId)) throw new Error('规则名称已存在');
        if (!this.validation.valid) throw new Error(this.validation.message);
        await mutate('saveRule', { rule: { ...this.draft, id: this.ruleId || '', enabled: this.enabled } });
        uni.showToast({ title: '保存成功', icon: 'success' });
        uni.navigateBack();
      } catch (error) { uni.showToast({ title: error.message || '保存失败，请重试', icon: 'none' }); }
      finally { this.saving = false; }
    }
  }
};
</script>

<style lang="scss" scoped>
.match-settings { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.input-section { padding: 18px; border-radius: 24px; margin-bottom: 14px; }
.section-title, .rule-title { display: block; font-size: 16px; color: var(--sf-text); font-weight: 600; margin-bottom: 10px; }.section-desc { display: block; color: var(--sf-muted); font-size: 13px; line-height: 1.75; margin: 10px 0; }
.rule-name-input, .sms-input { width: 100%; border: 1px solid #8796ab; border-radius: 12px; padding: 0 12px; font-size: 16px; color: var(--sf-text); box-sizing: border-box; background: rgba(255,255,255,.38); }.rule-name-input { height: 48px; }.sms-input { height: 144px; padding: 12px; line-height: 1.65; }.expected-label { margin-top: 20px; }
.channel-picker { min-height: 48px; display: flex; align-items: center; border: 1px solid rgba(98,118,145,.2); border-radius: 12px; padding: 8px 12px; font-size: 15px; box-sizing: border-box; }
.refresh-ai, .generate-btn, .save-btn { min-height: 48px; height: auto; padding: 11px 14px; font-size: 15px; line-height: 1.6; border-radius: 14px; margin-top: 12px; }.refresh-ai { color: var(--sf-blue); background: rgba(8,103,255,.08); }.generate-btn { color: var(--sf-blue); background: rgba(255,255,255,.3); border: 1px solid rgba(8,103,255,.3); }.assist-note { margin: 12px 0 0; }
.rules-section { border-radius: 24px; overflow: hidden; }.rules-desc { padding: 16px 18px; border-bottom: 1px solid rgba(98,118,145,.15); text { display: block; font-size: 13px; color: var(--sf-muted); line-height: 1.75; } }.rule-item { padding: 18px; border-bottom: 1px solid rgba(98,118,145,.15); &:last-child { border-bottom: 0; } }.rule-inputs { display: flex; align-items: center; gap: 8px; input { flex: 1; width: 0; min-width: 0; height: 48px; border: 1px solid #8796ab; border-radius: 12px; padding: 0 10px; font-size: 15px; background: rgba(255,255,255,.38); } text { color: var(--sf-muted); font-size: 14px; } }
.match-result { margin-top: 12px; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }.success { color: var(--sf-teal); }.error { color: #aa343b; }.notice { padding: 12px 14px; margin: 12px 0; font-size: 14px; line-height: 1.7; background: rgba(222,235,254,.65); color: var(--sf-muted); border-radius: 14px; }.notice.error { background: #fff0ef; color: #aa343b; }
.validation-section { margin-top: 14px; }.validation-row { display: flex; justify-content: space-between; gap: 12px; font-size: 15px; }.validation-row text:last-child { overflow-wrap: anywhere; text-align: right; }.validation-note { margin-top: 12px; }.btn-section { margin-top: 20px; }.save-btn { background: var(--sf-blue); color: #fff; }button[disabled] { opacity: .5; }button::after { border: 0; }
</style>
