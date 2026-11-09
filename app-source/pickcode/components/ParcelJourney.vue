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
      <view class="journey-road-scene">
      <svg class="journey-road-map" viewBox="0 0 390 190" preserveAspectRatio="none" fill="none" role="img" :aria-label="roadSegments.map(segment => segment.label + '：' + segment.text).join('，')">
        <defs>
          <linearGradient :id="roadId + '-surface'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bdcad6" /><stop offset="1" stop-color="#97aaba" /></linearGradient>
          <path v-for="(segment, index) in roadSegments" :id="roadId + '-' + segment.key" :key="segment.key" :d="'M' + coordinates(curves[index][0]) + ' ' + command(curves[index])" />
        </defs>
        <g transform="translate(0,49)">
        <g class="journey-map-blocks" stroke="#f9fcff" stroke-width=".55" stroke-dasharray="1 1">
          <path d="M3 43 19 29 45 32 57 44 40 49Z M62 28 88 18 98 25 80 40 66 37Z M103 33 122 21 145 28 143 43 122 45Z M151 23 175 17 187 29 178 41 155 41Z M194 32 215 21 235 28 226 45 210 43Z M250 23 267 19 278 31 265 43 251 39Z M290 33 315 20 326 27 319 40 299 45Z M335 34 360 23 374 30 371 42 349 47Z" />
        </g>
        </g>
        <g transform="translate(0,68)">
          <path class="journey-road-shadow" :d="roadPath" stroke-width="44" transform="translate(0,2)" />
          <path class="journey-road-edge" :d="roadPath" stroke-width="42" />
          <path class="journey-road-surface" :d="roadPath" :stroke="'url(#' + roadId + '-surface)'" stroke-width="38" />
          <path v-if="progressPath" class="journey-progress" :d="progressPath" stroke-width="38" />
          <path class="journey-road-lane" :d="roadPath" stroke-width="1.2" stroke-dasharray="7 6" />
        </g>
        <g v-for="segment in roadSegments" :key="segment.key" class="journey-road-interval">
          <!-- Keep SVG text native: uni-app compiles a literal text tag to uni-text. -->
          <component :is="'text'" class="journey-road-duration" :class="{ 'journey-road-duration-long': segment.text.length > 8 }" transform="translate(0,82)" text-anchor="middle"><textPath :href="'#' + roadId + '-' + segment.key" startOffset="50%">{{ segment.text }}</textPath></component>
          <component :is="'text'" class="journey-road-label" transform="translate(0,110)" text-anchor="middle"><textPath :href="'#' + roadId + '-' + segment.key" startOffset="50%">{{ segment.label }}</textPath></component>
        </g>
      </svg>
      <view v-if="activeIndex >= 0" :key="activeIndex" class="journey-car-position" :class="{ 'journey-car-complete': journey.completed }" :style="carStyle">
        <view class="journey-car-body">
          <image class="journey-car" src="/static/images/parcel-journey-car.png" mode="aspectFit" aria-hidden="true" />
          <text v-if="journey.carrier" class="journey-carrier" :aria-label="'承运商 ' + journey.carrier">{{ journey.carrier }}</text>
        </view>
      </view>
      <view v-for="(point, index) in points" :key="point.key" class="journey-stage" :class="pointClass(point)" :style="{ left: positions[index].x / 390 * 100 + '%', height: (positions[index].y + 47) / 190 * 100 + '%' }" :aria-label="point.label + '，' + (point.state === 'pending' ? '未到达' : '已到达') + '，' + point.text">
        <view class="journey-sign-post" aria-hidden="true" />
        <view class="journey-sign-foot" aria-hidden="true" />
        <text class="journey-stage-label">{{ point.label }}</text>
        <view class="journey-stage-time"><text v-for="(line, lineIndex) in signTime(point)" :key="lineIndex">{{ line }}</text></view>
      </view>
      </view>
    </template>
  </view>
</template>

<script>
import { parcelJourneyProgress, parcelJourneySegments } from '@/services/parcel-journey.js';
const stages = [{ key: 'order', label: '下单' }, { key: 'ship', label: '发货' }, { key: 'arrival', label: '到货' }, { key: 'pickup', label: '取件' }];
const durations = [{ key: 'waiting', label: '待发货' }, { key: 'transit', label: '运输' }, { key: 'pickup', label: '待取' }];
const positions = [{ x: 34, y: 61 }, { x: 141, y: 65 }, { x: 248, y: 58 }, { x: 356, y: 66 }];
const curves = [
  [positions[0], { x: 80, y: 60 }, { x: 109, y: 63 }, positions[1]],
  [positions[1], { x: 173, y: 67 }, { x: 208, y: 65 }, positions[2]],
  [positions[2], { x: 288, y: 51 }, { x: 316, y: 69 }, positions[3]]
];
const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const coordinates = point => `${Number(point.x.toFixed(3))} ${Number(point.y.toFixed(3))}`;
const command = curve => `C${curve.slice(1).map(coordinates).join(' ')}`;
let nextRoadId = 0;
function partialCurve(curve, t) {
  const a = mix(curve[0], curve[1], t), b = mix(curve[1], curve[2], t), c = mix(curve[2], curve[3], t);
  const d = mix(a, b, t), e = mix(b, c, t);
  return [curve[0], a, d, mix(d, e, t)];
}
function curvePosition(value) {
  const index = Math.min(2, Math.floor(value));
  return partialCurve(curves[index], value - index).at(-1);
}
// All mounted road cards share one minute timer; summary cards need no clock.
const clockListeners = new Set();
let clockTimer;
function subscribeClock(listener) {
  clockListeners.add(listener);
  if (clockTimer === undefined) clockTimer = setInterval(() => {
    const now = Date.now();
    clockListeners.forEach(update => update(now));
  }, 60000);
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && clockTimer !== undefined) { clearInterval(clockTimer); clockTimer = undefined; }
  };
}
const icons = {
  order: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 4h6M9 11h6M9 15h4',
  ship: 'M3 5h12v12H3V5Zm12 5h4l3 4v3h-7M16 10v4h6M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm12 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  arrival: 'M5 10v10h14V10M3 10l3-6h12l3 6c0 3-4 3-5 0-1 3-7 3-8 0-1 3-5 3-5 0ZM9 20v-5h6v5',
  pickup: 'M10 2h8v7h-8V2Zm4 0v3M3 16h4l3-3h6c2 0 2 3 0 3h-4M16 16l4-3c2-1 4 1 2 3l-7 5H8l-3-1H2v-4'
};
export default {
  props: { journey: { type: Object, default: () => ({}) }, mode: { type: String, default: 'road' } },
  data: () => ({ clockNow: Date.now(), stopClock: null, roadId: `parcel-road-${++nextRoadId}` }),
  mounted() { this.syncClock(); },
  beforeUnmount() { this.stopClock?.(); },
  watch: { clockNeeded() { this.syncClock(); } },
  computed: {
    positions() { return positions; },
    curves() { return curves; },
    icons() { return icons; },
    roadPath() { return `M-8 61 C6 61 21 61 34 61 ${curves.map(command).join(' ')} C370 66 384 65 398 65`; },
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
    roadSegments() {
      return parcelJourneySegments(this.journey, this.clockNow).map((segment, index) => {
        const text = /[天时]/.test(segment.text) ? segment.text.replace(/\d+分$/, '') : segment.text;
        return { ...segment, label: ['发货时间', '运输时间', '取件时间'][index], text: (segment.ongoing && text !== '—' ? '已用' : '') + text };
      });
    },
    activeIndex() { const index = this.journey.currentIndex; return Number.isInteger(index) && index >= 0 && index < 4 ? index : -1; },
    clockNeeded() { return this.mode === 'road' && !this.journey.completed && this.activeIndex >= 0 && this.activeIndex < 3; },
    progress() { return parcelJourneyProgress(this.journey, this.clockNow); },
    progressPath() {
      if (this.progress <= 0) return '';
      const index = Math.floor(this.progress), complete = curves.slice(0, index).map(command);
      if (index < 3 && this.progress > index) complete.push(command(partialCurve(curves[index], this.progress - index)));
      return `M${coordinates(positions[0])} ${complete.join(' ')}`;
    },
    carStyle() {
      if (this.progress < 0) return {};
      const point = curvePosition(this.progress);
      // Wheel contacts sit inside the upper lane, 8 units above its divider.
      return { left: point.x / 390 * 100 + '%', top: (point.y + 60) / 190 * 100 + '%' };
    }
  },
  methods: {
    coordinates,
    command,
    signTime(point) { return point.at ? point.text.split(' ') : ['—']; },
    syncClock() {
      this.stopClock?.(); this.stopClock = null;
      if (this.clockNeeded) { this.clockNow = Date.now(); this.stopClock = subscribeClock(now => { this.clockNow = now; }); }
    },
    pointClass(point) { return { 'journey-point-pending': point.state === 'pending', 'journey-point-teal': point.state === 'current' || point.key === 'pickup' && point.state === 'done' }; }
  }
};
</script>

<style scoped lang="scss">
.parcel-journey{position:relative;width:100%;min-width:0;box-sizing:border-box;color:#24394f;font-variant-numeric:tabular-nums;}
.journey-road{height:190px;min-height:190px;}
.journey-road-scene{position:absolute;inset:0;}
.journey-road-map{position:absolute;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none;}
.journey-map-blocks{fill:#dbe5ed;opacity:.46;}
.journey-road-shadow{stroke:#9eb2c6;opacity:.3;}.journey-road-edge{stroke:#f5f8fc;}.journey-road-lane{stroke:#fff;}
.journey-progress{stroke:#397cbb;opacity:.36;}
.journey-road-duration{fill:#fff;font-size:14px;font-weight:750;paint-order:stroke;stroke:#536f89;stroke-width:.45px;}.journey-road-duration-long{font-size:12px;}
.journey-road-label{fill:#455e7a;font-size:14px;font-weight:700;}
.journey-stage{position:absolute;top:0;transform:translateX(-50%);width:16%;max-width:62px;text-align:center;}
.journey-sign-post{position:absolute;top:3px;bottom:2px;left:50%;transform:translateX(-50%);width:6px;border:1px solid #9eaab7;border-radius:3px;background:linear-gradient(90deg,#7e8c9a,#f4f7fa 43%,#a4afba 74%,#758291);box-shadow:1px 0 1px #ffffffbf;}
.journey-sign-foot{position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:16px;height:5px;border:1px solid #99a6b3;border-radius:50% / 35%;background:linear-gradient(90deg,#9daab6,#eef3f8 45%,#8c9ba8);box-shadow:1px 2px 2px #50677933;}
.journey-stage-label,.journey-stage-time{position:relative;box-sizing:border-box;display:flex;align-items:center;justify-content:center;white-space:nowrap;border:1px solid #899eb4;box-shadow:inset 0 0 0 1px #f5f9ffbf,0 2px 1px #7790ab45;}
.journey-stage-label{height:26px;margin-top:8px;border-radius:8px;background:linear-gradient(#4b8cd9 0%,#1b68bf 32%,#1253a8 76%,#2d71ba);font-size:14px;font-weight:750;line-height:1.2;color:#fff;text-shadow:0 1px 1px #173d70;}
.journey-stage-time{flex-direction:column;min-height:29px;margin:3px 2px 0;border-radius:7px;background:linear-gradient(135deg,#fff,#e2e8f0);font-size:11px;font-weight:700;line-height:13px;color:#19477e;}
.journey-stage-time>text{display:block;}
.journey-point-pending .journey-stage-label{background:linear-gradient(#a4aab2,#7b8590 40%,#66717d);border-color:#949da6;color:#f5f6f7;text-shadow:0 1px 1px #555e68;}
.journey-point-pending .journey-stage-time{background:linear-gradient(135deg,#f5f5f5,#dedfe1);border-color:#a8adb2;color:#717981;box-shadow:inset 0 0 0 1px #ffffffb3,0 2px 1px #7d879140;}
.journey-point-teal .journey-stage-label{background:linear-gradient(#62b8a8,#278f81 35%,#177667 78%,#3a9e8b);border-color:#7eaaa2;text-shadow:0 1px 1px #185d51;}
.journey-point-teal .journey-stage-time{border-color:#91b6ab;background:linear-gradient(135deg,#f8fffc,#deeee8);color:#146d60;}
.journey-car-position{position:absolute;z-index:1;width:17%;max-width:72px;aspect-ratio:264/112;transform:translate(-50%,-100%);animation:journey-car-enter .8s cubic-bezier(.2,.65,.25,1) both;pointer-events:none;}
.journey-car-body{position:relative;width:100%;height:100%;transform-origin:50% 85%;animation:journey-car-rock .8s ease-in-out .8s 4;}
.journey-car{display:block;width:100%;height:100%;}
.journey-carrier{position:absolute;top:-17px;left:50%;transform:translateX(-50%);box-sizing:border-box;width:max-content;max-width:calc(100% + 10px);padding:0 3px;border:1px solid #9fb4c9;border-radius:5px;background:#f5f9fff5;box-shadow:0 1px 2px #526d8530;color:#21516d;font-size:10px;font-weight:650;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.journey-car-complete .journey-car-body{animation:none;}
@keyframes journey-car-enter{from{opacity:0;transform:translate(calc(-50% - 22px),calc(-100% + 3px));}to{opacity:1;transform:translate(-50%,-100%);}}
@keyframes journey-car-rock{0%,100%{transform:translateY(0) rotate(0);}30%{transform:translateY(-1.2px) rotate(-1.5deg);}65%{transform:translateY(.5px) rotate(1deg);}}
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
@media(prefers-reduced-motion:reduce){.journey-car-position,.journey-car-body{animation:none;}}
@media(forced-colors:active){.journey-road-surface{stroke:CanvasText;}.journey-progress{stroke:Highlight;}.journey-road-duration{fill:Canvas;stroke:none;}.journey-road-label{fill:CanvasText;}.journey-stage-label,.journey-stage-time,.journey-time-block{border-color:ButtonBorder;color:CanvasText;background:Canvas;text-shadow:none;}.journey-point-pending .journey-stage-label,.journey-point-pending .journey-stage-time{color:GrayText;}.journey-map-blocks{opacity:.2;}}
</style>
