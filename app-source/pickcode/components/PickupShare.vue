<template>
  <uni-popup ref="popup" type="bottom" :safe-area="false" :animation="!reducedMotion" mask-background-color="rgba(10,34,70,.28)" @change="popupChanged">
    <view v-if="opened" ref="sheet" class="share-sheet sf-surface" role="dialog" aria-modal="true" aria-labelledby="pickup-share-title" @click.stop>
      <view class="share-handle" aria-hidden="true"></view>
      <view class="share-heading"><text id="pickup-share-title" role="heading" aria-level="2">{{ image ? '取件长图' : '分享取件码' }}</text><button ref="closeButton" role="button" tabindex="0" aria-label="关闭分享取件码" @click="close"><uni-icons type="closeempty" size="23" /></button></view>
      <template v-if="!image">
        <view class="share-selection"><button role="checkbox" tabindex="0" :aria-checked="allSelected ? 'true' : selected.length ? 'mixed' : 'false'" :disabled="!rows.length || busy" @click="toggleAll"><text class="share-check" :class="{ checked: allSelected }" aria-hidden="true">{{ allSelected ? '✓' : selected.length ? '−' : '' }}</text>全选</button><text aria-live="polite">已选 {{ selected.length }} 件</text></view>
        <view class="share-list">
          <text v-if="!rows.length" class="share-empty" role="status">暂无可分享的已到货待取包裹</text>
          <view v-for="group in groups" :key="group.station" class="share-group">
            <view class="share-station"><uni-icons type="location" size="19" color="#0867ff" /><text>{{ group.station }}</text><text class="share-station-count">{{ group.count }} 件</text></view>
            <button v-for="row in group.rows" :key="row.key" class="share-row" role="checkbox" tabindex="0" :aria-checked="selected.includes(row.key)" :aria-label="[row.station,row.cabinet,row.code,row.carrier,row.title].filter(Boolean).join('，')" :disabled="busy" @click="toggle(row.key)">
              <text class="share-check" :class="{ checked: selected.includes(row.key) }" aria-hidden="true">{{ selected.includes(row.key) ? '✓' : '' }}</text>
              <view class="share-row-content"><text class="share-code">{{ row.code }}</text><text class="share-meta">{{ [row.carrier, row.title, row.count + '件'].filter(Boolean).join(' · ') }}</text></view>
              <text v-if="row.cabinet" class="share-cabinet">{{ row.cabinet }}</text>
            </button>
          </view>
        </view>
      </template>
      <view v-else class="share-preview"><image class="share-preview-image" :src="image.dataUrl" mode="widthFix" :style="{ aspectRatio: image.width + '/' + image.height }" alt="所选包裹的取件清单长图" /><text class="share-preview-summary">{{ selected.length }} 件 · {{ selectedGroups.length }} 个站点</text></view>
      <text v-if="error" class="share-error" role="alert">{{ error }}</text>
      <text v-if="notice" class="share-notice" role="status">{{ notice }}</text>
      <text v-if="rows.length > limit && !image && !error" class="share-limit">一次最多生成 {{ limit }} 件，请分批选择</text>
      <view v-if="!image" class="share-footer"><button class="share-secondary" role="button" tabindex="0" @click="close">取消</button><button class="share-primary" role="button" tabindex="0" :disabled="!selected.length || busy" :aria-busy="busy" @click="generate">{{ busy ? '正在生成…' : '生成长图' }}</button></view>
      <view v-else class="share-footer share-output-actions"><button class="share-secondary" role="button" tabindex="0" :disabled="busy" @click="backToSelection">重选</button><button class="share-secondary" role="button" tabindex="0" :disabled="busy" @click="save">保存图片</button><button class="share-primary" role="button" tabindex="0" :disabled="busy" @click="share">{{ busy ? '处理中…' : '系统分享' }}</button></view>
    </view>
  </uni-popup>
</template>

<script>
import { pickupShareRows, groupShareRows, renderPickupShare, saveInBrowser, shareInBrowser, MAX_SHARE_ITEMS } from '@/services/pickupShare.js';
import { exportPickupImage } from '@/services/assistant.js';
const historyKey = '__pickcodeShareSheet';
export default {
  props: { snapshot: { type: Object, required: true } }, emits: ['open-change'],
  data: () => ({ opened: false, selected: [], image: null, busy: false, error: '', notice: '', limit: MAX_SHARE_ITEMS,
    reducedMotion: typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches }),
  computed: {
    rows() { return pickupShareRows(this.snapshot); }, groups() { return groupShareRows(this.rows); },
    selectedRows() { return this.rows.filter(row => this.selected.includes(row.key)); },
    selectedGroups() { return groupShareRows(this.selectedRows); },
    allSelected() { return this.rows.length > 0 && this.rows.length === this.selected.length; }
  },
  watch: { rows(next, previous) {
    if (!this.opened || JSON.stringify(next) === JSON.stringify(previous)) return;
    this.selected = this.selected.filter(key => next.some(row => row.key === key));
    if (this.image || this.busy) this.error = '取件信息已更新，请重新生成长图';
    this.image = null; this.busy = false; this._generation = (this._generation || 0) + 1;
  } },
  mounted() { if (typeof window !== 'undefined') { window.addEventListener('popstate', this.onPopState); window.addEventListener('keydown', this.onKey, true); window.addEventListener('keyup', this.onKey, true); } },
  beforeUnmount() { this.close(false); if (typeof window !== 'undefined') { window.removeEventListener('popstate', this.onPopState); window.removeEventListener('keydown', this.onKey, true); window.removeEventListener('keyup', this.onKey, true); } },
  methods: {
    open(restoreTo) {
      if (this.opened || this._closing) return;
      this._restoreTo = restoreTo || document.activeElement; this.selected = this.rows.map(row => row.key); this.image = null; this.error = ''; this.notice = ''; this.busy = false;
      this.opened = true; this.$emit('open-change', true); uni.hideKeyboard?.();
      const tabbar = typeof document !== 'undefined' && document.querySelector('uni-tabbar');
      if (tabbar) { this._tabbar = { element: tabbar, inert: tabbar.inert }; tabbar.inert = true; }
      if (typeof window !== 'undefined' && window.history?.pushState) { this._history = { id: Date.now() + ':' + Math.random(), url: window.location.href }; window.history.pushState({ ...window.history.state, [historyKey]: this._history.id }, '', this._history.url); }
      this.$refs.popup.open(); this.$nextTick(() => (this.$refs.closeButton?.$el || this.$refs.closeButton)?.focus?.());
    },
    close(restoreFocus = true) {
      if (!this.opened) return false;
      this.opened = false; this._generation = (this._generation || 0) + 1; this.image = null; this.busy = false; this.$refs.popup?.close(); this.$emit('open-change', false);
      if (this._tabbar) { this._tabbar.element.inert = this._tabbar.inert; this._tabbar = null; }
      const marker = this._history; this._history = null;
      if (marker && window.location.href === marker.url && window.history.state?.[historyKey] === marker.id) { const state = { ...window.history.state }; delete state[historyKey]; window.history.replaceState(state, '', marker.url); this._closing = true; window.history.back(); setTimeout(() => { this._closing = false; }, 350); }
      if (restoreFocus) this.$nextTick(() => (this._restoreTo?.$el || this._restoreTo)?.focus?.());
      return true;
    },
    onPopState() { if (this._history && window.history.state?.[historyKey] !== this._history.id) { this._history = null; this.close(); } },
    popupChanged(event) { if (!event.show && this.opened) this.close(); },
    toggle(key) { this.selected = this.selected.includes(key) ? this.selected.filter(value => value !== key) : [...this.selected, key]; this.error = ''; this.notice = ''; },
    toggleAll() { this.selected = this.allSelected ? [] : this.rows.map(row => row.key); this.error = ''; this.notice = ''; },
    backToSelection() { this.image = null; this.error = ''; this.notice = ''; },
    async generate() {
      if (this.busy) return; this.busy = true; this.error = ''; this.notice = '';
      const generation = this._generation = (this._generation || 0) + 1;
      try { const image = await renderPickupShare(this.selectedRows); if (this.opened && generation === this._generation) this.image = image; }
      catch (error) { if (this.opened && generation === this._generation) this.error = error.message || '生成失败，请重试'; }
      finally { if (this.opened && generation === this._generation) this.busy = false; }
    },
    async output(mode) {
      if (this.busy || !this.image) return; this.busy = true; this.error = ''; this.notice = '';
      const generation = this._generation = (this._generation || 0) + 1;
      try {
        if (typeof window !== 'undefined' && window.PickCodeNative) {
          const result = await exportPickupImage(mode, this.image.dataUrl);
          if (this.opened && generation === this._generation) this.notice = result.cancelled ? '已取消保存' : mode === 'save' ? '图片已保存' : '已打开系统分享';
        } else if (mode === 'save') { saveInBrowser(this.image); if (this.opened && generation === this._generation) this.notice = '已开始下载取件长图'; }
        else { await shareInBrowser(this.image); if (this.opened && generation === this._generation) this.notice = '已打开系统分享'; }
      } catch (error) { if (this.opened && generation === this._generation && error.name !== 'AbortError') this.error = error.message || '图片操作失败，请重试'; }
      finally { if (this.opened && generation === this._generation) this.busy = false; }
    },
    save() { return this.output('save'); }, share() { return this.output('share'); },
    onKey(event) {
      if (!this.opened) return;
      const target = event.target?.tagName ? event.target : document.activeElement;
      if (['Escape', 'Tab', 'Enter', ' '].includes(event.key)) event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); if (event.type === 'keydown') this.close(); return; }
      const sheet = this.$refs.sheet?.$el || this.$refs.sheet;
      const controls = [...(sheet?.querySelectorAll?.('[tabindex="0"]:not([disabled])') || [])];
      if (event.key === 'Tab' && event.type === 'keydown') { const first = controls[0], last = controls.at(-1); if (first && (event.shiftKey && target === first || !event.shiftKey && target === last || !sheet.contains(target))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); } }
      if (target?.tagName === 'UNI-BUTTON' && ['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!event.repeat && event.type === (event.key === 'Enter' ? 'keydown' : 'keyup') && !target.hasAttribute('disabled')) target.click(); }
    }
  }
};
</script>

<style scoped>
.share-sheet{box-sizing:border-box;width:100%;max-width:640px;max-height:91vh;max-height:91dvh;display:flex;flex-direction:column;margin:0 auto;padding:10px 16px calc(12px + env(safe-area-inset-bottom));border-radius:28px 28px 0 0;background:var(--sf-sheet);color:var(--sf-text);overflow:hidden}
.share-handle{width:38px;height:4px;border-radius:4px;background:#a5b3c7;margin:0 auto 13px;flex:none}
.share-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:1.3rem;font-weight:750;flex:none}
.share-sheet button{margin:0;line-height:1.4;min-height:44px;padding:9px;border:0;background:transparent;color:inherit;font-size:1rem}
.share-sheet button::after{border:0}.share-sheet button:focus-visible{outline:2px solid var(--sf-blue);outline-offset:-2px}.share-sheet button[disabled]{opacity:.5}
.share-heading button{width:44px;height:44px;border:1px solid var(--sf-edge);border-radius:50%;background:#ffffff44;color:var(--sf-muted)}
.share-selection{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #c4d3e5;padding:10px 0;margin-bottom:8px;color:var(--sf-muted);flex:none}
.share-selection button{display:flex;align-items:center;gap:10px;color:var(--sf-text);font-weight:600;padding-left:2px}
.share-check{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;box-sizing:border-box;flex:none;border:1.5px solid #8ca9ce;border-radius:6px;color:#0867ff;font-weight:700;font-size:17px;background:#ffffff55}
.share-check.checked{border-color:#0867ff;background:#0867ff;color:white}.share-list{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 1px 8px}
.share-station{display:flex;align-items:center;gap:6px;margin:17px 0 9px;font-weight:700;font-size:.95rem;line-height:1.45;overflow-wrap:anywhere}.share-station>text:nth-child(2){flex:1;min-width:0}.share-station-count{font-size:.85rem;color:var(--sf-muted);font-weight:400;flex:none}
.share-sheet .share-row{display:flex;align-items:center;gap:12px;width:100%;margin-top:8px;padding:12px 10px;text-align:left;border-radius:15px;border:1px solid var(--sf-edge);background:#ffffff66;box-shadow:0 3px 10px #5575990a}
.share-row-content{flex:1;min-width:0}.share-code{display:block;font-size:clamp(1.2rem,5.8vw,1.65rem);line-height:1.2;letter-spacing:-.03em;font-weight:750;overflow-wrap:anywhere}.share-meta{display:block;margin-top:5px;font-size:.78rem;color:var(--sf-muted);overflow-wrap:anywhere;line-height:1.45}
.share-cabinet{flex:none;max-width:25%;padding:4px 7px;border-radius:8px;background:#d9f0e8;color:#087d6c;font-size:.8rem;font-weight:700;overflow-wrap:anywhere}
.share-empty{display:block;text-align:center;padding:45px 8px;color:var(--sf-muted);font-size:.95rem}.share-footer{display:flex;gap:10px;border-top:1px solid #d1dfec;padding-top:12px;margin-top:8px;flex:none}.share-footer button{border-radius:14px;padding:13px 10px;font-weight:650;min-width:0}.share-footer .share-secondary{flex:1;border:1px solid #b5cce8;color:var(--sf-muted);background:#ffffff33}.share-footer .share-primary{flex:2;color:white;background:#0867ff}.share-output-actions button{font-size:.875rem}.share-output-actions .share-primary{flex:1.4}
.share-error,.share-notice,.share-limit{display:block;flex:none;font-size:.82rem;line-height:1.5;margin-top:9px;overflow-wrap:anywhere}.share-error{color:#a33432}.share-notice{color:#087d6c}.share-limit{color:var(--sf-muted)}.share-preview{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-top:16px}.share-preview-image{display:block;width:100%;height:auto;border-radius:14px;border:1px solid var(--sf-edge);box-sizing:border-box}.share-preview-summary{display:block;text-align:center;font-size:.8rem;color:var(--sf-muted);margin:10px 0}
@media(forced-colors:active){.share-check,.share-sheet .share-row,.share-cabinet,.share-footer button{border:1px solid ButtonText}.share-check.checked{background:Highlight;color:HighlightText}}
</style>
