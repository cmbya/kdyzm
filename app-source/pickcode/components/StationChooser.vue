<template>
  <uni-popup ref="popup" type="bottom" :safe-area="false" @change="popupChanged">
    <view v-if="opened" ref="sheet" class="station-sheet sf-surface" role="dialog" aria-modal="true" aria-label="更换站点" @click.stop @keydown.stop="onKey" @keyup.stop="onKey">
      <view class="station-heading"><text>更换站点</text><button ref="closeButton" type="button" role="button" tabindex="0" :disabled="busy" aria-label="关闭更换站点" @click="close">关闭</button></view>
      <text class="station-current">当前：{{ currentStation }}</text>
      <text v-if="item?.pickupId || item?.totalCount > 1 || item?.members?.length > 1" class="station-note">该取件码的包裹将一起更换站点。</text>
      <text v-if="correction" class="station-note">人工指定 · 原识别：{{ correction.originalStation || '未识别站点' }}</text>
      <scroll-view v-if="choices.length" scroll-y class="station-options">
        <button v-for="station in choices" :key="station.id" type="button" role="button" tabindex="0" class="station-option" :class="{ selected: correction?.stationId === station.id }" :aria-pressed="correction?.stationId === station.id" :disabled="busy" @click="save(station.id)"><text>{{ station.name }}</text><text class="station-option-hint">{{ correction?.stationId === station.id ? '当前人工指定' : station.usage ? '常用' : '' }}</text></button>
      </scroll-view>
      <text v-else class="station-empty">暂无可选站点，请先在后台站点管理中添加并启用站点，然后同步。</text>
      <button v-if="correction" type="button" role="button" tabindex="0" class="station-reset" :disabled="busy" @click="save('')">恢复自动识别站点</button>
      <text class="station-note">只修改此记录的站点，原始短信与物流内容保留。</text>
      <text v-if="error" class="station-error" role="alert">{{ error }}</text>
      <view v-if="savedCorrectionId" class="station-result"><text role="status">本次站点修正已保存，优化进度单独记录。</text><button role="button" tabindex="0" @click="viewCorrection">查看本次优化进度</button></view>
    </view>
  </uni-popup>
</template>

<script>
import { mutate } from '@/services/assistant.js';
import { stationDisplayName } from '@/services/station-presentation.js';

export default {
  props: { rules: { type: Array, default: () => [] }, recent: { type: Array, default: () => [] } },
  emits: ['changed', 'open-change'],
  data: () => ({ opened: false, busy: false, error: '', target: null, item: null, savedCorrectionId: '' }),
  computed: {
    correction() { return this.item?.stationCorrection || null; },
    currentStation() { return stationDisplayName(this.item, '未识别站点'); },
    choices() {
      const recent = new Map(this.recent.map(station => [station.id, station]));
      return this.rules.filter(station => station.id && station.name && station.enabled !== false)
        .map(station => ({ ...station, usage: Number(recent.get(station.id)?.usage) || 0, lastUsedAt: Number(recent.get(station.id)?.lastUsedAt) || 0 }))
        .sort((a, b) => b.usage - a.usage || b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name, 'zh-CN'));
    }
  },
  methods: {
    open(target, item, restoreTo) {
      this.target = target; this.item = item; this.error = ''; this.savedCorrectionId = ''; this.opened = true;
      this._restoreTo = restoreTo || (typeof document !== 'undefined' ? document.activeElement : null);
      this.$emit('open-change', true); this.$refs.popup.open();
      this.$nextTick(() => (this.$refs.closeButton?.$el || this.$refs.closeButton)?.focus?.());
    },
    close() { if (this.busy || !this.opened) return false; this.opened = false; this.$refs.popup.close(); this.$emit('open-change', false); this.$nextTick(() => { const trigger = typeof this._restoreTo === 'function' ? this._restoreTo() : this._restoreTo; trigger?.focus?.(); }); return true; },
    popupChanged(event) { if (!event.show && this.opened) { if (this.busy) this.$refs.popup.open(); else this.close(); } },
    async save(stationId) {
      if (this.busy || !this.target) return;
      this.busy = true; this.error = '';
      try {
        const snapshot = await mutate(stationId ? 'setStation' : 'resetStation', { ...this.target, ...(stationId ? { stationId } : {}) });
        this.$emit('changed', snapshot); this.busy = false;
        const next = this.target.pickupId ? snapshot.codes?.find(item => item.id === this.target.pickupId) : snapshot.packages?.flatMap(order => order.shipments || []).find(item => item.id === this.target.shipmentId);
        this.item = next || this.item;
        this.savedCorrectionId = next?.stationCorrection?.id || snapshot.matchingFeedback?.corrections?.[0]?.id || '';
        if (!this.savedCorrectionId) this.close();
        uni.showToast({ title: stationId ? '已更换站点' : '已恢复自动识别', icon: 'none' });
      } catch (error) { this.error = error.message || '站点修改失败，请重试'; }
      finally { this.busy = false; }
    },
    viewCorrection() { const id = this.savedCorrectionId; if (this.close()) uni.navigateTo({ url: '/pages/my/auto-settings?correctionId=' + encodeURIComponent(id) }); },
    onKey(event) {
      const target = event.target?.tagName ? event.target : (typeof document !== 'undefined' && document.activeElement) || event.target;
      if (['Escape', 'Esc'].includes(event.key)) { event.preventDefault(); if (event.type === 'keydown') this.close(); return; }
      const sheet = this.$refs.sheet?.$el || this.$refs.sheet;
      const controls = [...(sheet?.querySelectorAll?.('[tabindex="0"]:not([disabled])') || [])];
      if (event.key === 'Tab' && event.type === 'keydown') {
        const first = controls[0], last = controls[controls.length - 1];
        if (first && ((event.shiftKey && target === first) || (!event.shiftKey && target === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      }
      if (target?.tagName === 'UNI-BUTTON' && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        if (!event.repeat && event.type === (event.key === 'Enter' ? 'keydown' : 'keyup') && !target.hasAttribute('disabled')) target.click();
      }
    }
  }
};
</script>

<style scoped>
.station-sheet { background:var(--sf-sheet); width:100%; max-width:640px; max-height:90vh; max-height:90dvh; margin:0 auto; overflow-y:auto; box-sizing:border-box; padding:18px 16px calc(22px + env(safe-area-inset-bottom)); border-radius:28px 28px 0 0; color:var(--sf-text); }
.station-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:1.25rem; font-weight:700; line-height:1.5; }
.station-sheet button { margin:0; border:0; background:transparent; line-height:1.5; font-size:.875rem; min-height:44px; padding:10px; color:var(--sf-blue); }
.station-sheet button::after { border:0; }
.station-sheet button:focus-visible { outline:2px solid var(--sf-blue); outline-offset:3px; }
.station-sheet button[disabled] { opacity:.55; }
.station-current, .station-note, .station-empty, .station-error { display:block; line-height:1.65; font-size:.875rem; overflow-wrap:anywhere; }
.station-current { margin:14px 0; padding:13px; border-radius:14px; border:1px solid var(--sf-edge); background:#ffffff44; color:var(--sf-text); }
.station-note { color:var(--sf-muted); margin-top:10px; font-size:.8125rem; }
.station-empty { padding:28px 12px; color:var(--sf-muted); text-align:center; }
.station-error { color:#a93f39; margin-top:12px; }
.station-options { max-height:40vh; height:auto; margin-top:14px; border:1px solid var(--sf-edge); border-radius:17px; background:#ffffff3b; }
.station-sheet .station-option { display:flex; width:100%; min-height:54px; align-items:center; justify-content:space-between; gap:12px; padding:13px; text-align:left; border-radius:0; border-bottom:1px solid #c3cedb66; color:var(--sf-text); font-size:.9375rem; }
.station-option:last-child { border-bottom:0; }
.station-option.selected { background:#e5eefb99; color:var(--sf-blue); }
.station-option-hint { font-size:.75rem; flex:none; color:var(--sf-muted); }
.station-sheet .station-reset { width:100%; margin-top:16px; padding:12px; border:1px solid #a7bfdf; border-radius:13px; background:#ffffff44; }
.station-result { margin-top:18px; padding:14px; border:1px solid #c2dfd8; border-radius:16px; background:#e0f1eb88; color:var(--sf-teal); font-size:.875rem; line-height:1.6; }
.station-result button { width:100%; margin-top:10px; border:1px solid #b1c9c8; border-radius:11px; background:#ffffff66; color:var(--sf-teal); }
@media(forced-colors:active) { .station-option, .station-reset, .station-result button { border:1px solid ButtonText; } }
</style>
