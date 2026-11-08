<template>
  <view class="online-page sf-page">
    <view v-if="loading" class="notice">正在加载线上账号…</view>
    <view v-if="error || online.error" class="notice error">{{ error || online.error }}</view>
    <view v-else-if="online.notice" class="notice">同步完成 · {{ online.notice }}</view>
    <view v-if="!loading" class="notice" role="status">{{ statusText }}<text v-if="online.pendingCount"> · {{ online.pendingCount }} 个操作待同步</text></view>
    <view v-for="account in online.accounts || []" :key="account.id" class="section account sf-surface">
      <view class="account-icon"><image v-if="platformIcon(account.platform)" :src="platformIcon(account.platform)" mode="aspectFit" /><text v-else>{{ platformName(account.platform || '云').slice(0,1) }}</text></view>
      <view class="account-content"><text class="section-title">{{ platformName(account.platform) }} · {{ account.label || '我的账号' }}</text><text v-if="account.familyName" class="family-tag">{{ account.familyName }}</text><text :class="['hint',{expired:account.status==='expired'}]">{{ account.status === 'expired' ? '登录已失效 · 请前往后台更新' : account.status==='error' ? '采集异常' : account.lastSuccessAt ? '最近采集成功' : '尚未采集' }}{{ account.lastSuccessAt ? ' · '+time(account.lastSuccessAt)+' 更新' : '' }}</text><text v-if="account.error" class="hint expired">{{ account.error }}</text><view class="buttons"><button class="secondary" :disabled="working" @click="openAdmin">{{ account.status==='expired' ? '前往后台更新' : '管理' }}</button></view></view>
    </view>
    <view class="section sf-surface" v-if="online.bound">
      <text class="section-title">当前设备</text><text class="hint">{{ online.baseUrl }}</text><text class="hint">最近成功同步：{{ time(online.lastSuccessAt) }}</text><text class="hint">后台约每小时更新；打开应用时检查已有快照。</text>
      <view class="buttons"><button class="primary" :disabled="working" @click="sync">{{ busy ? '处理中…' : '立即同步' }}</button><button class="secondary" :disabled="working" @click="unbind">解除设备绑定</button></view>
    </view>
    <view v-if="!loading" class="section sf-surface">
      <text class="section-title">{{ online.bound ? '更换绑定服务' : '绑定新服务' }}</text>
      <view class="buttons"><button class="secondary" :disabled="working" @click="scan('camera')">扫描授权码</button><button class="secondary" :disabled="working" @click="scan('image')">识别授权图片</button><button class="secondary" :disabled="working" @click="readPaste">粘贴识别</button></view>
      <text v-if="recognizing" class="hint">正在识别，可在识别界面取消…</text>
      <view v-if="pasteVisible"><textarea class="paste-input" v-model="scanText" :disabled="working" placeholder="粘贴或修改授权信息，支持二维码原文、服务地址与文字授权码" /><button class="secondary" :disabled="working || !scanText.trim()" @click="parseScan">识别并填入</button></view>
      <label for="service-address" class="label">服务地址</label><input id="service-address" class="input" autocapitalize="off" autocorrect="off" v-model="baseUrl" :disabled="working" placeholder="https://你的服务地址" />
      <label for="pairing-code" class="label">一次性授权码</label><input id="pairing-code" class="input" autocapitalize="off" autocorrect="off" v-model="code" :disabled="working" placeholder="也可手动输入后台生成的授权码" />
      <view class="buttons"><button class="primary" :disabled="working || !baseUrl.trim() || !code.trim()" @click="verifyBinding">{{ busy ? '处理中…' : '核验授权范围' }}</button></view>
      <text class="hint">先核验服务与授权范围，确认后才绑定。文字识别结果可在上方修改。</text>
      <text class="hint">授权码由后台生成，10 分钟内有效。App 只保存设备授权，账号登录在后台管理。</text>
      <text class="hint">服务地址须使用 HTTPS；本机测试可使用本机 HTTP 地址。</text>
    </view>
    <view v-if="pairingPreview" class="section preview-section sf-surface">
      <text class="section-title">已核验服务 · {{ pairingPreview.service.name }}</text><text class="hint">{{ pairingPreview.service.baseUrl }}</text>
      <view v-if="pairingPreview.scope.familyIds.length"><text class="label">授权家人</text><view class="family-tags"><text v-for="family in pairingPreview.scope.families" :key="family.id" class="family-tag">{{ family.name }} · 当前 {{ family.accountCount }} 个账号</text></view><text class="hint">包含这些家人当前及以后新增的平台账号。</text></view>
      <view v-if="pairingPreview.scope.accountIds.length && (!pairingPreview.scope.familyIds.length || !pairingPreview.scope.includeFutureAccounts)"><text class="label">指定账号授权</text><text v-for="account in pairingPreview.scope.accounts" :key="account.id" class="hint">{{ platformName(account.platform) }} · {{ account.label }}</text><text class="hint">指定账号不自动扩大为家人整组授权。</text></view>
      <text class="hint">有效至 {{ time(pairingPreview.expiresAt) }}</text><text v-if="online.bound" class="hint">确认后将更换当前服务，本地历史保留。</text>
      <view class="buttons"><button class="secondary" :disabled="working" @click="pairingPreview = null">返回修改</button><button class="primary" :disabled="working" @click="confirmBinding">确认绑定</button></view>
    </view>
  </view>
</template>
<script>
import { getCachedSnapshot, getOnlineStatus, bindOnline, syncOnline, refreshOnline, unbindOnline } from '@/services/assistant.js';
import { parsePairingInput, parsePairingRecognition, scanPairingInformation, previewPairingBinding } from '@/services/pairing-scan.js';
import jingdong from "@/static/images/jd.png";
export default {
  data:()=>({online:{bound:false,accounts:[]},hydrated:false,baseUrl:'',code:'',loading:true,busy:false,recognizing:false,error:'',refreshProgressText:'',pendingNotice:'',pasteVisible:false,scanText:'',pairingPreview:null,verifiedBinding:null,jingdong}),
  computed:{working(){return this.busy||this.recognizing;},statusText(){if(this.busy)return this.refreshProgressText||'正在处理，请稍候';if(this.pendingNotice)return this.pendingNotice;if(this.online.errorCode==='token_expired'||this.online.errorCode==='unauthorized')return '设备授权已失效，请重新绑定';if(!this.online.bound)return '尚未绑定 · 本地取件记录仍可使用';if(this.online.accounts?.some(a=>a.status==='expired'))return '后台账号需更新登录 · 设备绑定仍保留';if(this.online.errorCode)return '连接异常 · 正在使用上次成功的本地记录';return this.online.lastSuccessAt?'已更新 '+this.time(this.online.lastSuccessAt):'已绑定 · 尚未同步';}},
  watch:{baseUrl(){this.pairingPreview=null;this.verifiedBinding=null;},code(){this.pairingPreview=null;this.verifiedBinding=null;}},
  onLoad(){uni.$on('assistant-changed',this.changed);},onShow(){this.load();},onUnload(){this.scanController?.abort();uni.$off('assistant-changed',this.changed);},
  methods:{
    platformName(value){return ({taobao:'淘宝',pdd:'拼多多',jd:'京东'})[value]||value;},
    platformIcon(value){return value==='jd'?this.jingdong:'';},
    time(value){return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未同步';},
    changed(snapshot){if(snapshot?.online){this.online=snapshot.online;this.hydrated=true;this.loading=false;if(!this.baseUrl)this.baseUrl=this.online.baseUrl||'';if(!this.online.jobs?.some(job=>['queued','running'].includes(job.state)))this.pendingNotice='';}},
    async load(){const cached=getCachedSnapshot();if(cached&&!this.hydrated)this.changed(cached);if(this.loadInFlight)return this.loadInFlight;this.loading=!this.hydrated;this.error='';this.loadInFlight=(async()=>{try{this.changed({online:await getOnlineStatus()});if(this.online.bound)this.changed(await syncOnline(false));}catch(e){this.error=e.message||'加载失败';}finally{this.loading=false;this.loadInFlight=null;}})();return this.loadInFlight;},
    async run(operation){if(this.busy)return;this.busy=true;this.error='';this.pendingNotice='';try{const result=await operation();this.online=result.snapshot?.online||result.online||result;this.error=result.onlineError||'';this.pendingNotice=result.pending?result.pendingNotice||'订单仍在后台处理中，稍后刷新查看':'';if(this.online.error)throw new Error(this.online.error);return !this.error;}catch(e){this.error=e.message||'操作失败，请重试';return false;}finally{this.busy=false;this.refreshProgressText='';}},
    async verifyBinding(){if(this.working)return;this.busy=true;this.error='';this.pairingPreview=null;this.verifiedBinding=null;try{const baseUrl=this.baseUrl.trim(),code=this.code.trim();const preview=await previewPairingBinding(baseUrl,code);this.verifiedBinding={baseUrl,code};this.pairingPreview=preview;}catch(e){this.error=e.message||'核验失败，请重试';}finally{this.busy=false;}},
    async confirmBinding(){if(this.working||!this.pairingPreview||!this.verifiedBinding)return;const verified={...this.verifiedBinding};if(verified.baseUrl!==this.baseUrl.trim()||verified.code!==this.code.trim()||this.pairingPreview.expiresAt<=Date.now()){this.pairingPreview=null;this.verifiedBinding=null;this.error='授权信息已修改或过期，请重新核验';return;}const commit=async()=>{if(await this.run(()=>bindOnline(verified.baseUrl,verified.code))){this.code='';this.pairingPreview=null;this.verifiedBinding=null;}};if(this.online.bound){uni.showModal({title:'更换绑定服务？',content:'当前设备将连接已核验的新服务，本地历史保留。',success:r=>{if(r.confirm)commit();}});}else await commit();},
    sync(){return this.run(()=>refreshOnline(progress=>{this.refreshProgressText=progress.label;}));},
    unbind(){uni.showModal({title:'解除设备绑定？',content:'停止此设备线上同步，本地历史会保留。',success:r=>{if(r.confirm)this.run(()=>unbindOnline());}});},
    fillBinding(data){if(data.baseUrl)this.baseUrl=data.baseUrl;this.code=data.code;this.pairingPreview=null;this.verifiedBinding=null;this.error=data.needsBaseUrl?'仅识别到授权码，请补填服务地址后核验':'已识别授权信息，请核对地址与授权码后核验';},
    parseScan(){try{this.fillBinding(parsePairingInput(this.scanText,this.baseUrl.trim()));}catch(e){this.error=e.message||'无法识别授权信息，请手动输入';}},
    readPaste(){if(this.working)return;this.pasteVisible=true;this.error='';uni.getClipboardData({success:r=>{this.scanText=typeof r.data==='string'?r.data:'';if(this.scanText.trim())this.parseScan();},fail:()=>{this.error='无法读取剪贴板，请在文本框中粘贴后识别';}});},
    async scan(source){if(this.working)return;this.recognizing=true;this.error='';this.scanController=new AbortController();try{const result=await scanPairingInformation(source,{signal:this.scanController.signal});this.scanText=(result.texts||[]).join('\n');if(result.source==='image-text')this.pasteVisible=true;this.fillBinding(parsePairingRecognition(result,this.baseUrl.trim()));}catch(e){this.error=e.message||'识别失败，可重试或手动输入';if(this.scanText)this.pasteVisible=true;}finally{this.recognizing=false;this.scanController=null;}},
    openAdmin(){try{const configured=new URL(this.online.baseUrl);if(configured.protocol!=='https:'&&!(configured.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(configured.hostname)))throw new Error('请在浏览器中打开已配置的 HTTPS 后台');if(configured.username||configured.password)throw new Error('服务地址不能包含用户名密码');uni.showModal({title:'前往已绑定服务后台',content:'打开 '+configured.origin+' 管理账号登录。',confirmText:'打开后台',success:r=>{if(!r.confirm)return;if(typeof window!=='undefined'&&window.PickCodeNative){uni.setClipboardData({data:configured.origin,success:()=>uni.showToast({title:'已复制后台地址，请用浏览器打开',icon:'none'})});}else if(typeof window!=='undefined')window.open(configured.origin,'_blank','noopener,noreferrer');}});}catch(e){this.error=e.message;}}
  }
};
</script>

<style lang="scss" scoped>
.online-page { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.section { border-radius: 24px; padding: 18px; margin-bottom: 14px; }
.section-title { display: block; color: var(--sf-text); font-size: 17px; line-height: 1.5; font-weight: 650; overflow-wrap: anywhere; }
.notice { padding: 12px 14px; margin-bottom: 14px; background: rgba(222,235,254,.65); color: var(--sf-muted); border-radius: 14px; font-size: 14px; line-height: 1.65; }
.error { background: #fff0ef; color: #aa343b; }.hint { display: block; color: var(--sf-muted); font-size: 13px; line-height: 1.75; margin-top: 10px; overflow-wrap: anywhere; }.expired { color: #aa343b; }
.account { display: flex; gap: 14px; }.account-icon { display: flex; align-items: center; justify-content: center; flex: none; width: 44px; height: 44px; background: rgba(8,103,255,.1); color: var(--sf-blue); font-size: 22px; font-weight: 650; border-radius: 14px; }.account-icon image { width: 34px; height: 34px; border-radius: 8px; }.account-content { flex: 1; min-width: 0; }
.label { display: block; font-size: 15px; color: var(--sf-text); margin: 20px 0 8px; font-weight: 550; }
.input { min-height: 48px; height: auto; padding: 0 12px; border: 1px solid #8796ab; border-radius: 12px; background: rgba(255,255,255,.38); font-size: 16px; color: var(--sf-text); box-sizing: border-box; }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }.buttons button { flex: 1 1 100px; min-width: 0; }
button { min-height: 48px; height: auto; line-height: 1.5; border-radius: 14px; padding: 12px; font-size: 14px; margin: 0; }button::after { border: 0; }button[disabled] { opacity: .5; }
.primary { background: var(--sf-blue); color: #fff; }.secondary { color: var(--sf-blue); background: rgba(255,255,255,.38); border: 1px solid rgba(8,103,255,.25); }
.paste-input { font-size: 15px; line-height: 1.6; width: 100%; height: 120px; background: rgba(255,255,255,.35); border: 1px solid #8796ab; border-radius: 12px; margin: 16px 0; padding: 12px; box-sizing: border-box; }
.family-tag { display: inline-block; background: rgba(8,103,255,.08); color: var(--sf-blue); font-size: 12px; line-height: 1.6; padding: 3px 8px; border-radius: 7px; margin-top: 8px; }.family-tags { display: flex; flex-wrap: wrap; gap: 8px; }.preview-section { outline: 1px solid rgba(8,103,255,.35); outline-offset: -1px; }
</style>
