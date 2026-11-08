<template>
  <view class="parcel-journey" :class="'journey-' + mode" role="group" aria-label="包裹时间进度">
    <template v-if="mode === 'summary'">
      <view class="journey-time-grid">
        <view v-for="point in points" :key="point.key" class="journey-time-block" :class="pointClass(point)">
          <text class="journey-summary-label">{{ point.label }}</text>
          <text class="journey-summary-time">{{ point.text }}</text>
          <svg class="journey-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="icons[point.key]" /></svg>
        </view>
      </view>
      <view class="journey-summary-durations">
        <view v-for="segment in segments" :key="segment.key" class="journey-duration" :class="'duration-' + segment.key">
          <text class="journey-duration-label"><text class="journey-duration-dot" />{{ segment.label }}</text>
          <text class="journey-duration-value">{{ segment.text }}</text>
        </view>
      </view>
    </template>
    <template v-else>
      <view class="journey-road-durations">
        <view v-for="segment in roadSegments" :key="segment.key" class="journey-duration-badge" :class="'duration-' + segment.key">
          <text>{{ segment.label }}</text><text class="journey-badge-value">{{ segment.text }}</text>
        </view>
      </view>
      <svg class="journey-road-map" viewBox="0 0 390 146" preserveAspectRatio="none" fill="none" aria-hidden="true">
        <g class="journey-map-blocks" stroke="#f9fcff" stroke-width=".55" stroke-dasharray="1 1">
          <path d="M3 43 19 29 45 32 57 44 40 49Z M62 28 88 18 98 25 80 40 66 37Z M103 33 122 21 145 28 143 43 122 45Z M151 23 175 17 187 29 178 41 155 41Z M194 32 215 21 235 28 226 45 210 43Z M250 23 267 19 278 31 265 43 251 39Z M290 33 315 20 326 27 319 40 299 45Z M335 34 360 23 374 30 371 42 349 47Z" />
          <path class="journey-map-green" d="M7 64 21 61 32 67 24 72Z M224 62 240 57 253 64 242 69Z M327 63 344 68 357 65 345 60Z" />
        </g>
        <path class="journey-road-edge" :d="roadPath" stroke-width="19" />
        <path class="journey-road-surface" :d="roadPath" stroke-width="15" />
        <path class="journey-road-lane" :d="roadPath" stroke-width="1.2" stroke-dasharray="7 6" />
        <path class="journey-progress-base" d="M34 61 C80 60 109 63 141 65 S208 65 248 58 S316 69 356 66" stroke-width="1.3" />
        <path v-if="progressPath" class="journey-progress" :d="progressPath" stroke-width="1.5" />
        <g v-for="(point, index) in points" :key="point.key" :class="pointClass(point)">
          <path class="journey-stage-stem" :d="'M' + positions[index].x + ' ' + positions[index].y + ' V79'" stroke-width="1" />
          <circle class="journey-stage-pin" :cx="positions[index].x" :cy="positions[index].y" r="1.8" stroke-width="1" />
        </g>
      </svg>
      <view v-if="activeIndex >= 0" :key="activeIndex" class="journey-car-position" :class="{ 'journey-car-complete': journey.completed }" :style="carStyle" aria-hidden="true">
        <image class="journey-car" src="/static/images/parcel-journey-car.png" mode="aspectFit" />
      </view>
      <view v-for="(point, index) in points" :key="point.key" class="journey-stage" :class="pointClass(point)" :style="{ left: positions[index].x / 390 * 100 + '%' }">
        <view class="journey-stage-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path :d="icons[point.key]" /></svg></view>
        <text class="journey-stage-label">{{ point.label }}</text>
        <text class="journey-stage-time">{{ point.text }}</text>
      </view>
    </template>
  </view>
</template>

<script>
const stages = [{ key: 'order', label: '下单' }, { key: 'ship', label: '发货' }, { key: 'arrival', label: '到货' }, { key: 'pickup', label: '取件' }];
const durations = [{ key: 'waiting', label: '待发货' }, { key: 'transit', label: '运输' }, { key: 'pickup', label: '待取' }];
const positions = [{ x: 34, y: 61 }, { x: 141, y: 65 }, { x: 248, y: 58 }, { x: 356, y: 66 }];
const paths = ['', 'M34 61 C80 60 109 63 141 65', 'M34 61 C80 60 109 63 141 65 S208 65 248 58', 'M34 61 C80 60 109 63 141 65 S208 65 248 58 S316 69 356 66'];
const icons = {
  order: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 4h6M9 11h6M9 15h4',
  ship: 'M3 5h12v12H3V5Zm12 5h4l3 4v3h-7M16 10v4h6M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm12 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  arrival: 'M5 10v10h14V10M3 10l3-6h12l3 6c0 3-4 3-5 0-1 3-7 3-8 0-1 3-5 3-5 0ZM9 20v-5h6v5',
  pickup: 'M10 2h8v7h-8V2Zm4 0v3M3 16h4l3-3h6c2 0 2 3 0 3h-4M16 16l4-3c2-1 4 1 2 3l-7 5H8l-3-1H2v-4'
};
export default {
  props: { journey: { type: Object, default: () => ({}) }, mode: { type: String, default: 'road' } },
  computed: {
    positions() { return positions; },
    icons() { return icons; },
    roadPath() { return 'M-8 53 C35 50 94 52 141 57 S207 59 248 51 S316 66 398 58'; },
    points() {
      const values = Array.isArray(this.journey.points) ? this.journey.points : [];
      return stages.map(stage => {
        const value = values.find(point => point && point.key === stage.key) || {};
        return { ...stage, ...value, text: value.text || (stage.key === 'pickup' ? '待取件' : '待获取'), state: ['done', 'current'].includes(value.state) ? value.state : 'pending' };
      });
    },
    segments() {
      const values = Array.isArray(this.journey.segments) ? this.journey.segments : [];
      return durations.map(segment => {
        const value = values.find(item => item && item.key === segment.key) || {};
        return { ...segment, ...value, text: value.text || '—' };
      });
    },
    roadSegments() { return this.segments.filter(segment => segment.key !== 'pickup' && segment.text !== '—'); },
    activeIndex() { const index = this.journey.currentIndex; return Number.isInteger(index) && index >= 0 && index < 4 ? index : -1; },
    progressPath() { return paths[this.activeIndex] || ''; },
    carStyle() { const point = positions[this.activeIndex]; return point ? { left: point.x / 390 * 100 + '%', top: point.y - 6 + 'px' } : {}; }
  },
  methods: {
    pointClass(point) { return { 'journey-point-pending': point.state === 'pending', 'journey-point-teal': point.key === 'arrival' && point.state === 'current' || point.key === 'pickup' && point.state !== 'pending' }; }
  }
};
</script>

<style scoped lang="scss">
.parcel-journey{position:relative;width:100%;min-width:0;box-sizing:border-box;color:#24394f;font-variant-numeric:tabular-nums;}
.journey-road{height:146px;}
.journey-road-map{position:absolute;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none;}
.journey-map-blocks{fill:#dbe5ed;opacity:.46;}.journey-map-green{fill:#bbded3;}
.journey-road-edge{stroke:#f2f7fb;}.journey-road-surface{stroke:#b9cbdc;}.journey-road-lane{stroke:#fff;}
.journey-progress-base{stroke:#d0deeb;}.journey-progress{stroke:#418bc8;}
.journey-stage-stem{stroke:#b5d4eb;}.journey-stage-pin{stroke:#3284cc;fill:#f8fbff;}
.journey-point-pending .journey-stage-stem{stroke:#d3e0eb;}.journey-point-pending .journey-stage-pin{stroke:#8b9db2;}
.journey-point-teal .journey-stage-stem{stroke:#9ed8d0;}.journey-point-teal .journey-stage-pin{stroke:#138e81;}
.journey-road-durations{position:absolute;left:9.5%;right:6%;top:0;display:flex;gap:7px;align-items:center;z-index:1;white-space:nowrap;}
.journey-duration-badge{display:flex;align-items:baseline;gap:4px;border:1px solid #cddff1;background:#f6faffdb;border-radius:7px;padding:1px 5px;font-size:10px;line-height:15px;color:#58728c;}
.journey-badge-value{font-weight:700;font-size:11px;color:#6683a0;}.duration-transit .journey-badge-value{color:#0873df;}
.journey-stage{position:absolute;top:78px;transform:translateX(-50%);width:25%;text-align:center;}
.journey-stage-icon{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:25px;height:25px;margin:auto;border:1px solid #c3dcf4;border-radius:8px;background:#f5f9fde0;color:#0875df;}
.journey-stage-icon svg{width:18px;height:18px;}.journey-stage-label,.journey-stage-time{display:block;white-space:nowrap;}
.journey-stage-label{font-size:14px;font-weight:700;line-height:21px;margin-top:3px;color:#203d54;}
.journey-stage-time{font-size:12px;line-height:18px;color:#546e8c;}
.journey-point-pending .journey-stage-icon{border-color:#d8e4ef;color:#8092a9;background:#f3f7f987;}
.journey-point-pending .journey-stage-label,.journey-point-pending .journey-stage-time{color:#8292a6;}
.journey-point-teal .journey-stage-icon{color:#048778;border-color:#91d8cd;background:#d6f2eb;}
.journey-point-teal .journey-stage-time{color:#078c7b;}
.journey-car-position{position:absolute;z-index:1;width:17%;aspect-ratio:264/112;transform:translate(-50%,-100%);animation:journey-car-enter .65s cubic-bezier(.2,.65,.25,1) both;pointer-events:none;}
.journey-car{display:block;width:100%;height:100%;transform-origin:50% 85%;animation:journey-car-rock .65s ease-in-out .65s 3;}
.journey-car-complete .journey-car{animation:none;}
@keyframes journey-car-enter{from{opacity:0;transform:translate(calc(-50% - 14px),calc(-100% + 1px));}to{opacity:1;transform:translate(-50%,-100%);}}
@keyframes journey-car-rock{0%,100%{transform:translateY(0) rotate(0);}35%{transform:translateY(-.8px) rotate(-.7deg);}70%{transform:translateY(.3px) rotate(.5deg);}}
.journey-summary{padding-top:7px;border-top:1px solid #c5d6e9;}
.journey-time-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}
.journey-time-block{position:relative;min-width:0;box-sizing:border-box;min-height:38px;padding:2px 10px;border:1px solid #d1e1f2;border-radius:8px;background:#f9fbffe0;box-shadow:inset 0 0 0 1px #ffffffc4;}
.journey-summary-label,.journey-summary-time{display:block;line-height:16px;white-space:nowrap;}
.journey-summary-label{font-weight:700;font-size:12px;color:#20354d;}.journey-summary-time{font-size:12px;color:#526b88;}
.journey-summary-icon{position:absolute;right:12px;top:10px;width:16px;height:16px;color:#506e90;}
.journey-time-block.journey-point-pending .journey-summary-time{color:#8292a6;}
.journey-time-block.journey-point-teal{border-color:#94ddd0;background:linear-gradient(120deg,#ecfcf7dc,#d8f4eceb);}
.journey-point-teal .journey-summary-label,.journey-point-teal .journey-summary-time,.journey-point-teal .journey-summary-icon{color:#087e70;}
.journey-summary-durations{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:6px;padding-top:4px;border-top:1px solid #c8d9ea;}
.journey-duration{text-align:center;min-width:0;}.journey-duration-label,.journey-duration-value{display:block;white-space:nowrap;line-height:15px;font-size:11px;}
.journey-duration-label{font-weight:600;color:#405b77;}.journey-duration-value{color:#546f8e;}
.journey-duration-dot{display:inline-block;width:5px;height:5px;border-radius:1.5px;background:#9cb4d0;margin-right:4px;vertical-align:1px;}
.duration-transit .journey-duration-dot{background:#237efa;}.duration-pickup .journey-duration-dot{background:#43b6a6;}
@media(prefers-reduced-motion:reduce){.journey-car-position,.journey-car{animation:none;}}
@media(forced-colors:active){.journey-road-surface{stroke:GrayText;}.journey-progress,.journey-stage-stem{stroke:Highlight;}.journey-stage-pin{stroke:Highlight;fill:Canvas;}.journey-duration-badge,.journey-stage-icon,.journey-time-block{border-color:ButtonBorder;}.journey-map-blocks{opacity:.2;}}
</style>
