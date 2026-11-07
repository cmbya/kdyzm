<template>
  <view class="about-container sf-page">
    <view class="about-content sf-surface">
      <text class="title">快递取件助手</text><text class="version">私人版 · v{{ appVersion }}</text>
      <text class="desc">集中查看取件码与包裹，支持本机短信识别、家庭账号同步和桌面卡片。</text>
      <view class="privacy-copy"><text class="subtitle">数据与隐私</text><text class="desc">日常短信识别在本机完成。AI 模板建议只发送合成模板片段，原短信与真实取件码留在本机；建议核对保存后才生效。</text><text class="desc">可选站点优化仅提交脱敏站名片段或人工修正关系。后台账号通过授权连接，本地历史独立保留。</text></view>
      <button class="local-btn" @click="openChangelog">更新记录<uni-icons type="right" size="16" color="#536073" /></button>
    </view>
    <view class="license-card sf-surface"><button class="license-toggle" :aria-expanded="licenseExpanded" @click="licenseExpanded = !licenseExpanded"><text>许可与免责声明</text><uni-icons :type="licenseExpanded ? 'up' : 'down'" size="16" color="#536073" /></button><text v-if="licenseExpanded" class="license-text">{{ licenseText }}</text></view>
  </view>
</template>

<script>
import licenseText from '../../LICENSE?raw';
import packageInfo from '../../package.json' with { type: 'json' };

export default {
  data() { return { licenseText, licenseExpanded: false, appVersion: packageInfo.version }; },
  methods: {
    openChangelog() { uni.navigateTo({ url: '/pages/my/changelog' }); }
  }
}
</script>

<style lang="scss" scoped>
.about-container { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.about-content, .license-card { border-radius: 24px; padding: 20px; margin-bottom: 14px; }
.title { display: block; color: var(--sf-text); font-size: 24px; font-weight: 700; line-height: 32px; }
.version { display: block; margin-top: 4px; color: var(--sf-muted); font-size: 13px; line-height: 20px; }
.desc { display: block; margin-top: 14px; color: var(--sf-muted); font-size: 15px; line-height: 1.75; }
.privacy-copy { margin-top: 24px; padding-top: 18px; border-top: 1px solid rgba(98,118,145,.15); }
.subtitle { color: var(--sf-text); font-size: 16px; font-weight: 650; }
.local-btn, .license-toggle { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; min-height: 48px; height: auto; margin: 14px 0 0; padding: 10px 0; background: transparent; color: var(--sf-blue); font-size: 15px; line-height: 1.5; text-align: left; }
.license-toggle { margin: 0; color: var(--sf-text); font-weight: 600; }.license-card { padding-block: 10px; }
button::after { border: 0; }.license-text { display: block; margin: 12px 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--sf-muted); font-size: 13px; line-height: 1.8; }
</style>
