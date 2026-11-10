<template>
  <view class="auto-settings sf-page" @click="closeWidgetStations(false)">
    <view class="section-nav sf-surface"><button @click.stop="jumpToSection('scan')">扫描与权限</button><button @click.stop="jumpToSection('optimization')">识别优化</button><button @click.stop="jumpToSection('widgets')">桌面卡片</button></view>
    <view v-if="error" class="notice error" @click="loadSettings">{{ error }} · 点击重试</view>
    <view v-if="!runtime.native" class="notice">浏览器仅供预览。短信权限、后台扫描和桌面卡片请在 Android 应用中使用。</view>
    <view class="notice" @click="openOnline">{{ online.bound ? '线上同步已接入' : '线上账号未绑定' }}{{ online.error ? ' · '+online.error : '' }} · 管理</view>
    <view id="settings-completion" class="section completion-section sf-surface">
      <text class="section-title">取件自动监测</text>
      <view class="row"><text>领取语句监测</text><text class="detail" :class="{ allowed: completionEnabled }">{{ completionSupported ? (completionEnabled ? '已开启' : '后台未开启') : '后台不支持' }}</text></view>
      <view class="row"><text>AI监测词调优</text><text class="detail" :class="{ allowed: completionAiEnabled }">{{ completionAiStatus }}</text></view>
      <text class="hint">支持多种明确领取语句自动监测，AI 可追加和优化监测词组。仅本人或收件人明确领取才会自动完成；代收、门口放置和泛签收不计入。可在对应包裹撤销，或恢复自动判断。</text>
      <view v-if="recentCompletionResults.length" class="completion-results">
        <text class="field-label">最近完成</text>
        <view v-for="result in visibleCompletionResults" :key="result.orderId + ':' + result.shipmentId" class="completion-result"><view class="completion-result-copy"><text class="completion-result-title">{{ result.title }}</text><text class="completion-result-detail">{{ result.time }} · {{ result.evidence }}</text></view><button class="completion-result-action" @click.stop="openCompletionRecord(result)">查看包裹</button></view>
      </view>
      <text v-else-if="completionSupported" class="hint">暂无自动完成记录</text>

      <button class="outline full" :disabled="!completionSupported || !completionRecordAvailable" :aria-expanded="showAllCompletionResults" @click="showAllCompletionResults = !showAllCompletionResults">{{ showAllCompletionResults ? '收起自动取件记录' : '查看自动取件记录' }}</button>
    </view>
    <view id="settings-scan" class="section sf-surface">
      <text class="section-title">短信定时识别</text>
      <view class="row"><text>启用定时识别</text><switch :key="'auto-' + switchRevision" :checked="runtime.autoScan" :disabled="busy || loading || !runtime.native" color="#0867ff" @change="toggleAutoScan" /></view>
      <view class="row"><text>扫描频率</text><text class="detail">约每 1 小时</text></view>
      <view class="row"><text>最近实际扫描</text><text class="detail">{{ scanTime }}</text></view>
      <text class="hint">由系统安排扫描时间，休眠、省电或强制停止可能延迟扫描。</text>
    </view>
    <view class="section sf-surface">
      <text class="section-title">权限与后台运行</text>
      <view class="row"><text>短信权限</text><text class="detail" :class="{ allowed: runtime.smsPermission }">{{ runtime.smsPermission ? '已允许' : '未允许' }}</text></view>
      <view class="row"><text>后台运行</text><text class="detail">{{ !runtime.native ? '仅 Android 支持' : runtime.batteryRestricted ? '受省电限制' : '未受省电限制' }}</text></view>
      <text class="hint">允许后台运行有助于及时扫描，执行时间仍由系统安排。</text>
      <view class="button-row">
        <button class="outline" :disabled="busy || !runtime.native" @click="permissionAction">{{ runtime.smsPermission ? '应用权限设置' : '允许读取短信' }}</button>
        <button class="outline" :disabled="busy || !runtime.native" @click="openBatterySettings">后台运行设置</button>
      </view>
      <button class="outline full" :disabled="busy || !runtime.native" :loading="scanning" @click="scanNow">{{ scanning ? '正在扫描' : '立即扫描' }}</button>
      <text v-if="scanNotice" class="hint scan-result">{{ scanNotice }}</text>
    </view>
    <view id="settings-optimization" class="section sf-surface">
      <text class="section-title">识别优化</text>
      <view class="row"><text>提交未识别站名</text><switch :key="'station-' + switchRevision" :checked="stationEnhancement" :disabled="busy || loading || !stationSupported" color="#0867ff" @change="toggleStationEnhancement" /></view>
      <text class="hint">仅发送脱敏的站名片段给已绑定后台及其 AI 渠道，人工核对后加入识别规则。</text>
      <text v-if="!stationSupported" class="hint">{{ online.bound ? '请先升级后台并同步，以使用站点管理。' : '绑定支持站点管理的后台后可开启。' }}</text>
      <text v-else class="hint">{{ stationStatus.lastError || (stationStatus.pendingCount ? stationStatus.pendingCount + ' 条待上传，下次同步时提交' : stationStatus.lastUploadAt ? '最近提交：' + new Date(stationStatus.lastUploadAt).toLocaleString('zh-CN', {hour12:false}) : '尚未提交片段') }}</text>
      <view class="row"><text>人工修正优化</text><switch :key="'learning-' + switchRevision" :checked="manualLearning" :disabled="busy || loading" color="#0867ff" @change="toggleManualLearning" /></view>
      <text class="hint">手动匹配与更换站点后，自动保存脱敏样本并定时提交后台优化；关闭后停止采集和提交新样本，撤回操作仍会同步。原始短信不上传。</text>
      <text class="hint" role="status">{{ matchingFeedbackStatus }}</text>
      <text v-if="online.ruleReceipt" class="hint">手机已保存站点规则版本 {{ online.ruleReceipt.stationRulesVersion }}，后台已确认导入回执。识别效果仍需后续样本验证。</text>
      <view v-if="feedbackCounts.length" class="feedback-counts"><text v-for="entry in feedbackCounts" :key="entry.key">{{ entry.label }} {{ entry.count }}</text></view>
      <view v-if="matchingFeedback.items?.length" class="feedback-results"><view v-for="entry in matchingFeedback.items.slice(0, showAllFeedback ? matchingFeedback.items.length : 5)" :key="entry.id + ':' + entry.revision" class="feedback-result"><text>{{ entry.label || '人工修正样本' }}</text><text>{{ feedbackStatusLabel(entry.status, entry.reasonCode) }}</text><text v-if="entry.message || entry.error" class="feedback-error">{{ entry.message || entry.error }}</text><text v-if="entry.ruleVersion">规则版本 {{ entry.ruleVersion }} · 效果待验证</text><text v-if="entry.lastAttemptAt">提交尝试 {{ entry.attempts }} 次 · {{ feedbackTime(entry.lastAttemptAt) }}</text></view></view>
      <button v-if="matchingFeedback.items?.length > 5" role="button" tabindex="0" :aria-expanded="showAllFeedback" class="outline" @click="showAllFeedback = !showAllFeedback" @keydown="feedbackKey" @keyup="feedbackKey">{{ showAllFeedback ? '收起提交记录' : '查看全部提交记录' }}</button>
      <text class="hint">本地纠错记录</text>
      <view v-for="event in visibleCorrections" :key="event.id" :id="'correction-' + event.id" tabindex="-1" class="feedback-result" :class="{ focused: event.id === correctionId }"><text>{{ event.kind === 'manual_match' ? '人工匹配已保存' : event.kind === 'station_reset' ? '已恢复自动站点' : '站点修正已保存' }} · {{ feedbackTime(event.changedAt) }}</text><text>{{ event.originalStation || '未识别站点' }} → {{ event.stationName }}</text><text v-if="!event.items.length">{{ correctionSubmission(event) }}</text><text v-else>{{ event.items.map(item => feedbackStatusLabel(item.status, item.reasonCode)).join('、') }}</text></view>
      <button v-if="matchingFeedback.corrections?.length > 5" role="button" tabindex="0" :aria-expanded="showAllCorrections" class="outline" @click="showAllCorrections = !showAllCorrections" @keydown="feedbackKey" @keyup="feedbackKey">{{ showAllCorrections ? '收起纠错记录' : '查看全部纠错记录' }}</button>
    </view>
    <view id="settings-widgets" class="section sf-surface">
      <text class="section-title">桌面卡片</text>
      <view class="row"><text>显示取件码</text><switch :key="'privacy-' + switchRevision" :checked="!widgetPrivacy" :disabled="busy || loading || !runtime.native" color="#0867ff" @change="togglePrivacy" /></view>
      <text class="hint">卡片只显示未取件。关闭显示后，取件码、公司和地址一起隐藏。</text>
      <view class="preview-label"><text>2 × 2</text><text class="detail">紧凑卡片</text></view>
      <view class="widget widget-small">
        <view class="widget-heading"><text>取件列表</text><text class="detail">{{ pendingTotal }} 待取</text></view>
        <text class="widget-date">{{ today }}</text>
        <view v-if="pendingCodes.length" class="widget-item">
          <view class="code-row" :class="{ 'long-code': displayCode(pendingCodes[0]).length > 8 }"><text v-if="!widgetPrivacy && pickupCabinet(pendingCodes[0])" class="cabinet-badge">{{ pickupCabinet(pendingCodes[0]) }}</text><text class="code">{{ displayCode(pendingCodes[0]) }}</text><text v-if="!widgetPrivacy" class="company">{{ pendingCodes[0].company || '快递' }}</text><text class="picked-label">{{ pendingCodes[0].pendingCount > 1 || pendingCodes[0].needsPickupAssignment ? '查看' : '取件' }}</text></view>
          <text class="address">{{ widgetPrivacy ? '隐私模式 · 打开查看' : previewStation(pendingCodes[0]) }}</text>
        </view>
        <text v-else class="empty">暂无待取件</text>
        <text v-if="pendingCodes.length > 1" class="widget-more">还有 {{ pendingCodes.length - 1 }} 个取件码</text>
        <view class="widget-footer"><text>{{ shortScanTime }}</text><text class="refresh-label">刷新</text></view>
      </view>
      <view class="preview-label"><text>4 × 2</text><text class="detail">列表卡片</text></view>
      <view class="widget widget-list">
        <view class="widget-heading"><text>取件列表</text><text class="detail">{{ today }} · {{ pendingTotal }} 待取</text></view>
        <view class="widget-item" v-for="item in pendingCodes.slice(0, 2)" :key="item.id">
          <view class="code-row" :class="{ 'long-code': displayCode(item).length > 8 }"><text v-if="!widgetPrivacy && pickupCabinet(item)" class="cabinet-badge">{{ pickupCabinet(item) }}</text><text class="code">{{ displayCode(item) }}</text><text v-if="!widgetPrivacy" class="company">{{ item.company || '快递' }}</text><text class="picked-label">{{ item.pendingCount > 1 || item.needsPickupAssignment ? '查看' : '取件' }}</text></view>
          <text class="address">{{ widgetPrivacy ? '隐私模式 · 打开查看' : previewStation(item) }}</text>
        </view>
        <text v-if="!pendingCodes.length" class="empty">暂无待取件</text>
        <view class="widget-footer"><text>{{ shortScanTime }}<template v-if="pendingCodes.length > 2"> · 还有 {{ pendingCodes.length - 2 }} 件</template></text><text class="refresh-label">刷新</text></view>
      </view>
      <view class="preview-label"><text>5 × 3</text><text class="detail">大号卡片</text></view>
      <view class="widget widget-large">
        <view class="widget-large-pickup">
          <view class="widget-heading"><text>{{ largeReceiptTotal ? '待取与收货' : '待取快递' }} <text class="widget-pickup-count">{{ largePendingTotal }}</text></text><button ref="widgetStationButton" type="button" role="button" tabindex="0" class="widget-station-value" :aria-expanded="widgetStationsOpen" aria-controls="widget-station-list" :aria-label="'大卡片站点筛选，' + widgetStationOptions[widgetStationIndex].label" @click.stop="toggleWidgetStations" @keydown.stop="widgetStationKeydown" @keyup.stop="widgetStationKeydown">{{ widgetStationOptions[widgetStationIndex].label }}<text>⌄</text></button></view>
          <view v-if="widgetStationsOpen" id="widget-station-list" ref="widgetStationList" class="widget-station-list" role="group" aria-label="选择站点" @click.stop @keydown.stop="widgetStationKeydown" @keyup.stop="widgetStationKeydown"><button v-for="option in widgetStationOptions" :key="option.key" type="button" role="button" tabindex="0" :aria-pressed="widgetStation === option.key" :class="{ selected: widgetStation === option.key }" @click.stop="selectWidgetStation(option.key)">{{ option.label }}</button></view>
          <scroll-view scroll-y class="widget-pickup-scroll" :scroll-top="widgetPickupScrollTop" tabindex="0" aria-label="全部待取记录，可上下滚动">
          <view v-if="singleLargeCode" class="widget-single-row">
            <view class="widget-single-line" :class="{ 'long-code': displayCode(singleLargeCode).length > 8 }"><text v-if="!widgetPrivacy && pickupCabinet(singleLargeCode)" class="cabinet-badge">{{ pickupCabinet(singleLargeCode) }}</text><text class="code">{{ displayCode(singleLargeCode) }}</text><text v-if="!widgetPrivacy" class="widget-single-owner">{{ familyLabel(singleLargeCode) }}</text></view>
            <view class="widget-single-bottom"><view class="widget-single-text"><text class="address">{{ widgetPrivacy ? '隐私模式 · 打开查看' : stationDisplayName(singleLargeCode, '未填写取件地址') }}</text></view><text v-if="pickupTitle(singleLargeCode)" class="widget-pickup-title">{{ pickupTitle(singleLargeCode) }}</text><text class="picked-label">{{ singleLargeCode.totalCount > 1 || singleLargeCode.needsPickupAssignment ? '取件 ›' : '取件 ✓' }}</text></view>
          </view>
          <template v-else>
          <view class="widget-large-row" v-for="row in pendingLargeRows" :key="row.kind + '-' + row.item.id">
            <template v-if="row.kind === 'code'">
              <view class="widget-large-code"><view class="pickup-line" :class="{ 'long-code': displayCode(row.item).length > 8 }"><text v-if="!widgetPrivacy && pickupCabinet(row.item)" class="cabinet-badge">{{ pickupCabinet(row.item) }}</text><text class="code">{{ displayCode(row.item) }}</text></view><text class="address">{{ widgetPrivacy ? '隐私模式 · 打开查看' : stationDisplayName(row.item, '未填写取件地址') }}</text></view>
              <view v-if="!widgetPrivacy" class="widget-large-owner"><text>{{ familyLabel(row.item) }}</text><text v-if="pickupTitle(row.item)" class="widget-pickup-title">{{ pickupTitle(row.item) }}</text><text v-if="pendingCount(row.item) > 1" class="widget-large-quantity">共码 · {{ pendingCount(row.item) }} 件</text></view>
              <text class="picked-label">{{ row.item.totalCount > 1 || row.item.pendingCount > 1 || row.item.needsPickupAssignment ? '取件 ›' : '取件 ✓' }}</text>
            </template>
            <template v-else>
              <view class="widget-large-code"><text class="widget-delivered-status">已送达 · 待确认</text><text class="widget-delivered-title">{{ roadTitle(row.item) }}</text></view>
              <text v-if="!widgetPrivacy" class="widget-large-owner">{{ familyLabel(row.item) }}<text class="widget-large-quantity">{{ roadPlatform(row.item) }}</text></text>
              <text class="picked-label widget-receipt-action" :class="{ disabled: !row.item.canPick }">确认收到</text>
            </template>
          </view>
          </template>
          <text v-if="!pendingLargeRows.length" class="empty">{{ widgetStation ? '本站已取完' : '暂无待取件' }}</text>
          </scroll-view>
          <view class="widget-pickup-footer"><text>{{ largePendingTotal }} 件待取<template v-if="largeReceiptTotal"> · {{ largeReceiptTotal }} 件待确认</template></text><text v-if="pendingLargeRows.length > 2">上下滚动查看全部</text></view>
        </view>
        <view class="widget-road">
          <view class="widget-road-content">
          <view class="widget-road-heading"><view class="widget-road-label"><text>代收包裹</text><text class="widget-road-count">{{ roadTotal }}</text><text class="detail">单</text></view><view class="widget-platform-filters" role="group" aria-label="代收包裹平台筛选"><button v-for="platform in roadPlatformOptions" :key="platform.key" class="widget-platform-filter" role="button" tabindex="0" :class="{ selected: widgetPlatform === platform.key }" :data-platform="platform.key" :aria-pressed="widgetPlatform === platform.key" @click="toggleWidgetPlatform(platform.key)" @keydown="onWidgetButtonKey($event, () => toggleWidgetPlatform(platform.key))" @keyup="onWidgetButtonKey($event, () => toggleWidgetPlatform(platform.key))"><text class="widget-platform-mark" :class="platform.key" aria-hidden="true">{{ platform.mark }}</text><text>{{ platform.name }}</text><text class="widget-platform-count">{{ widgetPrivacy ? '••' : platform.count }}</text></button></view></view>
          <swiper v-if="roadPackages.length > 2" :key="widgetPlatform + ':' + roadPackages.map(item => item.id).join('|')" class="widget-road-carousel" vertical circular :autoplay="roadPreviewActive" :current="roadPreviewPage" :interval="5200" :duration="0" :disable-touch="true" :aria-label="'代收包裹共' + roadPackages.length + '单，自动整页展示'" @change="roadPreviewChanged">
            <swiper-item v-for="(page, pageIndex) in roadPreviewPages" :key="'road-page-' + pageIndex"><view v-for="item in page" :key="item.id" class="widget-road-row"><text v-if="roadStatus(item) !== '待发货'" class="widget-road-status">{{ roadStatus(item) }}</text><text v-if="roadPlatform(item)" class="widget-road-platform">{{ roadPlatform(item) }}</text><text class="widget-road-title">{{ roadTitle(item) }}</text><text v-if="!widgetPrivacy" class="widget-road-owner">{{ familyLabel(item) }}</text></view></swiper-item>
          </swiper>
          <template v-else><view v-for="item in roadPackages" :key="item.id" class="widget-road-row"><text v-if="roadStatus(item) !== '待发货'" class="widget-road-status">{{ roadStatus(item) }}</text><text v-if="roadPlatform(item)" class="widget-road-platform">{{ roadPlatform(item) }}</text><text class="widget-road-title">{{ roadTitle(item) }}</text><text v-if="!widgetPrivacy" class="widget-road-owner">{{ familyLabel(item) }}</text></view></template>
          <text v-if="!roadPackages.length" class="widget-road-empty">{{ widgetPlatform ? '这个平台暂无代收包裹' : '暂无代收包裹' }}</text>
          </view>
          <view class="widget-road-footer"><view class="widget-road-refresh"><text>↻</text><text>{{ runtime.lastScanAt ? clockTime(new Date(runtime.lastScanAt)) : '刷新' }}</text></view></view>
        </view>
      </view>
      <text class="hint">在桌面点码可复制，单件点“取件”标记已取，共码多件进入详情选择。已送达无取件码的包裹可点“确认收到”，七秒内可撤销；隐私模式下详情隐藏。预览使用当前未取记录，实际显示条数随桌面卡片大小调整。</text>
      <radio-group class="size-choice" @change="widgetSize = $event.detail.value">
        <label><radio value="small" :checked="widgetSize === 'small'" color="#0867ff" />紧凑卡片</label>
        <label><radio value="list" :checked="widgetSize === 'list'" color="#0867ff" />列表卡片</label>
        <label><radio value="large" :checked="widgetSize === 'large'" color="#0867ff" />大号卡片</label>
      </radio-group>
      <button class="primary full" :disabled="busy || !runtime.native || !runtime.widgetSupported" @click="addWidget">添加到桌面</button>
      <text v-if="runtime.native && !runtime.widgetSupported" class="hint">当前桌面不支持直接添加，请在桌面的小组件列表中选择“取件列表”。</text>
    </view>
  </view>
</template>

<script>
import { getSnapshot, getRuntimeStatus, mutate, scanSms, requestSmsPermission, openSystemSettings, pinWidget } from '@/services/assistant.js';
import { shouldArchivePackage } from '@/core/package-presentation.js';
import { stationDisplayName, pickupCabinet } from '@/services/station-presentation.js';

export default {
  data() {
    return {
      runtime: { native: false, smsPermission: false, autoScan: false, lastScanAt: 0, batteryRestricted: false, widgetSupported: false },
      online: {}, codes: [], packages: [], widgetPrivacy: false, stationEnhancement: false, stationStatus: {}, manualLearning: true, matchingFeedback: {}, sectionId: '', correctionId: '', showAllFeedback: false, showAllCorrections: false, showAllCompletionResults: false, widgetSize: 'small', loading: true, busy: false, scanning: false, switchRevision: 0, error: '', scanNotice: '', roadPreviewActive: false, roadPreviewPage: 0, widgetStation: '', widgetPlatform: '', widgetStationsOpen: false, widgetPickupScrollTop: 0
    };
  },
  computed: {
    visibleCorrections() { const items = this.matchingFeedback.corrections || []; return this.showAllCorrections ? items : items.slice(0, 5); },
    stationSupported() { return this.online.bound && this.online.capabilities?.includes('station_aliases_v1'); },
    matchingFeedbackStatus() {
      if (!this.manualLearning) return '已关闭，停止采集和提交新样本，撤回操作仍会同步。';
      if (this.matchingFeedback.lastError) return this.matchingFeedback.lastError;
      if (this.matchingFeedback.waitingReason) return this.matchingFeedback.waitingReason;
      if (!this.online.bound) return '尚未绑定后台，样本保留在本机，绑定后可提交。';
      if (!this.online.capabilities?.includes('matching_feedback_v1')) return '当前后台尚不支持人工修正优化，请升级后台并同步。';
      if (this.matchingFeedback.pendingCount) return '样本已保存，等待定时提交。';
      if (this.matchingFeedback.submittedCount) return '已提交后台，等待处理结果。';
      return this.matchingFeedback.items?.length ? '最近处理结果如下。' : '暂无人工修正样本。';
    },
    feedbackCounts() { return [{ key: 'pendingCount', label: '待提交' }, { key: 'submittedCount', label: '已提交' }, { key: 'appliedCount', label: '规则已应用' }, { key: 'reviewCount', label: '待核对' }, { key: 'failedCount', label: '失败' }].map(entry => ({ ...entry, count: Number(this.matchingFeedback[entry.key]) || 0 })).filter(entry => entry.count); },
    completionSupported() { return this.online.bound && this.online.capabilities?.includes('pickup_completion_v1'); },
    completionEnabled() { return this.completionSupported && this.online.pickupCompletion?.enabled !== false; },
    completionAiEnabled() { return this.completionSupported && this.online.pickupCompletion?.aiEnabled === true; },
    completionAiStatus() { if (!this.completionSupported) return '后台不支持'; const state = this.online.pickupCompletion?.aiState; const message = this.online.pickupCompletion?.message; if (state && message) return state + ' · ' + message; return state || message || (this.completionAiEnabled ? '监测词调优已开启（需后台AI服务可用）' : '监测词调优未开启'); },
    completionRecordAvailable() { return this.recentCompletionResults.some(item => item.orderId && item.shipmentId); },
    visibleCompletionResults() { return this.showAllCompletionResults ? this.recentCompletionResults : this.recentCompletionResults.slice(0, 3); },
    recentCompletionResults() {
      if (!this.online?.bound) return [];
      return (this.packages || []).filter(order => order?.source === 'online' && !order.hidden).flatMap(order => (order.shipments || []).filter(shipment => {
        const completion = shipment?.pickupCompletion;
        return !shipment.hidden && shipment.canPick === true && completion?.version === 1 && completion.autoPicked === true && !completion.manualOverride && Number(completion.completedAt) > 0;
      }).map(shipment => ({ orderId: order.id, shipmentId: shipment.id, title: order.title || shipment.waybillNo || '包裹', time: this.completionTime(shipment.pickupCompletion.completedAt), evidence: shipment.pickupCompletion.evidence?.description || shipment.pickupCompletion.evidence?.kind || '明确领取证据', completedAt: Number(shipment.pickupCompletion.completedAt) }))).sort((a, b) => b.completedAt - a.completedAt);
    },
    roadPreviewPages() {
      if (this.roadPackages.length <= 2) return [];
      return this.roadPackages.map((item, index) => [item, this.roadPackages[(index + 1) % this.roadPackages.length]]);
    },
    pendingCodes() { return this.codes.filter(item => !item.isPicked).sort((a, b) => b.date - a.date); },
    pendingTotal() {return this.pendingCodes.reduce((n,item)=>n+(item.pendingCount ?? 1),0);},
    receiptShipments() {
      return this.packages.filter(item => item && item.id && !item.hidden && !item.deleted && !item.archived && !item.picked && !item.isPicked && item.status !== 'picked' && !shouldArchivePackage(item))
        .flatMap(item => (item.shipments || []).filter(ship => ship && ship.id && ship.needsReceiptConfirmation && ship.status === 'signed' && !ship.hidden && !ship.deleted && !ship.archived && !ship.picked && !ship.isPicked)
          .map(ship => ({ ...ship, orderId: item.id, title: item.title, familyId: ship.familyId || item.familyId, familyName: ship.familyName || item.familyName, platform: item.platform })));
    },
    receiptTotal() { return this.receiptShipments.length; },
    widgetStationOptions() {
      const stations = [...new Set(this.pendingCodes.map(item => this.widgetStationKey(item)))];
      return [{ key: '', label: '全部站点 · ' + this.pendingTotal }, ...stations.map((key, index) => ({ key, label: (this.widgetPrivacy ? '站点 ' + (index + 1) : key) + ' · ' + this.pendingCodes.filter(item => this.widgetStationKey(item) === key).reduce((count, item) => count + this.pendingCount(item), 0) }))];
    },
    widgetStationIndex() { return Math.max(0, this.widgetStationOptions.findIndex(option => option.key === this.widgetStation)); },
    largePendingCodes() { return this.pendingCodes.filter(item => !this.widgetStation || this.widgetStationKey(item) === this.widgetStation); },
    largePendingTotal() { return this.largePendingCodes.reduce((count, item) => count + this.pendingCount(item), 0); },
    largeReceiptShipments() { return this.widgetStation ? [] : this.receiptShipments; },
    largeReceiptTotal() { return this.largeReceiptShipments.length; },
    pendingLargeAllRows() {
      const rows = [];
      for (let index = 0; index < Math.max(this.largePendingCodes.length, this.largeReceiptShipments.length); index++) {
        if (this.largePendingCodes[index]) rows.push({ kind: 'code', item: this.largePendingCodes[index] });
        if (this.largeReceiptShipments[index]) rows.push({ kind: 'receipt', item: this.largeReceiptShipments[index] });
      }
      return rows;
    },
    pendingLargeRows() { return this.pendingLargeAllRows; },
    pendingLargeCodes() { return this.pendingLargeRows.filter(row => row.kind === 'code').map(row => row.item); },
    singleLargeCode() { return this.largePendingTotal === 1 && this.largePendingCodes.length === 1 && !this.largeReceiptTotal ? this.largePendingCodes[0] : null; },
    pendingLargeRemaining() { return Math.max(0, this.largePendingTotal - this.pendingLargeCodes.reduce((n, item) => n + this.pendingCount(item), 0)); },
    pendingLargeReceiptRemaining() { return Math.max(0, this.largeReceiptTotal - this.pendingLargeRows.filter(row => row.kind === 'receipt').length); },
    transitRoadPackages() { return [...new Map(this.packages.filter(item => this.isRoadPackage(item)).map(item => [item.id, item])).values()]; },
    roadTotal() { return this.transitRoadPackages.length; },
    roadPackages() { return this.transitRoadPackages.filter(item => !this.widgetPlatform || item.platform === this.widgetPlatform); },
    roadPlatformOptions() { return [{ key: 'taobao', name: '淘宝', mark: '淘' }, { key: 'jd', name: '京东', mark: '京' }, { key: 'pdd', name: '拼多多', mark: '拼' }].map(platform => ({ ...platform, count: this.transitRoadPackages.filter(item => item.platform === platform.key).length })); },
    today() { const date = new Date(); return (date.getMonth() + 1) + '月' + date.getDate() + '日'; },
    scanTime() {
      if (!this.runtime.lastScanAt) return '尚未扫描';
      const date = new Date(this.runtime.lastScanAt);
      return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + this.clockTime(date);
    },
    shortScanTime() { return this.runtime.lastScanAt ? this.clockTime(new Date(this.runtime.lastScanAt)) + ' 更新' : '尚未扫描'; }
  },
  watch: {
    pendingCodes() { if (this.widgetStation && !this.pendingCodes.some(item => this.widgetStationKey(item) === this.widgetStation)) this.selectWidgetStation(''); }
  },
  onLoad(query = {}) { this.sectionId = ['scan', 'optimization', 'widgets'].includes(query.section) ? query.section : ''; this.correctionId = query.correctionId || ''; this.showAllCorrections = !!this.correctionId; uni.$on('assistant-changed', this.loadSettings); },
  onReady() { if (!this.correctionId && this.sectionId) this.jumpToSection(this.sectionId); },
  onShow() { this.roadPreviewActive = true; this.roadPreviewPage = 0; this.loadSettings(); },
  onHide() { this.roadPreviewActive = false; this.closeWidgetStations(false); },
  onUnload() { this.roadPreviewActive = false; uni.$off('assistant-changed', this.loadSettings); },
  methods: {
    jumpToSection(section) {
      if (!['scan', 'optimization', 'widgets'].includes(section)) return;
      this.$nextTick(() => uni.pageScrollTo?.({ selector: '#settings-' + section, duration: 0 }));
    },
    stationDisplayName, pickupCabinet,
    previewStation(item) { return (item.pendingCount > 1 ? '共码 · 待取 ' + item.pendingCount + ' 件 · ' : '') + stationDisplayName(item, '未填写取件地址'); },
    openOnline(){uni.navigateTo({url:'/pages/my/online-accounts'});},
    clockTime(date) { return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0'); },
    displayCode(item) { return this.widgetPrivacy ? '••••••' : item.code; },
    pendingCount(item) { return Math.max(0, Number(item.pendingCount ?? (item.isPicked ? 0 : 1))); },
    widgetStationKey(item) { return stationDisplayName(item, '站点待补充'); },
    selectWidgetStation(key) { this.widgetStation = this.widgetStationOptions.some(option => option.key === key) ? key : ''; this.widgetPickupScrollTop = 1; this.$nextTick(() => { this.widgetPickupScrollTop = 0; }); this.closeWidgetStations(); },
    closeWidgetStations(restoreFocus = true) { if (!this.widgetStationsOpen) return; this.widgetStationsOpen = false; if (restoreFocus) this.$nextTick(() => (this.$refs.widgetStationButton?.$el || this.$refs.widgetStationButton)?.focus?.()); },
    toggleWidgetStations() { if (this.widgetStationsOpen) { this.closeWidgetStations(); return; } this.widgetStationsOpen = true; this.$nextTick(() => { const root = this.$refs.widgetStationList?.$el || this.$refs.widgetStationList; root?.querySelector?.('[aria-pressed="true"]')?.focus?.(); }); },
    widgetStationKeydown(event) {
      const target = event.target?.tagName ? event.target : (typeof document !== 'undefined' && document.activeElement) || event.target;
      if (['Escape', 'Esc'].includes(event.key)) { event.preventDefault(); if (event.type === 'keydown') this.closeWidgetStations(); return; }
      if (event.key === 'Tab') { if (event.type === 'keydown') this.closeWidgetStations(); return; }
      if (event.type === 'keydown' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); if (!this.widgetStationsOpen) { this.toggleWidgetStations(); return; }
        const root = this.$refs.widgetStationList?.$el || this.$refs.widgetStationList, controls = [...(root?.querySelectorAll?.('[tabindex="0"]') || [])];
        const index = controls.indexOf(target), next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus?.(); return;
      }
      this.onWidgetButtonKey(event, () => target.click());
    },
    roadPreviewChanged(event) { this.roadPreviewPage = Number(event.detail?.current ?? event.detail?.currentItemId ?? 0) || 0; },
    completionTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false }); },
    openCompletionRecord(result) {
      const target = this.recentCompletionResults.find(item => item.orderId === result?.orderId && item.shipmentId === result?.shipmentId);
      if (!target) {
        uni.showToast?.({ title: '暂无自动完成记录', icon: 'none' });
        return;
      }
      uni.setStorageSync('pickcode.pickup-completion', JSON.stringify({ orderId: target.orderId, shipmentId: target.shipmentId, showHistory: true }));
      uni.switchTab({ url: '/pages/packages/index' });
    },
    toggleWidgetPlatform(platform) { this.widgetPlatform = this.widgetPlatform === platform ? '' : platform; this.roadPreviewPage = 0; },
    onWidgetButtonKey(event, activate) {
      const target = event.target?.tagName ? event.target : (typeof document !== 'undefined' && document.activeElement) || event.target;
      if (target?.tagName !== 'UNI-BUTTON' || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      if (!event.repeat && event.type === (event.key === 'Enter' ? 'keydown' : 'keyup')) activate();
    },
    pickupTitle(item) {
      if (this.widgetPrivacy) return '';
      const memberTitle = (item.members || []).filter(member => !member.picked)
        .map(member => [member.shortName, member.title].find(value => typeof value === 'string' && value.trim())?.trim())
        .find(value => value && value !== '待取包裹');
      const title = [item.shortName, memberTitle, item.productName, item.parcelName, item.name, item.title].find(value => typeof value === 'string' && value.trim());
      return Array.from((title || '').trim()).slice(0, 6).join('');
    },
    familyLabel(item) {
      if (this.widgetPrivacy) return '隐私模式';
      const members = Array.isArray(item.members) ? item.members.filter(member => !member.picked) : [];
      const names = members.map(member => member.familyName || (member.familyId ? '家人' : '待归属')).filter(Boolean);
      if (!names.length && (item.familyName || item.familyId)) names.push(item.familyName || '家人');
      return [...new Set(names)].join('、') || '待归属';
    },
    roadPlatform(item) {
      if (this.widgetPrivacy) return '';
      switch (item.platform) {
        case 'taobao': return '淘';
        case 'pdd': return '拼';
        case 'jd': return '京';
        default: return '';
      }
    },
    roadTitle(item) {
      if (this.widgetPrivacy) return '包裹信息已隐藏';
      return Array.from(String(item.title || '').trim() || '线上包裹').slice(0, 10).join('');
    },
    isRoadPackage(item) {
      if (!item || !item.id || item.source !== 'online' || !this.isActiveRoadOrder(item)) return false;
      return ['运输中', '待发货'].includes(this.roadStatus(item));
    },
    roadStatus(item) {
      if (!this.isActiveRoadOrder(item)) return '';
      const all = Array.isArray(item.shipments) ? item.shipments : [];
      const shipments = all.filter(shipment => shipment && !shipment.hidden && !shipment.deleted && !shipment.archived && !shipment.picked && !shipment.isPicked && !shipment.needsReceiptConfirmation && shipment.status !== 'signed' && shipment.status !== 'picked' && !String(shipment.displayPickupCode || '').trim() && !String(shipment.pickupCode || '').trim());
      if (shipments.some(shipment => shipment.status === 'transit')) return '运输中';
      if (all.length && !shipments.length) return '';
      const unknown = shipments.filter(shipment => (!shipment.status || shipment.status === 'unknown') && !(shipment.arrivalAt > 0) && !(shipment.smsArrivalAt > 0));
      const status = [item.tradeStatus, item.orderStatus].filter(Boolean).join(' ');
      const warehouse = /进入.{0,20}仓库|仓库处理中|准备出库|等待出库|正在出库|(?:等待|待)[^，,。；;]{0,12}揽收|正在打包|打包完成|打印完成/;
      const waiting = /WAIT_SELLER_SEND_GOODS|待发货|等待卖家发货|卖家待发货|等待出库|正在出库/i.test(status)
        || item.platform === 'jd' && (warehouse.test(status)
          || unknown.some(shipment => Array.isArray(shipment.logisticsEvents) && shipment.logisticsEvents.some(event => warehouse.test(event?.description || ''))));
      if (!waiting && (!all.length || unknown.length) && (item.status === 'transit' || item.platform !== 'jd' && /WAIT_BUYER_CONFIRM_GOODS|待收货|等待收货|等待买家收货/i.test(status))) return '运输中';
      if (waiting && unknown.length) return '待发货';
      if (shipments.some(shipment => shipment.status === 'arrived' || shipment.status === 'awaiting_code' || shipment.status === 'pending' || shipment.arrivalAt > 0 || shipment.smsArrivalAt > 0)) return '待取码';
      if (waiting) return '待发货';
      if (item.status === 'awaiting_code') return '待取码';
      return '';
    },
    isActiveRoadOrder(item) {
      return !item.hidden && !item.deleted && !item.archived && !item.picked && !item.isPicked && item.status !== 'picked' && !shouldArchivePackage(item)
        && !/cancel|close|failed|failure|交易关闭|已关闭|已取消|已撤销|交易取消|REFUNDED|REFUND_(?:SUCCESS|COMPLETED|FINISHED)|退款(?:成功|完成)|已退款/i.test([item.tradeStatus, item.orderStatus, item.refundStatus].filter(Boolean).join(' '));
    },
    async loadSettings() {
      this.loading = true;
      this.error = '';
      try {
        const [snapshot, runtime] = await Promise.all([getSnapshot(), getRuntimeStatus()]);
        this.codes = snapshot.codes;
        this.packages = snapshot.packages || [];
        this.online = snapshot.online || {};
        this.widgetPrivacy = snapshot.settings.widgetPrivacy;
        this.stationEnhancement = snapshot.settings.stationEnhancement === true;
        this.stationStatus = snapshot.stationEnhancement || {};
        this.manualLearning = snapshot.settings.manualLearning !== false;
        this.matchingFeedback = snapshot.matchingFeedback || {};
        this.locateCorrection();
        this.runtime = runtime;
        this.switchRevision++;
      } catch (error) { this.error = error.message || '设置加载失败'; }
      finally { this.loading = false; }
    },
    locateCorrection() {
      if (this.correctionLocated || !/^[a-zA-Z0-9_-]+$/.test(this.correctionId) || !this.visibleCorrections.some(event => event.id === this.correctionId)) return;
      this.correctionLocated = true;
      this.$nextTick(() => {
        const id = 'correction-' + this.correctionId;
        uni.pageScrollTo?.({ selector: '#' + id, duration: 0 });
        if (typeof document !== 'undefined') document.getElementById(id)?.focus?.({ preventScroll: true });
      });
    },
    feedbackStatusLabel(status, reason) { if (reason === 'NO_NEW_RULE') return '已有规则覆盖，无需新增'; return ({ queued: '待提交', submitted: '后台已接收', pending: '后台已接收', applied: '规则已应用', review: '需确认优化建议', failed: '失败，可重试', withdrawn: '已撤回', superseded: '已被后续修正替代' })[status] || '待处理'; },
    feedbackTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : ''; },
    correctionSubmission(event) { return event.submission === 'learning_paused' ? '本次未提交优化：人工学习已暂停' : event.submission === 'not_bound' ? '本次未提交优化：操作时未绑定后台' : event.kind === 'station_reset' ? '已撤销本次人工覆盖，相关样本会同步撤回' : '当前修正已保存，暂未生成可提交样本'; },
    feedbackKey(event) { if (event.target?.tagName !== 'UNI-BUTTON' || !['Enter', ' '].includes(event.key)) return; event.preventDefault(); if (!event.repeat && event.type === (event.key === 'Enter' ? 'keydown' : 'keyup')) event.target.click(); },
    async toggleManualLearning(event) {
      if (this.busy || this.loading) return;
      this.busy = true;
      try { await mutate('settings', { manualLearning: !!event.detail.value }); }
      catch (error) { uni.showToast({ title: error.message || '设置失败', icon: 'none' }); }
      finally { await this.loadSettings(); this.busy = false; }
    },
    async toggleStationEnhancement(event) {
      if (this.busy || !this.stationSupported) return;
      this.busy = true;
      try {
        const enabled = event.detail.value;
        if (enabled) {
          const confirmed = await new Promise(resolve => uni.showModal({ title: '开启站点片段增强？', content: '未识别的取件站名会脱敏后提交给当前绑定后台，由其配置的 AI 服务整理。姓名、电话、单号、取件码及短信正文不上传；建议须在后台人工核对后才生效。', confirmText: '开启', success: result => resolve(!!result.confirm), fail: () => resolve(false) }));
          if (!confirmed) return;
        }
        await mutate('settings', { stationEnhancement: enabled });
      } catch (error) { uni.showToast({ title: error.message || '设置失败', icon: 'none' }); }
      finally { await this.loadSettings(); this.busy = false; }
    },
    async toggleAutoScan(event) {
      if (this.busy || !this.runtime.native) return;
      this.busy = true;
      try {
        const enabled = event.detail.value;
        if (enabled && !this.runtime.smsPermission) this.runtime = await requestSmsPermission();
        if (enabled && !this.runtime.smsPermission) throw new Error('未获得短信权限，定时识别尚未开启');
        await mutate('settings', { autoScan: enabled });
        await this.loadSettings();
      } catch (error) {
        await this.loadSettings();
        uni.showToast({ title: error.message || '设置失败', icon: 'none' });
      } finally { this.busy = false; }
    },
    async togglePrivacy(event) {
      if (this.busy || !this.runtime.native) return;
      this.busy = true;
      try {
        const snapshot = await mutate('settings', { widgetPrivacy: !event.detail.value });
        this.widgetPrivacy = snapshot.settings.widgetPrivacy;
      } catch (error) { await this.loadSettings(); uni.showToast({ title: error.message || '设置失败', icon: 'none' }); }
      finally { this.busy = false; }
    },
    async permissionAction() {
      if (this.busy || !this.runtime.native) return;
      this.busy = true;
      try {
        if (this.runtime.smsPermission) await openSystemSettings('app');
        else {
          this.runtime = await requestSmsPermission();
          if (!this.runtime.smsPermission) uni.showModal({ title: '短信权限未开启', content: '可在应用权限设置中允许读取短信，再进行扫描。', confirmText: '打开设置', success: async result => {
            if (result.confirm) { try { await openSystemSettings('app'); } catch (error) { uni.showToast({ title: error.message || '无法打开设置', icon: 'none' }); } }
          } });
        }
      } catch (error) { uni.showToast({ title: error.message || '权限操作失败', icon: 'none' }); }
      finally { this.busy = false; }
    },
    async openBatterySettings() {
      try { await openSystemSettings('battery'); }
      catch (error) { uni.showToast({ title: error.message || '无法打开系统设置', icon: 'none' }); }
    },
    async scanNow() {
      if (this.busy || !this.runtime.native) return;
      this.busy = true;
      this.scanning = true;
      this.scanNotice = '';
      try {
        if (!this.runtime.smsPermission) this.runtime = await requestSmsPermission();
        if (!this.runtime.smsPermission) throw new Error('请先允许读取短信');
        const snapshot = await scanSms();
        this.codes = snapshot.codes;
        this.scanNotice = '本次新增 ' + snapshot.summary.added + ' 个取件码，' + snapshot.summary.reminders + ' 条提醒。';
        await this.loadSettings();
      } catch (error) { this.scanNotice = error.message || '扫描失败，请重试'; }
      finally { this.scanning = false; this.busy = false; }
    },
    async addWidget() {
      if (this.busy || !this.runtime.native || !this.runtime.widgetSupported) return;
      this.busy = true;
      try {
        await pinWidget(this.widgetSize);
        uni.showToast({ title: '请在系统提示中确认添加', icon: 'none' });
      } catch (error) { uni.showToast({ title: error.message || '无法添加桌面卡片', icon: 'none' }); }
      finally { this.busy = false; }
    }
  }
};
</script>

<style lang="scss" scoped>
.auto-settings { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.section-nav { display: flex; gap: 4px; padding: 4px; margin-bottom: 16px; border-radius: 18px; }.section-nav button { flex: 1; min-width: 0; margin: 0; padding: 8px 2px; color: var(--sf-blue); background: transparent; font-size: 13px; }
.section { border-radius: 24px; padding: 18px; margin-bottom: 14px; scroll-margin-top: 16px; }
.section-title { display: block; color: var(--sf-text); font-size: 18px; font-weight: 650; margin-bottom: 8px; line-height: 1.5; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 54px; border-bottom: 1px solid rgba(98,118,145,.13); font-size: 15px; }.row > text:first-child { flex: 1; min-width: 0; }.row switch { flex: none; }.detail { font-size: 13px; color: var(--sf-muted); text-align: right; max-width: 58%; overflow-wrap: anywhere; }.allowed, .scan-result { color: var(--sf-teal); }
.hint { display: block; font-size: 13px; line-height: 1.75; color: var(--sf-muted); margin: 12px 0; overflow-wrap: anywhere; }.field-label { display: block; margin-bottom: 8px; color: var(--sf-muted); font-size: 13px; }
.completion-results { margin: 12px 0; padding-top: 12px; border-top: 1px solid rgba(98,118,145,.13); }.completion-result { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(98,118,145,.13); }.completion-result-copy { flex: 1; min-width: 0; }.completion-result-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sf-text); font-size: 15px; }.completion-result-detail { display: block; margin-top: 4px; color: var(--sf-muted); font-size: 13px; line-height: 1.65; }.completion-result-action { flex: none; min-height: 44px; height: auto; padding: 8px; background: transparent; color: var(--sf-blue); font-size: 13px; }
.feedback-counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; color: var(--sf-muted); font-size: 13px; }.feedback-counts text { padding: 4px 8px; border-radius: 8px; background: rgba(222,231,245,.5); }.feedback-result { display: flex; flex-direction: column; gap: 6px; padding: 14px 0; border-top: 1px solid rgba(98,118,145,.13); font-size: 13px; color: var(--sf-muted); line-height: 1.65; overflow-wrap: anywhere; }.feedback-result > text:first-child { color: var(--sf-text); font-size: 14px; font-weight: 550; }.feedback-result.focused { background: rgba(222,235,254,.65); outline: 2px solid var(--sf-blue); outline-offset: 3px; border-radius: 10px; }.feedback-error { color: #aa343b; }
.notice { margin-bottom: 12px; background: rgba(222,235,254,.65); color: var(--sf-muted); padding: 12px 14px; font-size: 14px; line-height: 1.65; border-radius: 14px; }.error { background: #fff0ef; color: #aa343b; }
.button-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; button { flex: 1 1 120px; min-width: 0; } }
button { min-height: 48px; height: auto; line-height: 1.6; border-radius: 14px; font-size: 15px; padding: 10px 12px; &::after { border: 0; } &[disabled] { opacity: .5; } }.outline { background: rgba(255,255,255,.3); color: var(--sf-blue); border: 1px solid rgba(8,103,255,.3); }.primary { color: #fff; background: var(--sf-blue); }.full { width: 100%; }
.preview-label { display: flex; align-items: center; justify-content: space-between; margin: 28rpx 0 16rpx; font-size: 28rpx; }
.widget { border-radius: 18px; padding: 14px; box-sizing: border-box; background: var(--sf-glass); border: 1px solid var(--sf-edge); box-shadow: var(--sf-shadow); -webkit-backdrop-filter: var(--sf-filter); backdrop-filter: var(--sf-filter); }
.widget-small { width: 348rpx; max-width: 100%; min-height: 348rpx; }
.widget-list { width: 100%; min-height: 360rpx; }
.widget-large { display: flex; flex-direction: column; width: 100%; max-width: 350px; height: 250px; min-height: 0; padding: 0; border-radius: 16px; container: widget / inline-size; }
.widget-large-pickup { position: relative; display: flex; flex-direction: column; flex: 0 0 145px; min-height: 0; box-sizing: border-box; padding: 5px 12px 3px; }
.widget-large .widget-heading { flex: none; min-height: 23px; font-size: 12px; font-weight: 700; color: #23334c; }
.widget-large .widget-heading .detail { font-size: 10px; font-weight: 400; }
.widget-pickup-count { color: var(--sf-blue); font-size: 16px; }
.widget-station-value { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; max-width: 60%; height: 24px; min-height: 24px; margin: 0; padding: 0 6px; border: 1px solid #dce6f3; border-radius: 6px; background: rgba(255,255,255,.45); color: var(--sf-blue); font-size: 9px; line-height: 22px; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.widget-station-value > text { flex: none; }
.widget-station-list { position: absolute; z-index: 3; top: 32px; right: 12px; left: 12px; max-height: 105px; overflow-y: auto; overscroll-behavior: contain; border: 1px solid #dce6f3; border-radius: 7px; background: rgba(255,255,255,.45); box-shadow: 0 3px 8px rgba(32,64,110,.13); }
.widget-station-list button { width: 100%; height: auto; min-height: 30px; margin: 0; padding: 5px 8px; border-radius: 0; background: rgba(255,255,255,.45); color: var(--sf-muted); text-align: left; font-size: 10px; line-height: 20px; }
.widget-station-list button.selected { background: #eff5ff; color: var(--sf-blue); }
.widget-station-list button:focus-visible, .widget-station-value:focus-visible, .widget-pickup-scroll:focus-visible { outline: 2px solid var(--sf-blue); outline-offset: -2px; }
.widget-pickup-scroll { flex: 1; min-height: 0; height: 98px; margin-top: 3px; overscroll-behavior: contain; }
.widget-pickup-footer { display: flex; flex: none; justify-content: space-between; gap: 6px; min-block-size: 14px; color: var(--sf-muted); font-size: 8px; }
.widget-platform-filter:focus-visible { outline: 2px solid var(--sf-blue); outline-offset: 2px; }
.widget-large-row { display: flex; min-height: 49px; align-items: center; gap: 8px; box-sizing: border-box; border-bottom: 1px solid #edf0f5; }
.widget-large-row:last-of-type { border-bottom: 0; }
.widget-single-row { display: flex; min-height: 98px; flex-direction: column; justify-content: center; gap: 8px; }
.widget-single-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.widget-single-line .code { max-width: none; color: #263954; font-size: 31px; font-weight: 700; line-height: 1.15; }
.widget-single-line.long-code .code { font-size: 22px; }
.widget-single-owner { flex: 0 1 auto; min-width: 0; max-width: 76px; padding: 3px 6px; border-radius: 4px; background: #e9f0fa; color: #5377a2; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.widget-single-bottom { display: flex; align-items: center; gap: 8px; }
.widget-single-text { flex: 1; min-width: 0; }
.widget-single-text .address { margin-top: 0; font-size: 10px; color: var(--sf-muted); }
.widget-single-row .picked-label { display: flex; align-items: center; justify-content: center; width: 44px; min-height: 36px; padding: 0; border: 0; border-radius: 8px; background: var(--sf-blue); color: #fff; font-size: 11px; font-weight: 600; }
.widget-large-code { flex: 1; min-width: 0; }
.widget-large-code .code { display: block; max-width: none; color: var(--sf-text); font-size: 24px; font-weight: 700; line-height: 1.1; }
.pickup-line { display: flex; align-items: center; gap: 5px; min-width: 0; flex-wrap: wrap; }
.cabinet-badge { flex: none; max-width: 100%; box-sizing: border-box; padding: 7rpx 9rpx; border: 1rpx solid #d4e4fb; border-radius: 7rpx; background: var(--sf-mint); color: var(--sf-teal); font-size: 22rpx; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; }
.widget-large .cabinet-badge { padding: 4px; font-size: 10px; border-radius: 4px; }
.widget-large-code .pickup-line.long-code .code { font-size: 16px; }
.widget-large-code .address { margin-top: 5px; font-size: 10px; color: var(--sf-muted); }
.widget-large-owner { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; max-inline-size: 66px; flex: none; color: #43556c; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.widget-pickup-title { display: block; flex: none; max-inline-size: 66px; color: var(--sf-muted); font-size: 10px; line-height: 14px; white-space: nowrap; }
.widget-large-quantity { display: block; max-width: 100%; margin-top: 5px; color: var(--sf-muted); font-size: 10px; line-height: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.widget-large-owner .widget-large-quantity { margin-top: 0; font-size: 8px; line-height: 11px; }
.widget-large-row .picked-label { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 44px; height: 42px; padding: 0; border: 0; border-radius: 8px; background: var(--sf-blue); color: #fff; font-size: 10px; font-weight: 600; }
.widget-delivered-status { display: block; color: var(--sf-muted); font-size: 10px; }
.widget-delivered-title { display: block; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #43556c; font-size: 14px; font-weight: 600; }
.widget-large-row .widget-receipt-action { font-size: 11px; }
.widget-large-row .widget-receipt-action.disabled { opacity: .45; }
.widget-large .empty { display: flex; flex: 1; align-items: center; justify-content: center; min-height: 0; padding: 0; font-size: 13px; text-align: center; }
.widget-large .widget-more { margin-top: 0; font-size: 9px; }
.widget-road { display: flex; flex-direction: column; flex: 1; min-height: 0; box-sizing: border-box; padding: 4px 12px 3px; background: rgba(222,231,245,.45); border-top: 1px solid #e2e8f2; border-radius: 0 0 15px 15px; }
.widget-road-content { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.widget-road-heading { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 6px; min-block-size: 26px; margin-bottom: 4px; color: #4c5c72; font-size: 10px; font-weight: 700; line-height: 16px; }
.widget-road-label { display: flex; flex: none; align-items: baseline; gap: 3px; white-space: nowrap; }
.widget-road-count { color: var(--sf-blue); font-size: 15px; }
.widget-road-heading .detail { font-size: 8px; font-weight: 400; color: var(--sf-muted); white-space: nowrap; }
.widget-platform-filters { display: flex; align-items: center; gap: 4px; margin-inline-start: auto; }
.widget-platform-filter { display: flex; align-items: center; gap: 3px; block-size: 24px; min-inline-size: 0; margin: 0; padding: 0 6px; border: 1px solid transparent; border-radius: 6px; background: rgba(255,255,255,.45); color: var(--sf-muted); font-size: 9px; line-height: 22px; white-space: nowrap; }
.widget-platform-filter.selected { color: var(--sf-blue); border-color: var(--sf-blue); }
.widget-platform-count { font-size: 11px; }
.widget-platform-mark { display: inline-flex; align-items: center; justify-content: center; inline-size: 16px; block-size: 16px; border-radius: 4px; color: #f46a1f; background: #fff1e6; font-size: 8px; font-weight: 700; }
.widget-platform-mark.jd { color: #db405c; background: #ffe8ec; }
.widget-platform-mark.pdd { color: #e75358; background: #ffe9e7; }
.widget-road-footer { display: flex; flex: none; align-items: center; justify-content: flex-end; min-block-size: 15px; color: var(--sf-muted); font-size: 8px; }
.widget-road-refresh { display: flex; align-items: center; gap: 5px; color: var(--sf-blue); font-size: 15px; }
.widget-road-refresh > text:last-child { color: var(--sf-muted); font-size: 8px; white-space: nowrap; }
.widget-road-row { display: flex; flex: none; align-items: center; gap: 8px; margin-top: 4px; height: 16px; font-size: 11px; line-height: 16px; }
.widget-road-carousel { flex: none; height: 40px; }
.widget-road-status { flex: none; color: var(--sf-muted); font-size: 10px; }
.widget-road-platform { flex: none; width: 16px; height: 16px; border-radius: 4px; background: #e1e8f1; color: var(--sf-muted); font-size: 10px; line-height: 16px; text-align: center; }
.widget-road-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sf-muted); }
.widget-road-owner { flex: none; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sf-muted); font-size: 10px; }
.widget-road-empty { display: block; padding: 4px 0 1px; color: var(--sf-muted); font-size: 10px; }
@container widget (inline-size < 320px) { .widget-platform-filter { padding-inline: 4px; } .widget-platform-mark { display: none; } }
@container widget (inline-size < 285px) { .widget-large-pickup, .widget-road { padding-inline: 9px; } .widget-large-row { gap: 4px; } .widget-large-code .code { font-size: 19px; } .widget-road-heading { gap: 4px; } .widget-platform-filters { gap: 3px; } .widget-platform-filter { padding-inline: 3px; } .widget-single-line .code { font-size: 28px; } .widget-single-line.long-code .code { font-size: 20px; } }
.widget-heading { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; font-size: 28rpx; color: var(--sf-blue); }
.widget-date, .widget-more { display: block; margin-top: 14rpx; font-size: 24rpx; color: var(--sf-muted); }
.widget-item { padding: 20rpx 0 16rpx; border-bottom: 1px solid #eef1f5; }
.widget-list .widget-item, .widget-large .widget-item { padding: 8rpx 0; }
.code-row { display: flex; align-items: center; gap: 12rpx; min-height: 48rpx; }
.code { flex: 0 1 auto; min-width: 0; max-width: 240rpx; overflow-wrap: anywhere; color: var(--sf-text); font-size: 32rpx; font-weight: 500; line-height: 1.3; }
.code-row.long-code .code { font-size: 28rpx; }
.company { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sf-muted); font-size: 24rpx; }
.address { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 24rpx; color: var(--sf-muted); margin-top: 10rpx; line-height: 1.5; }
.widget-footer { display: flex; justify-content: space-between; margin-top: 18rpx; color: var(--sf-muted); font-size: 24rpx; }
.refresh-label, .picked-label { color: var(--sf-blue); font-size: 24rpx; }
.picked-label { flex-shrink: 0; margin-left: auto; padding: 4rpx 10rpx; line-height: 1.4; border: 1px solid #dce6f3; border-radius: 8rpx; background: #eff5ff; }
.empty { display: block; padding: 36rpx 0; color: var(--sf-muted); font-size: 24rpx; }
.size-choice { display: flex; flex-wrap: wrap; gap: 20rpx; margin: 24rpx 0; font-size: 26rpx; label { display: flex; align-items: center; gap: 8rpx; } }
</style>
