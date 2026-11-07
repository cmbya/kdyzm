<template>
  <view class="ignored-page sf-page">
    <text class="hint">已忽略的短信不会再次自动生成取件码。</text>
    <view v-if="error" class="notice error" @click="loadIgnored">{{ error }} · 点击重试</view>
    <view v-if="notice" class="notice">{{ notice }}</view>
    <view v-if="loading" class="empty sf-surface">正在加载…</view>
    <view v-else-if="!records.length && !error" class="empty sf-surface">暂无已忽略短信</view>
    <view class="record sf-surface" v-for="item in records" :key="item.sourceId">
      <text class="title">{{ item.sender || '来源短信' }}</text>
      <text class="date">{{ formatDate(item.date) }}</text>
      <text class="source-text">{{ item.body }}</text>
      <text v-if="item.reason" class="hint">{{ item.reason }}</text>
      <button :disabled="!!restoringId" :loading="restoringId === item.sourceId" @click="restore(item)">恢复识别</button>
    </view>
    <text class="hint">恢复后按当前规则重新处理，不直接恢复旧的错误结果。</text>
  </view>
</template>

<script>
import { getSnapshot, mutate } from '@/services/assistant.js';

export default {
  data() { return { records: [], loading: true, restoringId: '', error: '', notice: '' }; },
  onLoad() { uni.$on('assistant-changed', this.loadIgnored); },
  onShow() { this.loadIgnored(); },
  onUnload() { uni.$off('assistant-changed', this.loadIgnored); },
  methods: {
    formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    },
    async loadIgnored() {
      this.loading = true; this.error = '';
      try { this.records = (await getSnapshot()).ignored.slice().sort((a, b) => b.date - a.date); }
      catch (error) { this.error = error.message || '忽略记录加载失败'; }
      finally { this.loading = false; }
    },
    async restore(item) {
      if (this.restoringId) return;
      this.restoringId = item.sourceId;
      try {
        const snapshot = await mutate('restore', { sourceId: item.sourceId });
        this.records = snapshot.ignored.slice().sort((a, b) => b.date - a.date);
        this.notice = '已恢复，将按当前规则重新识别。';
      } catch (error) { uni.showToast({ title: error.message || '恢复失败，请重试', icon: 'none' }); }
      finally { this.restoringId = ''; }
    }
  }
};
</script>

<style lang="scss" scoped>
.ignored-page { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.hint { display: block; color: var(--sf-muted); font-size: 13px; line-height: 1.7; margin: 12px 2px; }
.record, .empty { padding: 18px; border-radius: 24px; margin-bottom: 12px; }
.title { display: block; color: var(--sf-text); font-size: 17px; line-height: 24px; font-weight: 650; margin-bottom: 6px; }
.date { display: block; color: var(--sf-muted); font-size: 13px; }
.source-text { display: block; margin: 14px 0; padding: 14px; background: rgba(226,233,242,.4); border-radius: 14px; color: var(--sf-text); font-size: 15px; line-height: 1.75; overflow-wrap: anywhere; }
button { width: 100%; height: auto; min-height: 48px; padding: 10px 14px; line-height: 1.6; background: rgba(255,255,255,.3); border: 1px solid rgba(8,103,255,.3); border-radius: 14px; color: var(--sf-blue); font-size: 15px; &::after { border: 0; } &[disabled] { opacity: .5; } }
.empty { font-size: 15px; color: var(--sf-muted); line-height: 1.7; text-align: center; padding-block: 32px; }
.notice { padding: 12px 14px; background: rgba(222,235,254,.65); color: var(--sf-muted); border-radius: 14px; font-size: 14px; line-height: 1.7; margin-bottom: 12px; }.error { color: #aa343b; background: #fff0ef; }
</style>
