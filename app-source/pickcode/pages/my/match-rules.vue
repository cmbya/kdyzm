<template>
  <view class="match-rules sf-page">
    <AiOptimizationPanel :active="pageActive" />
    <view class="action-header">
      <button class="preset-btn sf-surface" @click="showPresetRules"><uni-icons type="download" size="16" color="#0867ff" /><text>使用预制规则</text></button>
    </view>
    <view v-if="loadError" class="inline-error" @click="loadRulesList">{{ loadError }} · 点击重试</view>
    <view class="rules-list" v-if="rulesList.length">
      <view class="rule-card sf-surface" v-for="rule in rulesList" :key="rule.id">
        <view class="rule-info">
          <view class="rule-header"><view class="rule-name">{{ rule.name }}</view><switch :key="rule.id + '-' + switchRevision" :checked="rule.enabled" :disabled="!!busyId" @change="handleStatusChange(rule, $event)" color="#0867ff" /></view>
          <view class="rule-time">{{ rule.origin === 'builtin' ? '内置规则' : '添加时间 ' + formatDate(rule.createTime) }}</view>
        </view>
        <view class="rule-actions">
          <button class="action-btn edit" :aria-label="'编辑规则 ' + rule.name" @click="handleEdit(rule)"><uni-icons type="compose" size="18" color="#0867ff" /><text>编辑</text></button>
          <button class="action-btn delete" :aria-label="'删除规则 ' + rule.name" @click="handleDelete(rule)"><uni-icons type="trash" size="18" color="#ff4d4f" /><text>删除</text></button>
        </view>
      </view>
    </view>
    <view class="empty-state" v-else-if="!loading && !loadError"><image src="/static/images/empty.png" mode="aspectFit" /><text>暂无匹配规则</text></view>
    <view v-if="loading" class="loading-hint">正在加载规则…</view>

    <view class="more-settings sf-surface">
      <text class="settings-title">更多设置</text>
      <view class="settings-row" @click="openIgnored"><text>已忽略短信</text><view class="settings-detail"><text>{{ ignoredCount }} 条</text><uni-icons type="right" size="16" color="#999" /></view></view>
    </view>

    <button class="add-btn" @click="handleAdd"><uni-icons type="plusempty" size="18" color="#fff" /><text>添加规则</text></button>
    <uni-popup ref="presetPopup" type="bottom">
      <view class="preset-popup sf-surface">
        <view class="popup-header"><text class="popup-title">选择预制规则</text><text class="popup-desc">选择后核对样例，再保存到本地规则</text></view>
        <scroll-view class="preset-list" scroll-y><view class="preset-item" v-for="rule in presetRules" :key="rule.id" @click="handleSelectPreset(rule)"><view class="preset-info"><text class="preset-name">{{ rule.name }}</text><text class="preset-desc">{{ rule.signature || '通用取件短信' }}</text></view><uni-icons type="right" size="16" color="#999" /></view></scroll-view>
        <view class="popup-footer"><button class="close-btn" @click="$refs.presetPopup.close()">关闭</button></view>
      </view>
    </uni-popup>
  </view>
</template>

<script>
import { getSnapshot, mutate, getPresets } from '@/services/assistant.js';
import AiOptimizationPanel from '@/components/AiOptimizationPanel.vue';

export default {
  components: { AiOptimizationPanel },
  data() {
    return { pageActive: false, rulesList: [], presetRules: getPresets(), ignoredCount: 0, busyId: '', switchRevision: 0, loading: false, loadError: '' };
  },
  onLoad() {
    uni.$on('assistant-changed', this.loadRulesList);
  },
  onShow() { this.pageActive = true; this.loadRulesList(); },
  onHide() { this.pageActive = false; },
  onUnload() { this.pageActive = false; uni.$off('assistant-changed', this.loadRulesList); },
  methods: {
    formatDate(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value || '') : date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
    },
    async loadRulesList() {
      this.loading = true;
      this.loadError = '';
      try {
        const snapshot = await getSnapshot();
        this.rulesList = snapshot.rules;
        this.ignoredCount = snapshot.ignored.length;
        this.switchRevision++;
      } catch (error) { this.loadError = error.message || '规则加载失败'; }
      finally { this.loading = false; }
    },
    async handleStatusChange(rule, event) {
      if (this.busyId) return;
      this.busyId = rule.id;
      try {
        const snapshot = await mutate('toggleRule', { id: rule.id, enabled: event.detail.value });
        this.rulesList = snapshot.rules;
      } catch (error) {
        await this.loadRulesList();
        uni.showToast({ title: error.message || '修改失败', icon: 'none' });
      } finally { this.busyId = ''; }
    },
    handleAdd() { uni.navigateTo({ url: '/pages/my/match-settings?mode=add' }); },
    handleEdit(rule) { uni.navigateTo({ url: '/pages/my/match-settings?mode=edit&id=' + encodeURIComponent(rule.id) }); },
    handleDelete(rule) {
      if (this.busyId) return;
      uni.showModal({ title: '删除规则？', content: '删除后不再使用“' + rule.name + '”识别新短信，已有取件记录保留。', success: async result => {
        if (!result.confirm) return;
        this.busyId = rule.id;
        try {
          const snapshot = await mutate('deleteRule', { id: rule.id });
          this.rulesList = snapshot.rules;
          uni.showToast({ title: '已删除', icon: 'success' });
        } catch (error) { uni.showToast({ title: error.message || '删除失败', icon: 'none' }); }
        finally { this.busyId = ''; }
      } });
    },
    showPresetRules() { this.$refs.presetPopup.open(); },
    handleSelectPreset(rule) {
      this.$refs.presetPopup.close();
      const existing = this.rulesList.find(item => item.id === rule.id);
      uni.navigateTo({ url: '/pages/my/match-settings?' + (existing ? 'id=' : 'preset=') + encodeURIComponent(rule.id) });
    },
    openIgnored() { uni.navigateTo({ url: '/pages/my/ignored' }); }
  }
};
</script>

<style lang="scss" scoped>
.match-rules { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.action-header { margin-bottom: 14px; }.preset-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 48px; height: auto; padding: 12px 14px; border-radius: 16px; color: var(--sf-blue); font-size: 15px; line-height: 1.5; }
.rule-card { border-radius: 24px; padding: 18px; margin-bottom: 12px; }.rule-info { margin-bottom: 12px; }.rule-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; }.rule-name { flex: 1; min-width: 0; font-size: 17px; color: var(--sf-text); font-weight: 650; line-height: 1.5; overflow-wrap: anywhere; }.rule-time { font-size: 13px; color: var(--sf-muted); }
.rule-actions { display: flex; justify-content: flex-end; gap: 8px; }.action-btn { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 44px; height: auto; margin: 0; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; }.edit { background: rgba(8,103,255,.08); color: var(--sf-blue); }.delete { background: #ffeded; color: #aa343b; }
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 0; color: var(--sf-muted); font-size: 15px; }.empty-state image { width: 96px; height: 96px; }
.add-btn { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; height: auto; margin-top: 20px; padding: 12px; border-radius: 14px; background: var(--sf-blue); color: #fff; font-size: 16px; line-height: 1.5; }
.preset-popup { background: var(--sf-sheet); border-radius: 28px 28px 0 0; padding-bottom: env(safe-area-inset-bottom); }.popup-header { padding: 24px 20px 18px; }.popup-title { display: block; font-size: 21px; font-weight: 700; line-height: 1.5; color: var(--sf-text); }.popup-desc { display: block; margin-top: 8px; color: var(--sf-muted); font-size: 13px; line-height: 1.65; }.preset-list { max-height: 56vh; max-height: 56dvh; padding: 0 16px; box-sizing: border-box; }.preset-item { display: flex; align-items: center; justify-content: space-between; padding: 16px; background: rgba(255,255,255,.3); border: 1px solid rgba(255,255,255,.65); border-radius: 18px; margin-bottom: 10px; }.preset-info { flex: 1; min-width: 0; margin-right: 12px; }.preset-name { display: block; margin-bottom: 4px; color: var(--sf-text); font-size: 16px; font-weight: 600; }.preset-desc { color: var(--sf-muted); font-size: 13px; line-height: 1.6; }.popup-footer { padding: 16px 20px 24px; }.close-btn { min-height: 48px; height: auto; padding: 12px; border-radius: 14px; background: rgba(255,255,255,.4); font-size: 15px; line-height: 1.5; color: var(--sf-blue); }
.more-settings { margin: 20px 0; padding: 12px 18px; border-radius: 24px; }.settings-title { display: block; color: var(--sf-muted); font-size: 13px; font-weight: 600; padding-top: 4px; }.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; font-size: 15px; }.settings-detail { display: flex; align-items: center; gap: 8px; color: var(--sf-muted); font-size: 13px; }.loading-hint { display: block; color: var(--sf-muted); font-size: 14px; line-height: 1.7; margin: 12px 0; }.inline-error { padding: 12px 14px; background: #fff0ef; color: #aa343b; font-size: 14px; line-height: 1.7; border-radius: 14px; margin-bottom: 12px; }button[disabled] { opacity: .5; }button::after { border: 0; }
</style>
