<template>
  <view class="my-container sf-page">
    <view class="header"><text class="page-title">我的</text></view>
    <view class="stats-card sf-surface">
      <view class="stat-item"><text class="stat-label">累计识别</text><text class="stat-value">{{ hydrated ? stats.total : '—' }}</text></view>
      <view class="stat-item"><text class="stat-label">累计取走</text><text class="stat-value">{{ hydrated ? stats.picked : '—' }}</text></view>
      <text class="local-badge">本机记录</text>
    </view>
    <view class="content-wrapper">
      <view class="menu-group"><text class="group-title">连接与运行</text><view class="menu-list sf-surface"><button class="menu-item" @click="navigateTo('/pages/my/online-accounts')"><view class="menu-left"><uni-icons type="cloud-upload" size="20" color="#0867ff" /><text class="menu-text">线上账号</text></view><view class="menu-right"><text class="online-status">{{ !hydrated ? '读取中…' : online.bound ? (online.accounts?.length || 0)+' 个账号' : '未绑定' }}</text><uni-icons type="right" size="16" color="#536073" /></view></button><button class="menu-item" @click="navigateTo('/pages/my/auto-settings?section=scan')"><view class="menu-left"><uni-icons type="scan" size="20" color="#0867ff" /><text class="menu-text">扫描与权限</text></view><view class="menu-right"><uni-icons type="right" size="16" color="#536073" /></view></button><button class="menu-item" @click="navigateTo('/pages/my/auto-settings?section=widgets')"><view class="menu-left"><uni-icons type="list" size="20" color="#0867ff" /><text class="menu-text">桌面卡片</text></view><view class="menu-right"><uni-icons type="right" size="16" color="#536073" /></view></button></view></view>
      <view class="menu-group"><text class="group-title">识别与优化</text><view class="menu-list sf-surface"><button class="menu-item" @click="navigateTo('/pages/my/auto-settings?section=optimization')"><view class="menu-left"><uni-icons type="loop" size="20" color="#0867ff" /><text class="menu-text">识别优化</text></view><view class="menu-right"><uni-icons type="right" size="16" color="#536073" /></view></button><button class="menu-item" @click="navigateTo('/pages/my/match-rules')"><view class="menu-left"><uni-icons type="settings" size="20" color="#0867ff" /><text class="menu-text">短信识别规则</text></view><view class="menu-right"><uni-icons type="right" size="16" color="#536073" /></view></button><button class="menu-item" @click="navigateTo('/pages/my/logistics-rules')"><view class="menu-left"><uni-icons type="location" size="20" color="#0867ff" /><text class="menu-text">物流识别规则</text></view><view class="menu-right"><uni-icons type="right" size="16" color="#536073" /></view></button><button class="menu-item" @click="navigateTo('/pages/my/ignored')"><view class="menu-left"><uni-icons type="eye-slash" size="20" color="#0867ff" /><text class="menu-text">已忽略短信</text></view><view class="menu-right"><uni-icons type="right" size="16" color="#536073" /></view></button></view></view>
      <view class="menu-group"><text class="group-title">帮助与应用</text><view class="menu-list sf-surface"><button class="menu-item" @click="navigateTo('/pages/my/faq')"><view class="menu-left"><uni-icons type="help" size="20" color="#0867ff" /><text class="menu-text">常见问题</text></view><view class="menu-right"><uni-icons type="right" size="16" color="#536073" /></view></button><button class="menu-item" @click="navigateTo('/pages/my/about')"><view class="menu-left"><uni-icons type="info" size="20" color="#0867ff" /><text class="menu-text">关于应用</text></view><view class="menu-right"><uni-icons type="right" size="16" color="#536073" /></view></button><button class="menu-item" @click="openAppUpdate"><view class="menu-left"><uni-icons type="loop" size="20" color="#0867ff" /><text class="menu-text">检查更新</text></view><view class="menu-right"><text class="online-status">v{{ currentVersionName }}</text><uni-icons type="right" size="16" color="#536073" /></view></button></view></view>
    </view>
    <AppUpdate ref="appUpdate" />
  </view>
</template>

<script>
import packageInfo from '../../package.json' with { type: 'json' };
import AppUpdate from '@/components/AppUpdate.vue';
import { getSnapshot, getAppUpdateStatus } from '@/services/assistant.js';

export default {
  components: { AppUpdate },
  data() {
    return {
      hydrated: false, online: {}, stats: {
        total: 0,
        picked: 0
      },
      currentVersionName: packageInfo.version,
    };
  },
  onLoad() {
    uni.$on('assistant-changed', this.loadStats);
  },
  onShow() {
    this.loadStats();
    this.loadCurrentVersion();
  },
  onUnload() {
    uni.$off('assistant-changed', this.loadStats);
  },
  methods: {
    navigateTo(url) {
      uni.navigateTo({
        url,
      });
    },
    openAppUpdate() {
      this.$refs.appUpdate?.open();
    },
    async loadCurrentVersion() {
      try {
        const status = await getAppUpdateStatus();
        if (status.currentVersionName) this.currentVersionName = status.currentVersionName;
      } catch (_) {
        // The footer keeps the bundled version when native status is unavailable.
      }
    },
    async loadStats() {
      try {
        const snapshot = await getSnapshot();
        this.hydrated = true;
        this.online=snapshot.online || {};
        this.stats.total = snapshot.codes.reduce((n,item)=>n+(item.totalCount||1),0);
        this.stats.picked = snapshot.codes.reduce((n,item)=>n+(item.totalCount||1)-(item.pendingCount ?? (item.isPicked?0:1)),0);
      } catch (e) {
        uni.showToast({ title: '统计加载失败，请重新打开页面', icon: 'none' });
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.my-container { padding: 20px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.header { padding: 12px 0 24px; }
.page-title { font-size: clamp(28px, 7.7vw, 30px); line-height: 1.2; font-weight: 750; letter-spacing: -.6px; }
.stats-card { border-radius: 24px; display: flex; align-items: center; padding: 20px; gap: 24px; }
.stat-item { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.stat-label { color: var(--sf-muted); font-size: 13px; line-height: 19px; }
.stat-value { color: var(--sf-text); font-size: 30px; line-height: 36px; font-weight: 700; letter-spacing: -.5px; }
.local-badge { flex: none; align-self: flex-start; border-radius: 8px; padding: 4px 8px; background: rgba(224,232,242,.6); color: var(--sf-muted); font-size: 12px; }
.menu-group { margin-top: 24px; }
.group-title { display: block; padding: 0 4px 10px; color: var(--sf-muted); font-size: 13px; line-height: 20px; font-weight: 600; }
.menu-list { border-radius: 24px; overflow: hidden; }
.menu-item { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 58px; margin: 0; padding: 12px 16px; border: 0; border-radius: 0; border-bottom: 1px solid rgba(98,118,145,.13); background: transparent; text-align: left; line-height: 1.5; }
.menu-item:last-child { border-bottom: 0; }
.menu-item::after { border: 0; }
.menu-item:active { background: rgba(255,255,255,.35); }
.menu-left, .menu-right { display: flex; align-items: center; gap: 12px; min-width: 0; }
.menu-left { flex: 1; }.menu-right { flex: none; gap: 6px; margin-left: 8px; }
.menu-text { color: var(--sf-text); font-size: 16px; }
.online-status { color: var(--sf-muted); font-size: 13px; }
@media (min-width: 430px) { .my-container { padding-inline: 20px; } }
</style>
