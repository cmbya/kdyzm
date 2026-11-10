<template>
  <view class="faq-container sf-page">
    <view v-for="(item,index) in questions" :key="item.title" class="faq-item sf-surface">
      <button class="question" :aria-expanded="expanded === index" @click="expanded = expanded === index ? -1 : index"><text>{{ item.title }}</text><uni-icons :type="expanded === index ? 'up' : 'down'" size="16" color="#536073" /></button>
      <view v-if="expanded === index" class="answer"><text>{{ item.answer }}</text><view class="faq-btn-row"><button v-for="link in item.links" :key="link.label" class="mini-btn" @click="openHelp(link.target)">{{ link.label }}</button></view></view>
    </view>
  </view>
</template>

<script>
import { openSystemSettings } from '@/services/assistant.js';

export default {
  data() { return { expanded: 0, questions: [
    { title: '为什么没有识别到取件码？', answer: '先确认短信权限与本机规则。某些手机需要额外允许“通知类短信”。没有取件码的到站或催取短信只会显示提醒；浏览器预览不能读取短信。', links: [{ label: '扫描与权限', target: 'scan' }, { label: '短信识别规则', target: 'rules' }] },
    { title: '后台扫描为什么没有准点执行？', answer: '系统约每小时安排扫描，休眠、省电或强制停止可能延迟。可查看最近实际扫描时间，也可立即扫描。', links: [{ label: '扫描与权限', target: 'scan' }] },
    { title: '短信会上传吗？', answer: '日常识别在本机完成，原短信、短信中的真实取件码和运单号不会随识别问题上传。绑定后，会向你自己的后台同步候选包裹 ID、承运商、时间、问题原因与状态，以及规则回执。开启站点优化后才附带脱敏站点片段；AI 模板建议使用合成片段，其他 AI 输入也会另行脱敏。应用不会修改或删除短信，读取权限可随时在系统设置中关闭。', links: [{ label: '优化设置', target: 'optimization' }, { label: '系统权限', target: 'permission' }] },
    { title: '识别错了怎么办？', answer: '可以修改取件记录或忽略来源短信。人工修正和已取状态不会被后续扫描覆盖；已忽略短信可恢复，并按当前规则重新识别。', links: [{ label: '已忽略短信', target: 'ignored' }] },
    { title: '快递公司或地址没有识别完整？', answer: '在规则编辑页检查字段的起始与结束文字，并用完整短信核对样例结果。不同格式可以保存不同规则。', links: [{ label: '短信识别规则', target: 'rules' }] },
    { title: '线上账号失效会丢记录吗？', answer: '本地历史继续可用。平台账号登录在后台更新；设备授权失效则需要重新核验绑定。', links: [{ label: '线上账号', target: 'accounts' }] }
  ] }; },
  methods: {
    openHelp(target) {
      if (target === 'permission') return this.openPermissionSetting();
      const routes = { scan: '/pages/my/auto-settings?section=scan', optimization: '/pages/my/auto-settings?section=optimization', rules: '/pages/my/match-rules', ignored: '/pages/my/ignored', accounts: '/pages/my/online-accounts' };
      if (routes[target]) uni.navigateTo({ url: routes[target] });
    },
    async openPermissionSetting() {
      try { await openSystemSettings('app'); }
      catch (error) { uni.showToast({ title: error.message || '请在 Android 应用中设置权限', icon: 'none' }); }
    },
    openScanSettings() { uni.navigateTo({ url: '/pages/my/auto-settings' }); }
  }
}
</script>

<style lang="scss" scoped>
.faq-container { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.faq-item { border-radius: 22px; margin-bottom: 12px; padding: 0 16px; }
.question { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 64px; height: auto; margin: 0; padding: 14px 0; background: transparent; text-align: left; color: var(--sf-text); font-size: 16px; line-height: 1.6; font-weight: 600; }
.question text { flex: 1; min-width: 0; }.question::after, .mini-btn::after { border: 0; }
.answer { padding: 0 0 14px; color: var(--sf-muted); font-size: 15px; line-height: 1.75; }
.faq-btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.mini-btn { display: flex; align-items: center; justify-content: center; flex: 1 1 120px; min-width: 0; min-height: 48px; height: auto; margin: 0; padding: 10px 12px; border: 1px solid rgba(8,103,255,.25); border-radius: 14px; background: rgba(255,255,255,.35); color: var(--sf-blue); font-size: 14px; line-height: 1.5; }
</style>
