<template>
  <view class="detail-sheet" v-if="item" role="dialog" aria-modal="true" aria-label="订单详情" @click.stop @keydown="detailKeydown"><view class="sheet-handle"></view>
    <view class="heading"><text>{{ matchingSourceId ? '选择对应包裹' : '订单详情' }}</text><button class="link" role="button" tabindex="0" aria-label="关闭取件详情" @click="$emit('close')" @keydown.enter.prevent="!$event.repeat && $emit('close')" @keydown.space.prevent="$event.preventDefault()" @keyup.space.prevent="$emit('close')"><uni-icons type="closeempty" size="21" color="#647186" /></button></view>
    <scroll-view scroll-y class="detail-scroll">
      <template v-if="!matchingSourceId">
        <view v-if="members.length > 1" class="shipment-picker" role="group" aria-label="选择查看的包裹"><button v-for="(member, index) in members" :key="member.id" role="button" tabindex="0" :aria-pressed="currentMember?.id === member.id" @click="detailMemberId = member.id">包裹 {{ index + 1 }} · {{ member.picked ? '已取' : '未取' }}</button></view>
        <OrderOverview :order="currentOrder" :shipment="currentShipment" :pickup="item" :sources="sources" :status="item.needsPickupAssignment ? '待确认归属' : currentShipment.picked ? '已取件' : '待取件'" />
      </template>
      <text v-if="item.pickupCabinetConflict" class="review-note">柜号信息不一致，请核对原始短信与关联来源。</text>
      <view class="section" v-if="members.length && !matchingSourceId && (members.length > 1 || showManagement)">
        <text class="section-title">{{ item.needsPickupAssignment ? '确认此前领取的包裹' : '关联包裹 · 选择本次已取' }}</text>
        <text v-if="item.needsPickupAssignment" class="muted">此前已取 {{ item.unassignedPickedCount }} 件，请确认对应包裹。</text>
        <view v-for="member in members" :key="member.id" class="member" @click="select(member)">
          <checkbox :checked="selected.includes(member.id)" :disabled="member.picked || busy" color="#1673ff" />
          <view class="member-body"><text class="family-badge" :class="{ unassigned: !member.familyId }">{{ familyLabel(member) }}</text><text class="member-title">{{ member.title || '包裹' }} {{ member.platform ? '· '+platformName(member.platform) : '' }}</text><text v-if="member.platformOrderId" class="muted">订单 {{ member.platformOrderId }}</text><text class="muted">{{ member.waybillNo ? '运单 '+member.waybillNo : '短信包裹 '+(members.indexOf(member)+1) }}</text></view>
          <text class="link">{{ member.picked ? '已取' : '待取' }}</text>
        </view>
        <text class="muted">仅记录领取，不会确认电商收货。</text>
      </view>
      <view class="section" v-if="conflicts.length && !matchingSourceId">
        <text class="section-title">发现不同取件码 · 请选择后确认</text>
        <view class="choice" v-for="conflict in conflicts" :key="conflict.code+'-'+conflict.sourceId" @click="chosenCode = conflict.code"><radio :checked="chosenCode === conflict.code" color="#1673ff" /><view><text>{{ conflict.code }}</text><text class="muted">{{ conflict.sourceType || '来源' }} · {{ time(conflict.date) }}{{ conflict.code === item.code ? ' · 当前记录' : '' }}</text></view></view>
        <button class="secondary" :disabled="!chosenCode || busy" @click="act('resolveCode', {id:item.id, code:chosenCode})">确认使用所选取件码</button>
        <button class="plain" @click="chosenCode = ''; $emit('close')">暂不处理</button>
      </view>
      <view class="section management-section" v-if="sources.length && (showManagement || matchingSourceId)">
        <text class="section-title">原始短信与关联来源</text>
        <view class="source sf-surface" v-for="source in sources" :key="source.sourceId">
          <text class="muted">{{ source.sender || source.kind || '短信' }} · {{ time(source.date) }}{{ source.ignored ? ' · 已忽略' : '' }}</text>
          <text v-if="source.company || source.address" class="muted">{{ [source.company, source.address].filter(Boolean).join(' · ') }}</text>
          <text class="sms" selectable>{{ source.body || '此来源未保存短信正文' }}</text>
          <text v-if="source.matchBasis" class="match-basis">{{ source.matchBasis }}</text>
          <text v-if="source.matchNeedsReview" class="review-note">发现新的匹配可能，请核对当前关联。</text>
          <view v-if="linkedIds(source).length" class="linked-members">
            <view v-for="shipmentId in linkedIds(source)" :key="shipmentId" class="linked-member">
              <view class="member-body"><text class="member-title">{{ linkedTitle(shipmentId) }}</text><text class="muted">{{ linkedWaybill(shipmentId) }}{{ shipmentById[shipmentId]?.picked ? ' · 已取' : '' }}</text></view>
              <button class="text-button danger" :disabled="busy" @click="unlink(source, shipmentId)">解除此件</button>
            </view>
          </view>
          <view class="source-actions"><button v-if="canMatch(source) && matchingSourceId !== source.sourceId" class="text-button link" :disabled="busy" @click="openMatching(source)">{{ linkedIds(source).length ? '重新匹配' : '匹配订单' }}</button><button v-if="!source.ignored" class="text-button link" :disabled="busy" @click="$emit('ignore', source)">忽略此短信</button><button v-if="linkedIds(source).length" class="text-button danger" :disabled="busy" @click="unlink(source)">解除整条短信关联</button></view>
          <view v-if="matchingSourceId === source.sourceId" class="matching-panel">
            <view class="match-heading"><text class="section-title">{{ includeMatchOther ? '未完成包裹' : '推荐候选' }}</text><text class="muted">已选 {{ matchSelected.length }} / {{ matchLimit }} 件</text></view>
            <text class="muted">仅关联取件信息；未选择的 {{ Math.max(0, matchLimit-matchSelected.length) }} 件继续待匹配。</text>
            <view class="match-search"><input v-model="matchQuery" :disabled="busy" placeholder="搜索商品、订单号或运单号" aria-label="搜索匹配包裹" @input="showOtherPackages = true" /></view>
            <view class="match-filters">
              <picker :range="familyOptions" range-key="label" :value="familyOptionIndex" :disabled="busy" @change="chooseFamily"><view class="filter-option">{{ familyOptions[familyOptionIndex].label }} ▾</view></picker>
              <picker :range="platformOptions" range-key="label" :value="platformOptionIndex" :disabled="busy" @change="choosePlatform"><view class="filter-option">{{ platformOptions[platformOptionIndex].label }} ▾</view></picker>
            </view>
            <view v-for="candidate in matchRows" :key="candidate.id" class="match-choice sf-surface" :class="{ 'match-selected': matchSelected.includes(candidate.id), 'match-disabled': !canSelectMatch(candidate) }" role="checkbox" tabindex="0" :aria-checked="matchSelected.includes(candidate.id) ? 'true' : 'false'" :aria-disabled="!canSelectMatch(candidate) ? 'true' : 'false'" :aria-label="'关联 '+candidate.title+'，运单'+(candidate.waybillNo || '未知')" @click="toggleMatch(candidate)" @keydown.enter.stop="toggleMatch(candidate)" @keydown.space.prevent.stop="toggleMatch(candidate)">
              <checkbox :checked="matchSelected.includes(candidate.id)" :disabled="!canSelectMatch(candidate)" color="#1673ff" />
              <view class="member-body">
                <text class="candidate-meta">{{ platformName(candidate.platform) || '线上' }} · {{ familyLabel(candidate) }}{{ candidate.current ? ' · 当前关联' : '' }}{{ candidate.current && candidate.picked ? ' · 已取，保留关联' : '' }}</text>
                <text class="member-title">{{ candidate.title }}</text>
                <text class="muted">{{ candidate.station || '末端站点未知' }} · {{ candidate.waybillNo ? '运单尾号 …'+candidate.waybillNo.slice(-4) : '暂无运单号，请先刷新物流' }}</text>
                <text class="muted">到站 {{ time(candidate.arrivalAt) }} · {{ deltaText(candidate.evidence?.deltaMs) }}</text>
                <text class="candidate-reason" :class="{ 'conflict-reason': candidate.conflict }">{{ reasonText(candidate) }}</text>
                <text v-if="!candidate.current && candidate.canLinkPickup !== true" class="danger">{{ candidate.pickupLinkReason || '此包裹暂不能关联，请刷新后重试' }}</text>
              </view>
            </view>
            <text v-if="!matchRows.length" class="match-empty">{{ matchQuery || matchFamily || matchPlatform ? '没有符合筛选条件的包裹' : '暂无可关联的未完成包裹，请更新订单或物流后重试' }}</text>
            <button v-if="!includeMatchOther" class="plain more-packages" :disabled="busy" @click="showOtherPackages = true">查看其他未完成包裹</button>
            <button v-else-if="hasMatchRecommendations && !matchQuery && !matchFamily && !matchPlatform" class="plain more-packages" :disabled="busy" @click="showOtherPackages = false">只看推荐候选</button>
          </view>
        </view>
      </view>
      <text v-else-if="!sources.length && showManagement" class="muted section">此记录没有关联的原始短信。</text>
    </scroll-view>
    <view class="footer" :class="{ 'simple-footer': !matchingSourceId && members.length <= 1 && !item.needsPickupAssignment }">
      <template v-if="matchingSourceId">
        <text v-if="selectionError" class="muted">{{ selectionError }}</text>
        <button role="button" tabindex="0" class="primary" :disabled="busy || !!selectionError || !matchHasChanges" @click="confirmMatching">{{ busy ? '关联中…' : '确认关联所选 '+matchSelected.length+' 件' }}</button>
        <button class="plain" :disabled="busy" @click="closeMatching">返回取件详情</button>
      </template>
      <template v-else>
      <button class="more-control" role="button" tabindex="0" :aria-expanded="showManagement" @click="toggleManagement">••• 更多</button>
      <button v-if="item.needsPickupAssignment" class="primary" :disabled="selected.length !== item.unassignedPickedCount || busy" @click="act('assignPickedMembers',{id:item.id,memberIds:selected})">确认此前已取 {{ item.unassignedPickedCount }} 件</button>
      <button v-else-if="members.length > 1" class="primary" :disabled="!selected.length || busy" @click="pick(selected, true)">标记所选 {{ selected.length }} 件已取</button>
      <button role="button" tabindex="0" v-if="pending" :class="members.length > 1 || item.needsPickupAssignment ? 'secondary' : 'primary'" :disabled="busy" @click="item.needsPickupAssignment ? act('update',{id:item.id,patch:{isPicked:true}}) : pick(members.filter(m=>!m.picked).map(m=>m.id),true)">{{ members.length > 1 ? '全部领取（'+pending+'件）' : '确认取件' }}</button>
      <button role="button" tabindex="0" v-if="pending < total && !item.needsPickupAssignment" class="secondary" :disabled="busy" @click="pick(members.filter(m=>m.picked).map(m=>m.id),false)">撤销已取{{ members.length > 1 ? '（全部已取成员）' : '' }}</button>
      </template>
      <text v-if="item.needsMatchReview && !matchingSourceId" class="review-note">不确定关联仅记录本取件码，匹配订单可稍后处理。</text>
      <text v-if="error" class="danger error">{{ error }}</text>
    </view>
  </view>
</template>
<script>
import { mutate } from '@/services/assistant.js';
import OrderOverview from '@/components/OrderOverview.vue';
import { stationDisplayName, pickupCabinet } from '@/services/station-presentation.js';
import { pickupSources, canMatchSource, linkedShipmentIds, sourcePackageCount, pickupShipmentRows, matchingRows, matchSelectionError, matchLinkPayload, timeDifference, matchReason } from '@/services/pickup-matching-view.js';
export default {
  components:{OrderOverview},
  props: { item: Object, packages: {type:Array,default:()=>[]}, matchOnOpen:Boolean }, emits:['close','changed','ignore'],
  data:()=>({detailMemberId:'',showManagement:false,selected:[],chosenCode:'',busy:false,error:'',matchingSourceId:'',matchSelected:[],matchQuery:'',matchFamily:'',matchPlatform:'',showOtherPackages:false}),
  watch:{'item.id'(){this.detailMemberId='';this.showManagement=false;this.selected=[];this.chosenCode='';this.error='';this.closeMatching();}},
  mounted(){this.$nextTick?.(()=>this.$el?.querySelector?.('[aria-label="关闭取件详情"]')?.focus?.());if(this.matchOnOpen){const source=this.sources.find(s=>canMatchSource(s)&&(this.item.needsMatchReview||s.matchNeedsReview||linkedShipmentIds(s).length<sourcePackageCount(s)));if(source)this.openMatching(source);}},
  computed:{
    currentMember(){return this.members.find(member=>member.id===this.detailMemberId)||this.members.find(member=>!member.picked)||this.members[0]||null;},
    independentJourney(){return this.item.needsMatchReview || typeof this.currentMember?.independentPicked === 'boolean';},
    currentShipment(){return (!this.independentJourney && this.shipmentById[this.currentMember?.shipmentId])||{...this.currentMember,picked:this.currentMember?.picked??this.item.isPicked,displayPickupCode:this.item.code};},
    currentOrder(){return (!this.independentJourney && this.packages.find(order=>(order.shipments||[]).some(shipment=>shipment.id===this.currentMember?.shipmentId)))||{title:this.independentJourney?'关联待核对的包裹':this.currentMember?.title||'未关联订单'};},
    members(){return this.item.members || [];}, total(){return this.item.totalCount || this.members.length || 1;}, pending(){return this.item.pendingCount ?? (this.item.isPicked ? 0 : this.total);},
    sources(){return pickupSources(this.item);},
    conflicts(){if(!this.item.conflicts?.length)return []; const values=this.item.conflicts.slice();if(!values.some(c=>c.code===this.item.code))values.unshift({code:this.item.code,sourceType:'当前记录',date:this.item.date});return values.filter((c,i)=>values.findIndex(v=>v.code===c.code)===i);},
    shipmentById(){const shipments=Object.create(null);pickupShipmentRows(this.packages).forEach(s=>{shipments[s.id]=s;});return shipments;},
    matchingSource(){return this.sources.find(source=>source.sourceId===this.matchingSourceId);},
    matchLimit(){return sourcePackageCount(this.matchingSource);},
    hasMatchRecommendations(){return matchingRows(this.matchingSource,this.packages).some(row=>row.evidence||row.current);},
    includeMatchOther(){return this.showOtherPackages||!!this.matchQuery.trim()||!!this.matchFamily||!!this.matchPlatform||!this.hasMatchRecommendations;},
    matchRows(){return matchingRows(this.matchingSource,this.packages,{includeOther:this.includeMatchOther,query:this.matchQuery,familyId:this.matchFamily,platform:this.matchPlatform});},
    filterRows(){return matchingRows(this.matchingSource,this.packages,{includeOther:true});},
    familyOptions(){const options=[{id:'',label:'全部家人'}];this.filterRows.forEach(row=>{const id=row.familyId||'__unassigned__';if(!options.some(option=>option.id===id))options.push({id,label:this.familyLabel(row)});});return options;},
    platformOptions(){const options=[{id:'',label:'全部平台'}];this.filterRows.forEach(row=>{if(row.platform&&!options.some(option=>option.id===row.platform))options.push({id:row.platform,label:this.platformName(row.platform)});});return options;},
    familyOptionIndex(){return Math.max(0,this.familyOptions.findIndex(option=>option.id===this.matchFamily));},
    platformOptionIndex(){return Math.max(0,this.platformOptions.findIndex(option=>option.id===this.matchPlatform));},
    selectionError(){return matchSelectionError(this.matchingSource,this.matchSelected,this.packages);},
    matchHasChanges(){const previous=linkedShipmentIds(this.matchingSource);return !!this.matchingSource?.matchNeedsReview||!!this.item?.needsMatchReview||previous.length!==this.matchSelected.length||previous.some(id=>!this.matchSelected.includes(id));}
  },
  methods:{
    detailKeydown(event){if(event.defaultPrevented)return;if(event.key==='Tab'){const controls=[...(this.$el?.querySelectorAll?.('[tabindex="0"],input')||[])].filter(el=>!el.hasAttribute('disabled')&&el.getClientRects().length);const first=controls[0],last=controls.at(-1);if(first&&((event.shiftKey&&event.target===first)||(!event.shiftKey&&event.target===last))){event.preventDefault();(event.shiftKey?last:first).focus();}return;}if(['Enter',' '].includes(event.key)&&event.target?.tagName==='UNI-BUTTON'){event.preventDefault();if(!event.repeat)event.target.click();}if(event.key==='Escape'){event.preventDefault();this.$emit('close');}},
    toggleManagement(){this.showManagement=!this.showManagement;if(this.showManagement)this.$nextTick(()=>this.$el?.querySelector('.management-section')?.scrollIntoView({block:'nearest'}));},
    stationDisplayName, pickupCabinet,
    canMatch:canMatchSource,linkedIds:linkedShipmentIds,deltaText:timeDifference,reasonText:matchReason,
    familyLabel(item){return item.familyId?(item.familyName||'家人'):'待归属';},
    platformName(value){return ({taobao:'淘宝',pdd:'拼多多',jd:'京东',douyin:'抖音'})[value]||value;},
    time(value){return value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '时间未知';},
    linkedTitle(id){const row=this.shipmentById[id];return row?[this.platformName(row.platform),this.familyLabel(row),row.title].filter(Boolean).join(' · '):'关联包裹暂不可见';},
    linkedWaybill(id){const row=this.shipmentById[id];return row?.waybillNo?'运单尾号 …'+row.waybillNo.slice(-4):'运单信息待更新';},
    openMatching(source){if(this.busy||!canMatchSource(source))return;this.matchingSourceId=source.sourceId;this.matchSelected=linkedShipmentIds(source);this.matchQuery='';this.matchFamily='';this.matchPlatform='';this.showOtherPackages=false;this.error='';this.selected=[];},
    closeMatching(){this.matchingSourceId='';this.matchSelected=[];this.error='';},
    chooseFamily(event){this.matchFamily=this.familyOptions[Number(event.detail.value)]?.id||'';this.showOtherPackages=true;},
    choosePlatform(event){this.matchPlatform=this.platformOptions[Number(event.detail.value)]?.id||'';this.showOtherPackages=true;},
    canSelectMatch(candidate){return !this.busy&&!(candidate.current&&candidate.picked)&&(candidate.current||candidate.canLinkPickup===true);},
    toggleMatch(candidate){const current=this.matchRows.find(row=>row.id===candidate.id);if(!current||!this.canSelectMatch(current))return;this.error='';if(this.matchSelected.includes(current.id))this.matchSelected=this.matchSelected.filter(id=>id!==current.id);else if(this.matchSelected.length>=this.matchLimit)this.error='这条短信共 '+this.matchLimit+' 件，请先取消其他选择';else this.matchSelected=[...this.matchSelected,current.id];},
    selectedConflicts(){return matchingRows(this.matchingSource,this.packages,{includeOther:true}).filter(row=>this.matchSelected.includes(row.id)&&row.conflict).map(row=>({id:row.id,title:row.title,reason:row.conflict}));},
    async confirmMatching(){
      if(this.busy||!this.matchHasChanges)return;
      try{
        let payload=matchLinkPayload(this.matchingSource,this.matchSelected,this.packages);
        const conflicts=this.selectedConflicts();
        if(conflicts.length){
          this.busy=true;
          let confirmed=false;
          try{confirmed=await new Promise(resolve=>uni.showModal({title:'取件信息存在差异',content:conflicts.map(row=>row.title+'：'+row.reason).join('；')+'。确认仍将所选包裹与这条短信关联？',confirmText:'仍要关联',success:result=>resolve(!!result.confirm),fail:()=>resolve(false)}));}finally{this.busy=false;}
          if(!confirmed)return;
          if(JSON.stringify(conflicts)!==JSON.stringify(this.selectedConflicts()))throw new Error('包裹信息已更新，请重新核对差异');
          payload={...matchLinkPayload(this.matchingSource,this.matchSelected,this.packages),allowConflict:true};
        }
        if(await this.act('linkSource',payload)){
          this.closeMatching();
          uni.showToast?.({title:'已匹配',icon:'none'});
        }
      }catch(error){this.error=error.message;}
    },
    select(member){if(member.picked||this.busy)return;this.selected=this.selected.includes(member.id)?this.selected.filter(id=>id!==member.id):[...this.selected,member.id];},
    copy(){uni.setClipboardData({data:this.item.code});},
    async act(action,payload){if(this.busy)return false;this.busy=true;this.error='';try{this.$emit('changed',await mutate(action,payload));this.selected=[];this.chosenCode='';return true;}catch(e){this.error=e.message||'操作失败，请重试';return false;}finally{this.busy=false;}},
    pick(ids,picked){return this.members.length?this.act('pickMembers',{id:this.item.id,memberIds:ids,picked}):this.act('update',{id:this.item.id,patch:{isPicked:picked}});},
    unlink(source,shipmentId){if(this.busy)return;uni.showModal({title:shipmentId?'解除此件关联':'解除整条短信关联',content:'原短信、包裹和已取状态均保留；解除后不会自动重新关联。',success:async r=>{if(r.confirm&&await this.act('unlinkSource',{sourceId:source.sourceId,...(shipmentId?{shipmentId}:{})}))this.closeMatching();}});}
  }
};
</script>
<style scoped lang="scss">
.detail-sheet { background:var(--sf-sheet); width:100%; max-width:640px; max-height:90vh; max-height:90dvh; margin:0 auto; padding:18px 16px calc(20px + env(safe-area-inset-bottom)); border-radius:28px 28px 0 0; color:var(--sf-text); box-sizing:border-box; display:flex; flex-direction:column; }
.heading { flex:none; display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; font-size:1.25rem; font-weight:700; line-height:1.5; }
.heading .link { flex:none; min-width:44px; min-height:44px; display:flex; align-items:center; justify-content:center; }
.detail-scroll { min-height:0; height:58vh; flex:1 1 auto; overscroll-behavior:contain; }
.code-heading { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; min-width:0; margin-bottom:12px; padding:12px 15px; border-radius:20px; }
.code-heading .code { grid-row:2; grid-column:1 / -1; min-width:0; padding:5px 0 10px; color:var(--sf-text); font-size:2rem; font-weight:750; line-height:1.35; letter-spacing:-.025em; font-variant-numeric:tabular-nums; text-align:center; overflow-wrap:anywhere; }
.code-heading.long-code .code { font-size:1.625rem; }
.code-heading .link { grid-row:1; grid-column:2; display:flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; }
.cabinet-badge { grid-row:1; grid-column:1; justify-self:start; align-self:center; max-width:100%; box-sizing:border-box; padding:7px 10px; border:1px solid #effffc; border-radius:10px; background:#dff2ef; color:var(--sf-teal); font-size:.875rem; font-weight:650; line-height:1.5; overflow-wrap:anywhere; }
.link { color:var(--sf-blue); font-size:.875rem; line-height:1.5; font-weight:500; }
.muted { display:block; color:var(--sf-muted); font-size:.8125rem; line-height:1.65; overflow-wrap:anywhere; }
.section { display:block; margin-top:22px; }
.section-title { display:block; color:var(--sf-text); font-size:1rem; font-weight:650; line-height:1.5; margin-bottom:8px; }
.member, .choice { display:flex; align-items:flex-start; gap:10px; padding:15px 0; border-bottom:1px solid #c3cedb66; font-size:.9375rem; line-height:1.6; }
.member checkbox, .choice radio { flex:none; margin-top:3px; }
.member>.link { flex:none; font-size:.75rem; }
.member-body { flex:1; min-width:0; overflow-wrap:anywhere; }
.member-title { display:block; color:var(--sf-text); font-size:.9375rem; line-height:1.6; }
.family-badge { display:inline-block; margin-bottom:5px; padding:3px 8px; border-radius:8px; background:#e5eefc; color:#245dae; font-size:.6875rem; line-height:1.5; }
.family-badge.unassigned { background:#dfe5ed; color:var(--sf-muted); }
.source { margin:10px 0; padding:14px; border-radius:20px; }
.sms { display:block; margin:11px 0; color:var(--sf-text); font-size:.9375rem; line-height:1.75; white-space:pre-wrap; overflow-wrap:anywhere; }
.source-actions { display:flex; flex-wrap:wrap; align-items:center; gap:4px 14px; }
.source-actions .text-button { margin:0; padding:10px 0; min-height:44px; background:transparent; font-size:.8125rem; line-height:1.6; }
.match-basis, .review-note { display:block; margin:10px 0; color:var(--sf-muted); font-size:.8125rem; line-height:1.65; overflow-wrap:anywhere; }
.review-note { color:#78591e; }
.linked-members { margin:12px 0; border-radius:13px; padding:0 10px; background:#ffffff55; }
.linked-member { display:flex; align-items:center; gap:10px; padding:11px 0; }
.linked-member + .linked-member { border-top:1px solid #c3cedb66; }
.linked-member .member-title { font-size:.875rem; }
.text-button { flex:none; margin:0; padding:9px 0; min-height:44px; background:transparent; font-size:.8125rem; line-height:1.6; }
.matching-panel { margin-top:18px; }
.match-heading { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:4px 10px; }
.match-heading .section-title { margin-bottom:0; }
.match-search { margin-top:14px; padding:0 11px; border:1px solid #b5c6da; border-radius:12px; background:#ffffff55; }
.match-search input { width:100%; height:46px; color:var(--sf-text); font-size:.875rem; }
.match-filters { display:flex; gap:9px; margin:10px 0; }
.match-filters picker { flex:1; min-width:0; }
.filter-option { padding:11px 10px; min-height:44px; box-sizing:border-box; border:1px solid #c0cedf; border-radius:12px; color:var(--sf-muted); background:#ffffff55; font-size:.8125rem; line-height:1.5; overflow-wrap:anywhere; }
.match-choice { display:flex; align-items:flex-start; gap:9px; margin-top:10px; padding:13px 11px; border:1px solid var(--sf-edge); border-radius:17px; font-size:.9375rem; line-height:1.6; }
.match-selected { border-color:var(--sf-blue); box-shadow:inset 0 0 0 1px var(--sf-blue); }
.match-disabled { background:#e9eef477; }
.match-choice checkbox { flex:none; margin-top:4px; }
.candidate-meta { display:block; color:var(--sf-muted); font-size:.75rem; line-height:1.6; }
.candidate-reason { display:block; margin-top:5px; color:var(--sf-muted); font-size:.8125rem; line-height:1.65; }
.candidate-reason.conflict-reason { color:#78591e; }
.match-empty { display:block; padding:24px 10px; color:var(--sf-muted); font-size:.875rem; line-height:1.7; text-align:center; }
.footer { flex:none; padding-top:12px; }
button { min-height:46px; margin:10px 0 0; padding:11px 12px; border-radius:13px; font-size:.9375rem; line-height:1.55; }
button::after { border:0; }
button[disabled] { opacity:.55; }
.primary { background:var(--sf-blue); color:#fff; font-weight:650; box-shadow:inset 0 1px 1px #ffffff3b, 0 4px 10px #0867ff14; }
.secondary { background:#e3edf9; color:var(--sf-blue); }
.plain { background:transparent; color:var(--sf-muted); }
.plain.more-packages { color:var(--sf-blue); }
.danger { color:#a93f39; font-size:.8125rem; line-height:1.6; }
.error { display:block; margin-top:12px; }
button:focus-visible, [tabindex]:focus-visible { outline:2px solid var(--sf-blue); outline-offset:3px; }
@media(forced-colors:active) { button, .cabinet-badge, .match-choice { border:1px solid ButtonText; } }
.detail-sheet{max-width:520px;max-height:94vh;max-height:94dvh;padding:0 0 max(14px,env(safe-area-inset-bottom));border:1px solid #fff;background:var(--sf-sheet);box-shadow:none;}.sheet-handle{flex:none;width:34px;height:4px;margin:10px auto 8px;border-radius:6px;background:#aab6c6;}.heading{margin:0 18px 18px;font-size:23px;}.heading>.link{border-radius:50%;border:1px solid white;background:#ffffff65;}.detail-scroll{box-sizing:border-box;height:72vh;height:72dvh;padding:0 18px;}.footer{padding:12px 16px 0;border-top:1px solid #fff;background:var(--sf-sheet);}.footer.simple-footer{display:grid;grid-template-columns:85px minmax(0,1fr);gap:9px;}.footer.simple-footer>button{margin:0;min-width:0;}.footer.simple-footer>.review-note,.footer.simple-footer>.error{grid-column:1 / -1;}.footer .primary{font-size:17px;font-weight:650;}.more-control{border:1px solid #c8d9eb;background:#f7fbffb3;color:#506b84;font-size:15px;font-weight:600;}.shipment-picker{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:15px;}.shipment-picker button{margin:0;min-height:36px;padding:6px 10px;border:1px solid #cbd8e6;border-radius:10px;background:transparent;color:var(--sf-muted);font-size:12px;}.shipment-picker button[aria-pressed=true]{color:var(--sf-blue);background:#e5eefb;}button:focus-visible{outline:3px solid var(--sf-blue);outline-offset:3px;}.detail-sheet{height:94vh;height:94dvh;background:linear-gradient(145deg,#f1f6fb,#e7eef7);}.detail-scroll{height:0;flex:1;}.heading{margin-bottom:8px;}.heading>.link{margin:0;padding:0;}.footer{background:#eaf1f8;}
</style>
