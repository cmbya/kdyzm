<template>
  <uni-popup ref="popup" type="bottom" :is-mask-click="true" @change="handlePopupChange">
    <view class="update-sheet sf-surface">
      <view class="sheet-header">
        <text class="sheet-title">检查更新</text>
        <button class="close" aria-label="关闭更新面板" @click="close"><text aria-hidden="true">×</text></button>
      </view>

      <view class="version-row">
        <text class="version-label">当前版本</text>
        <text class="version-value">v{{ status.currentVersionName || '读取中' }}</text>
      </view>
      <view v-if="updateSource" class="version-row">
        <text class="version-label">下载来源</text>
        <text class="version-value">{{ updateSource }}</text>
      </view>

      <view v-if="status.state === 'unsupported'" class="state-block">
        <text class="state-title">{{ status.native ? '新版本暂不兼容此设备' : '网页预览不支持在线更新' }}</text>
        <text class="state-detail">{{ status.native ? (status.error || '请使用兼容的 Android 系统版本。') : '请使用 Android 安装版检查、下载和安装更新。' }}</text>
      </view>
      <view v-else-if="status.state === 'checking'" class="state-block">
        <text class="state-title">正在检查更新…</text>
        <text class="state-detail">请稍候</text>
      </view>
      <view v-else-if="status.state === 'current'" class="state-block">
        <text class="state-title">已是最新版本</text>
      </view>
      <view v-else-if="status.state === 'available' || (status.state === 'error' && status.release)" class="release-block">
        <view class="release-header">
          <text class="state-title">发现新版本 v{{ status.release.versionName }}</text>
          <text v-if="status.release.size" class="release-size">{{ formatBytes(status.release.size) }}</text>
        </view>
        <scroll-view v-if="status.release.notes" class="release-notes" scroll-y>{{ releaseNotes }}</scroll-view>
        <text v-if="status.state === 'error'" class="error-text">{{ status.error || '下载失败，请重试' }}</text>
        <button class="primary-button" :disabled="busy" @click="download">{{ status.state === 'error' ? '重试下载' : '下载更新' }}</button>
        <text v-if="status.state === 'error'" class="retry-check" @click="check">重新检查</text>
      </view>
      <view v-else-if="status.state === 'downloading'" class="state-block">
        <text class="state-title">正在下载更新</text>
        <view class="progress-track"><view class="progress-value" :style="{ width: status.progress + '%' }"></view></view>
        <view class="progress-row"><text>{{ status.progress }}%</text><text>{{ formatBytes(status.downloadedBytes) }} / {{ formatBytes(status.totalBytes) }}</text></view>
        <button class="outline-button" :disabled="busy" @click="cancelDownload">取消下载</button>
      </view>
      <view v-else-if="status.state === 'ready'" class="state-block">
        <text class="state-title">更新包已准备好</text>
        <text class="state-detail">确认安装后将打开 Android 安装流程。</text>
        <text v-if="!status.canInstall" class="permission-hint">需要允许安装未知来源应用</text>
        <text v-if="status.error" class="error-text">{{ status.error }}</text>
        <button class="primary-button" :disabled="busy || status.installing" @click="install">{{ status.installing ? '正在校验安装包…' : status.canInstall ? '安装更新' : '去允许安装' }}</button>
      </view>
      <view v-else-if="status.state === 'error'" class="state-block">
        <text class="state-title">检查更新失败</text>
        <text class="error-text">{{ status.error || '暂时无法检查更新，请重试' }}</text>
        <button class="primary-button" :disabled="busy" @click="check">重试检查</button>
      </view>
      <view v-else class="state-block">
        <text class="state-title">准备检查更新</text>
      </view>
    </view>
  </uni-popup>
</template>

<script>
import { getAppUpdateStatus, checkAppUpdate, downloadAppUpdate, cancelAppUpdate, installAppUpdate } from '@/services/assistant.js';

const EMPTY_STATUS = {
  native: false,
  currentVersionName: '',
  currentVersionCode: 0,
  state: 'idle',
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  release: null,
  source: '',
  error: '',
  canInstall: false,
  installing: false,
};

export default {
  data() {
    return {
      status: { ...EMPTY_STATUS },
      opened: false,
      busy: false,
      pollTimer: null,
      statusRequest: null,
      requestEpoch: 0,
      commandSerial: 0,
      resumeHandler: null,
    };
  },
  computed: {
    updateSource() {
      return this.status.source === 'backend' ? '已绑定后台' : this.status.source === 'github' ? 'GitHub' : '';
    },
    isDownloadState() {
      return this.status.state === 'checking' || this.status.state === 'downloading' || this.status.installing;
    },
    releaseNotes() {
      return String(this.status.release?.notes || '').slice(0, 8000);
    },
  },
  mounted() {
    this.resumeHandler = () => this.refreshStatus(true);
    if (typeof window !== 'undefined') window.addEventListener('pickcode-resume', this.resumeHandler);
  },
  unmounted() {
    this.requestEpoch++;
    this.stopPolling();
    if (typeof window !== 'undefined' && this.resumeHandler) window.removeEventListener('pickcode-resume', this.resumeHandler);
  },
  methods: {
    normalizeStatus(value) {
      return { ...EMPTY_STATUS, ...(value || {}), progress: Math.max(0, Math.min(100, Number(value?.progress) || 0)) };
    },
    applyStatus(value) {
      this.status = this.normalizeStatus(value);
      if (this.opened && this.isDownloadState) this.schedulePoll();
      else this.stopPolling();
      return this.status;
    },
    setError(error) {
      this.status = { ...this.status, state: 'error', error: error?.message || '操作失败，请重试' };
      this.stopPolling();
    },
    invalidateRequests() {
      this.requestEpoch++;
      this.stopPolling();
    },
    beginCommand() {
      this.requestEpoch++;
      this.stopPolling();
      this.busy = true;
      return { epoch: this.requestEpoch, token: ++this.commandSerial };
    },
    schedulePoll() {
      if (!this.opened || !this.isDownloadState || this.pollTimer) return;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.refreshStatus();
      }, 1000);
    },
    stopPolling() {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
    },
    async refreshStatus(preemptCommand = false) {
      if (preemptCommand && this.busy) {
        this.requestEpoch++;
        this.stopPolling();
      }
      const epoch = this.requestEpoch;
      if (this.statusRequest?.epoch === epoch) return this.statusRequest.promise;
      const request = { epoch, promise: null };
      request.promise = getAppUpdateStatus().then(status => {
        if (epoch !== this.requestEpoch) return this.status;
        return this.applyStatus(status);
      }).catch(error => {
        if (epoch === this.requestEpoch) this.setError(error);
        return this.status;
      }).finally(() => {
        if (this.statusRequest?.epoch === epoch) this.statusRequest = null;
      });
      this.statusRequest = request;
      return request.promise;
    },
    async check() {
      if (this.busy) return;
      const command = this.beginCommand();
      try {
        const status = await checkAppUpdate();
        if (command.epoch === this.requestEpoch) this.applyStatus(status);
      } catch (error) { if (command.epoch === this.requestEpoch) this.setError(error); }
      finally { if (command.token === this.commandSerial) this.busy = false; }
    },
    async startCheck() {
      const epoch = this.requestEpoch;
      await this.refreshStatus();
      if (!this.opened || epoch !== this.requestEpoch) return;
      if (this.status.state === 'downloading' || this.status.state === 'ready') return;
      if (this.status.native === false && this.status.state === 'unsupported') return;
      await this.check();
    },
    async download() {
      if (this.busy || !this.status.release) return;
      const command = this.beginCommand();
      try {
        const status = await downloadAppUpdate();
        if (command.epoch === this.requestEpoch) this.applyStatus(status);
      } catch (error) { if (command.epoch === this.requestEpoch) this.setError(error); }
      finally { if (command.token === this.commandSerial) this.busy = false; }
    },
    async cancelDownload() {
      if (this.busy) return;
      const command = this.beginCommand();
      try {
        const status = await cancelAppUpdate();
        if (command.epoch === this.requestEpoch) this.applyStatus(status);
      } catch (error) { if (command.epoch === this.requestEpoch) this.setError(error); }
      finally { if (command.token === this.commandSerial) this.busy = false; }
    },
    async install() {
      if (this.busy || this.status.installing || this.status.state !== 'ready') return;
      const command = this.beginCommand();
      try {
        const status = await installAppUpdate();
        if (command.epoch === this.requestEpoch) this.applyStatus(status);
      } catch (error) { if (command.epoch === this.requestEpoch) this.setError(error); }
      finally { if (command.token === this.commandSerial) this.busy = false; }
    },
    open() {
      if (!this.opened) this.requestEpoch++;
      this.opened = true;
      this.$refs.popup?.open?.();
      this.startCheck();
    },
    close() {
      if (this.opened) this.invalidateRequests();
      this.opened = false;
      this.$refs.popup?.close?.();
    },
    handlePopupChange(event) {
      const next = !!event?.show;
      if (!next && this.opened) this.invalidateRequests();
      this.opened = next;
    },
    formatBytes(value) {
      const bytes = Number(value) || 0;
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    },
  },
};
</script>

<style lang="scss" scoped>
.update-sheet { background: var(--sf-sheet); border-radius: 28px 28px 0 0; padding: 16px 20px calc(24px + env(safe-area-inset-bottom)); color: var(--sf-text); max-height: 86vh; max-height: 86dvh; box-sizing: border-box; overflow-y: auto; }
.sheet-header, .version-row, .release-header, .progress-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.sheet-title { font-size: 22px; line-height: 30px; font-weight: 700; }.close { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; flex: none; margin: 0 -8px 0 0; padding: 0; color: var(--sf-muted); background: transparent; border-radius: 50%; font-size: 28px; font-weight: 400; line-height: 1; }button::after { border: 0; }
.version-row { padding: 16px 0; border-bottom: 1px solid rgba(98,118,145,.15); }.version-label, .version-value { font-size: 14px; color: var(--sf-muted); }.version-value { color: var(--sf-text); text-align: right; overflow-wrap: anywhere; max-width: 66%; }.state-block, .release-block { padding-top: 22px; }.state-title { display: block; font-size: 17px; font-weight: 650; color: var(--sf-text); line-height: 1.6; }.state-detail, .release-notes, .permission-hint, .error-text { display: block; margin-top: 12px; color: var(--sf-muted); font-size: 14px; line-height: 1.75; }.release-size, .progress-row { color: var(--sf-muted); font-size: 13px; }.release-size { flex: none; }.release-notes { max-height: 34vh; max-height: 34dvh; box-sizing: border-box; white-space: pre-wrap; overflow-wrap: anywhere; }.error-text { color: #aa343b; }.permission-hint { color: #885500; }
.progress-track { height: 7px; margin-top: 22px; background: #d6dfec; border-radius: 7px; overflow: hidden; }.progress-value { height: 100%; background: var(--sf-blue); border-radius: 7px; transition: width .2s ease; }.progress-row { margin-top: 10px; }.primary-button, .outline-button { width: 100%; min-height: 48px; height: auto; padding: 11px 14px; line-height: 1.6; margin-top: 22px; border-radius: 14px; font-size: 16px; }.primary-button { color: #fff; background: var(--sf-blue); }.outline-button { color: var(--sf-blue); background: rgba(255,255,255,.3); border: 1px solid rgba(8,103,255,.3); }.update-sheet button[disabled] { opacity: .5; }.retry-check { display: flex; min-height: 44px; align-items: center; justify-content: center; margin-top: 12px; text-align: center; color: var(--sf-blue); font-size: 14px; }
</style>
