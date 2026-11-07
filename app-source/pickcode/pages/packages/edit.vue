<template>
  <view class="page-wrapper">
    <view class="page-bg"></view>
    
    <view class="container">
      <view class="form-content">
        <!-- 表单输入 -->
        <view class="form-item">
          <label class="label" for="package-name">寄件人或包裹名称</label>
          <input
            id="package-name"
            name="name"
            class="input"
            v-model="formData.name"
            aria-label="寄件人或包裹名称，必填"
            :aria-invalid="fieldErrors.name ? 'true' : null"
            :aria-describedby="fieldErrors.name ? 'package-name-error' : null"
            @input="fieldErrors.name = ''"
            placeholder="请输入名称"
          />
          <text v-if="fieldErrors.name" id="package-name-error" class="field-error" role="alert">{{ fieldErrors.name }}</text>
        </view>

        <view class="form-item">
          <label class="label" for="package-waybill">快递单号</label>
          <input
            id="package-waybill"
            name="waybillNo"
            class="input"
            v-model="formData.waybillNo"
            aria-label="快递单号"
            autocorrect="off"
            autocapitalize="off"
            :spellcheck="false"
            :aria-invalid="fieldErrors.waybillNo ? 'true' : null"
            :aria-describedby="fieldErrors.waybillNo ? 'package-waybill-error' : null"
            @input="fieldErrors.waybillNo = ''"
            placeholder="请输入6-32位单号"
            maxlength="32"
          />
          <text v-if="fieldErrors.waybillNo" id="package-waybill-error" class="field-error" role="alert">{{ fieldErrors.waybillNo }}</text>
        </view>

      </view>
      <text class="form-note">手动记录仅保存信息，不自动查询物流。</text>

      <!-- 底部按钮 -->
      <view class="footer">
        <button class="submit-btn" :disabled="saving" :aria-busy="saving" @click="submitForm">{{ saving ? '保存中' : '保存记录' }}</button>
      </view>
    </view>
  </view>
</template>

<script>
import { mutate } from '@/services/assistant.js';

export default {
  data() {
    return {
      isEdit: false, saving:false, originalWaybillNo: '',
      fieldErrors: { name: '', waybillNo: '' },
      formData: {
        platform: "其他",
        name: "",
        waybillNo: "",
        checked: false,
      }
    };
  },
  onLoad(options) {
    // 判断是否是编辑模式
    if (options.type === 'edit') {
      this.isEdit = true;
      const editData = uni.getStorageSync('editData');
      if (editData) {
        const data = JSON.parse(editData);
        this.formData = { ...data.item, waybillNo: String(data.item.waybillNo ?? '').trim() };
        this.originalWaybillNo = this.formData.waybillNo;
        // 清除临时存储
        uni.removeStorageSync('editData');
      }
    }
  },
  methods: {
    async submitForm() {
      if(this.saving)return;
      this.fieldErrors = { name: '', waybillNo: '' };
      const waybillNo=String(this.formData.waybillNo ?? '').trim();
      const originalWaybillNo=String(this.originalWaybillNo ?? '').trim();
      if (!String(this.formData.name ?? '').trim()) {this.fieldErrors.name = '请输入名称';uni.showToast({title:this.fieldErrors.name,icon:'none'});return;}
      if (!this.isEdit && !waybillNo) {this.fieldErrors.waybillNo = '请输入快递单号';uni.showToast({title:this.fieldErrors.waybillNo,icon:'none'});return;}
      if (this.isEdit && originalWaybillNo && !waybillNo) {this.fieldErrors.waybillNo = '已有快递单号不可清空';uni.showToast({title:this.fieldErrors.waybillNo,icon:'none'});return;}
      if (waybillNo && !/^[A-Za-z0-9-]{6,32}$/.test(waybillNo)) {this.fieldErrors.waybillNo = '单号须为 6–32 位字母、数字或连字符';uni.showToast({title:'请输入有效快递单号',icon:'none'});return;}
      this.saving=true;
      try {
        await mutate('savePackage',{order:{id:this.isEdit?this.formData.id:undefined,platform:this.formData.platform||'其他',title:String(this.formData.name).trim(),amount:this.formData.amount??null,orderDate:this.formData.orderDate||new Date().setHours(12,0,0,0),checked:!!this.formData.checked,waybillNo,requireWaybill:!this.isEdit}});
        uni.setStorageSync('pickcode.manual-package-saved', true);
        uni.navigateBack({delta:1});
      }catch(e){uni.showToast({title:e.message||'保存失败',icon:'none'});}
      finally{this.saving=false;}
    }
  }
};
</script>

<style lang="scss" scoped>
.page-wrapper{min-height:100vh;position:relative;isolation:isolate;color:var(--sf-text);}
.page-bg{position:fixed;inset:0;z-index:-1;}
.container{padding:20px 16px calc(24px + env(safe-area-inset-bottom));min-height:calc(100vh - var(--window-top, 0px));box-sizing:border-box;display:flex;flex-direction:column;max-width:680px;margin:0 auto;}
.form-content{flex:none;background:var(--sf-glass);border:1px solid var(--sf-edge);box-shadow:var(--sf-shadow);backdrop-filter:blur(var(--sf-blur)) saturate(104%);-webkit-backdrop-filter:blur(var(--sf-blur)) saturate(104%);border-radius:24px;padding:20px 16px;}
.form-item + .form-item{margin-top:24px;}
.label{font-size:15px;line-height:22px;color:var(--sf-text);margin-bottom:10px;display:block;font-weight:600;}
.input{box-sizing:border-box;height:48px;border:1px solid #8c9caf;border-radius:14px;padding:0 13px;font-size:16px;background:#ffffff6b;color:var(--sf-text);}
.input:focus-within{outline:3px solid #0867ff40;outline-offset:2px;border-color:var(--sf-blue);}
.input[aria-invalid=true]{border-color:#a53532;background:#fff0ef80;}
.field-error{display:block;color:#a53532;font-size:14px;line-height:21px;margin-top:9px;}
.form-note{display:block;font-size:13px;color:var(--sf-muted);line-height:21px;padding:14px 4px;}
.footer{margin-top:auto;padding-top:30px;}
.submit-btn{min-height:48px;background:var(--sf-blue);color:#fff;border-radius:15px;font-size:16px;font-weight:650;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 15px #0867ff1f;}
.submit-btn::after{border:0;}.submit-btn[disabled]{background:var(--sf-blue);color:#fff;opacity:.5;box-shadow:none;}.submit-btn:focus-visible{outline:3px solid var(--sf-blue);outline-offset:4px;}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.form-content{background:#f5f8fc;}}
@media(min-width:420px){.container{padding-left:20px;padding-right:20px;}}
@media(forced-colors:active){.form-content,.submit-btn{border:1px solid CanvasText;}}
</style>
