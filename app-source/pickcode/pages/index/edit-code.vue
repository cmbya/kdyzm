<template>
  <view class="page-wrapper sf-page">
    <view class="container">
      <view class="form-content sf-surface">
        <!-- 取件码 -->
        <view class="form-item">
          <label class="label" for="pickup-edit-code">取件码</label>
          <input id="pickup-edit-code" class="input" v-model="form.code" placeholder="请输入取件码" />
        </view>
        <!-- 物流公司 -->
        <view class="form-item">
          <label class="label" for="pickup-edit-company">物流公司</label>
          <input id="pickup-edit-company" class="input" v-model="form.company" placeholder="请输入物流公司名称" />
        </view>
        <!-- 标签 -->
        <view class="form-item">
          <text class="label">标签</text>
          <view class="tag-list">
            <button
              v-for="tag in tagOptions"
              :key="tag"
              class="tag"
              :class="{ selected: form.tags.includes(tag) }"
              role="button" tabindex="0" :aria-pressed="form.tags.includes(tag)"
              @click="toggleTag(tag)"
              @keydown.enter.prevent="!$event.repeat && toggleTag(tag)"
              @keydown.space.prevent="$event.preventDefault()" @keyup.space.prevent="toggleTag(tag)"
              @longpress="deleteTag(tag)"
            >
              {{ tag }}
            </button>
          </view>
          <text class="tag-tip">长按标签可删除</text>
          <view class="custom-tag-row">
            <input
              class="input tag-input"
              v-model="customTag"
              placeholder="自定义标签"
              aria-label="自定义标签"
              @confirm="addCustomTag"
              :disabled="tagOptions.length >= 10"
            />
            <button class="add-tag-btn" role="button" tabindex="0" @click="addCustomTag" :disabled="tagOptions.length >= 10">添加</button>
          </view>
          <view v-if="tagOptions.length >= 10" class="tag-limit-tip">最多只能设置10个标签</view>
        </view>
        <!-- 备注 -->
        <view class="form-item">
          <label class="label" for="pickup-edit-remark">备注</label>
          <textarea id="pickup-edit-remark" class="textarea" v-model="form.remark" placeholder="请输入备注（可选）" />
        </view>
        <!-- 是否标记已取 -->
        <view class="form-item picked-row">
          <text class="label">标记已取</text>
          <switch class="picked-switch" aria-label="标记已取" color="#0867ff" :checked="form.isPicked" @change="handlePickedChange" />
        </view>
      </view>
      <view class="footer">
        <button class="submit-btn" :disabled="saving || !itemId" @click="submit">{{ saving ? '保存中' : '保存' }}</button>
      </view>
    </view>
  </view>
</template>

<script>
import { getSnapshot, mutate } from '@/services/assistant.js';
import { itemPatch } from '@/services/item-patch.js';
export default {
  data() {
    return {
      form: {
        code: '',
        company: '',
        tags: [],
        remark: '',
        isPicked: false,
      },
      tagOptions: [], // 初始化为空，onLoad时从本地获取
      customTag: '',
      editIndex: null,
      deletedTags: [],
      itemId: '',
      saving: false,
      originalForm: {},
    };
  },
  async onLoad(options) {
    // 先从本地缓存加载标签
    const localTags = uni.getStorageSync('globalTagOptions');
    if (localTags) {
      this.tagOptions = JSON.parse(localTags);
    } else {
      this.tagOptions = ['家', '公司', '老家', '生鲜', '私密'];
    }
    // eventChannel 初始化
    const eventChannel = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (eventChannel) {
      eventChannel.on && eventChannel.on('editCodeInit', ({ item, index }) => {
        this.form = {
          code: item.code || '',
          company: item.company || '',
          tags: item.tags || [],
          remark: item.remark || '',
          isPicked: item.isPicked || false,
        };
        this.editIndex = index;
      });
    }
    // 兼容参数方式
    if (options.item) {
      const item = JSON.parse(decodeURIComponent(options.item));
      this.form = {
        code: item.code || '',
        company: item.company || '',
        tags: item.tags || [],
        remark: item.remark || '',
        isPicked: item.isPicked || false,
      };
      this.editIndex = options.index || null;
    }
    if (options.id) {
      try {
        const snapshot = await getSnapshot();
        const item = snapshot.codes.find(value => value.id === options.id);
        if (!item) throw new Error('记录不存在或已被忽略');
        this.itemId = item.id;
        this.form = { code: item.code, company: item.company, tags: [...item.tags], remark: item.remark, isPicked: item.isPicked };
        this.originalForm = JSON.parse(JSON.stringify(this.form));
      } catch (error) { uni.showToast({ title: error.message, icon: 'none' }); }
    }
  },
  methods: {
    vibrateShort() {
      if (uni && uni.vibrateShort) {
        uni.vibrateShort();
      }
    },
    toggleTag(tag) {
      this.vibrateShort();
      const idx = this.form.tags.indexOf(tag);
      if (idx > -1) {
        this.form.tags.splice(idx, 1);
      } else {
        this.form.tags.push(tag);
      }
    },
    deleteTag(tag) {
      this.vibrateShort();
      uni.showModal({
        title: '删除标签',
        content: `确定要删除标签"${tag}"吗？`,
        confirmText: '删除',
        confirmColor: '#ff4d4f',
        success: (res) => {
          if (res.confirm) {
            this.tagOptions = this.tagOptions.filter(t => t !== tag);
            uni.setStorageSync('globalTagOptions', JSON.stringify(this.tagOptions));
            this.form.tags = this.form.tags.filter(t => t !== tag);
            if (!this.deletedTags.includes(tag)) this.deletedTags.push(tag);
          }
        }
      });
    },
    addCustomTag() {
      this.vibrateShort();
      const tag = this.customTag.trim();
      if (this.tagOptions.length >= 10) {
        uni.showToast({ title: '最多只能设置10个标签', icon: 'none' });
        return;
      }
      if (tag && !this.tagOptions.includes(tag)) {
        this.tagOptions.push(tag);
        uni.setStorageSync('globalTagOptions', JSON.stringify(this.tagOptions));
      }
      if (tag && !this.form.tags.includes(tag)) {
        this.form.tags.push(tag);
      }
      this.customTag = '';
    },
    async submit() {
      this.vibrateShort();
      if (!this.form.code) {
        uni.showToast({ title: '请输入取件码', icon: 'none' });
        return;
      }
      if (!this.itemId || this.saving) return;
      this.saving = true;
      try {
        await mutate('update', { id: this.itemId, patch: itemPatch(this.originalForm, this.form) });
        for (const tag of this.deletedTags) await mutate('clearTag', { tag });
        uni.navigateBack();
      } catch (error) { uni.showToast({ title: error.message, icon: 'none' }); }
      finally { this.saving = false; }
    },
    handlePickedChange(e) {
      this.vibrateShort();
      this.form.isPicked = e.detail.value;
    },
  },
};
</script>

<style lang="scss" scoped>
.page-wrapper { min-height:100vh; color:var(--sf-text); }
.container { min-height:100vh; box-sizing:border-box; padding:18px 16px calc(24px + env(safe-area-inset-bottom)); display:flex; flex-direction:column; gap:20px; }
.form-content { border-radius:24px; padding:20px 16px; }
.form-item { margin-bottom:22px; }
.form-item:last-child { margin-bottom:0; }
.label { display:block; margin-bottom:8px; color:var(--sf-text); font-size:.9375rem; font-weight:550; line-height:1.5; }
.input, .textarea { width:100%; min-width:0; box-sizing:border-box; border:1px solid #bdcbdc; border-radius:13px; padding:11px 12px; background:rgba(255,255,255,.43); color:var(--sf-text); font-size:1rem; line-height:1.5; }
.input { height:48px; }
.textarea { min-height:116px; }
.tag-list { display:flex; flex-wrap:wrap; gap:8px; }
.tag { min-height:44px; margin:0; padding:10px 14px; border:1px solid #bdcbdc; border-radius:12px; background:rgba(255,255,255,.35); color:var(--sf-muted); font-size:.875rem; line-height:1.5; }
.tag.selected { border-color:var(--sf-blue); background:var(--sf-blue); color:white; }
.custom-tag-row { display:flex; align-items:center; gap:10px; margin-top:14px; }
.tag-input { flex:1; min-width:0; }
.add-tag-btn { flex:none; min-height:46px; margin:0; padding:11px 17px; border-radius:12px; background:#e2edfc; color:var(--sf-blue); font-size:.9375rem; line-height:1.5; }
.picked-row { display:flex; align-items:center; justify-content:space-between; gap:15px; }
.picked-row .label { margin:0; }
.picked-switch { flex:none; }
.tag-tip, .tag-limit-tip { display:block; margin-top:8px; color:var(--sf-muted); font-size:.8125rem; line-height:1.6; }
.tag-limit-tip { color:#a8443c; }
.footer { margin-top:auto; }
.submit-btn { min-height:50px; margin:0; padding:12px; display:flex; align-items:center; justify-content:center; border-radius:15px; background:var(--sf-blue); color:white; box-shadow:inset 0 1px 1px #ffffff3b, 0 5px 14px #0867ff17; font-size:1rem; font-weight:650; line-height:1.5; }
button::after { border:0; }
button[disabled] { opacity:.5; }
button:focus-visible, .input:focus-within, .textarea:focus-within { outline:2px solid var(--sf-blue); outline-offset:3px; }
@media(min-width:420px) { .container { padding-inline:20px; } }
@media(forced-colors:active) { .tag, .submit-btn, .add-tag-btn { border:1px solid ButtonText; } }
</style>
