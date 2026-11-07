<template>
  <view class="pickup-stamp" :class="{ compact }" aria-hidden="true"><text>已取件</text></view>
</template>

<script>
export default { props: { compact: { type: Boolean, default: false } } };
</script>

<style scoped>
.pickup-stamp {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid #badad3;
  border-radius: 9px;
  background: #dcf2efb3;
  color: var(--sf-teal, #077370);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}
.pickup-stamp::before { content: '✓'; margin-right: 5px; }
.pickup-stamp.compact { min-height: 27px; padding: 3px 8px; font-size: 13px; }
</style>
