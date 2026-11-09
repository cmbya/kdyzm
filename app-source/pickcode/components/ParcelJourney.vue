<template>
  <view class="parcel-journey" :class="{ 'journey-collapsed': collapsed, 'journey-driving': driving, 'journey-reduced': reducedMotion }" role="group" aria-label="包裹时间进度">
    <view class="journey-road-region" :aria-hidden="collapsed ? 'true' : null"><view class="journey-region-inner">
      <view class="journey-road-scene">
        <svg class="journey-road-map" viewBox="0 0 2320 1200" fill="none" role="img" :aria-label="roadSegments.map(s => s.label + '：' + s.text).join('，')">
          <defs>
            <path v-for="(path, index) in paintPaths" :id="roadId + '-paint-' + index" :key="index" :d="path" />
            <pattern :id="roadId + '-grain'" width="31" height="23" patternUnits="userSpaceOnUse"><rect width="31" height="23" fill="white" /><circle cx="3" cy="7" r="2" fill="#888" /><circle cx="21" cy="18" r="1.4" fill="#777" /><path d="M12 1h3v2h-3zM25 9h2v3h-2z" fill="#bbb" /></pattern>
            <mask :id="roadId + '-ink'" maskUnits="userSpaceOnUse" x="0" y="800" width="2320" height="230"><rect y="800" width="2320" height="230" :fill="'url(#' + roadId + '-grain)'" /></mask>
            <clipPath :id="roadId + '-progress'" clipPathUnits="userSpaceOnUse"><rect :key="'clip-' + motionSerial" class="journey-progress-window" width="2320" height="1200" :style="progressStyle" /></clipPath>
            <clipPath v-for="(segment, index) in roadSegments" :id="roadId + '-reveal-' + index" :key="segment.key" clipPathUnits="userSpaceOnUse"><rect :key="motionSerial + '-' + segment.text" :class="{ 'journey-paint-reveal': paintAnimate }" :x="[0, 810, 1510][index]" y="800" :width="[840, 730, 810][index]" height="260" :style="{ transformOrigin: [0, 810, 1510][index] + 'px 0px' }" /></clipPath>
          </defs>
          <component :is="'image'" :href="asset('route/map.png')" x="0" y="0" width="2320" height="801" />
          <component :is="'image'" class="journey-road-surface" :href="asset('route/road.png')" x="0" y="733" width="2320" height="283" />
          <component :is="'image'" :href="asset('route/lane-marks.png')" x="23" y="796" width="2250" height="53" />
          <g v-if="progress >= 0" :clip-path="'url(#' + roadId + '-progress)'">
            <path class="journey-progress" d="M45 970 C330 956 610 973 844 984 S1280 977 1474 979 S1900 1005 2290 986" stroke="#318bd1" stroke-width="13" stroke-linecap="round" />
            <path d="M45 967 C330 953 610 970 844 981 S1280 974 1474 976 S1900 1002 2290 983" stroke="#8ed4ee" stroke-width="4" stroke-linecap="round" />
          </g>
          <g v-for="(point, index) in points" :key="point.key" class="journey-stage" :class="pointClass(point, index)" :aria-label="point.label + '，' + (lit(point, index) ? '已到达' : '未到达') + '，' + point.text">
            <component :is="'image'" :href="asset('stations/contact-shadow.png')" :x="stations[index].x + 31" :y="stations[index].y + 594" width="330" height="48" />
            <component :is="'image'" :href="asset('stations/gray.png')" :x="stations[index].x" :y="stations[index].y" width="386" height="628" />
            <component :is="'image'" class="journey-station-color" :class="{ lit: lit(point, index) }" :href="asset('stations/' + (index === 0 ? 'blue' : 'green') + '.png')" :x="stations[index].x" :y="stations[index].y" width="386" height="628" />
            <component :is="'text'" class="journey-stage-label" :x="stations[index].x + 193" :y="stations[index].y + 168" dominant-baseline="central" text-anchor="middle">{{ point.label }}</component>
            <g :key="point.key + '-' + lit(point, index) + '-' + point.text" class="journey-stage-time" :class="{ 'journey-time-reveal': paintAnimate && lit(point, index) }">
              <component :is="'text'" v-for="(line, lineIndex) in signTime(point, index)" :key="lineIndex" :x="stations[index].x + 193" :y="stations[index].y + (signTime(point, index).length === 1 ? 316 : 278 + lineIndex * 75)" dominant-baseline="central" text-anchor="middle">{{ line }}</component>
            </g>
          </g>
          <g v-for="(segment, index) in roadSegments" :key="segment.key" class="journey-road-interval">
            <g :key="segment.text" :clip-path="paintAnimate ? 'url(#' + roadId + '-reveal-' + index + ')' : null">
              <component :is="'text'" class="journey-road-duration" :class="{ 'journey-road-duration-long': segment.text.length > 9 }" transform="translate(130,137) skewX(-8) scale(1,.85)" :mask="'url(#' + roadId + '-ink)'" text-anchor="middle"><textPath :href="'#' + roadId + '-paint-' + index" startOffset="50%" :textLength="segment.text.length > 9 ? 590 : null" lengthAdjust="spacingAndGlyphs">{{ segment.text }}</textPath></component>
            </g>
            <component :is="'text'" class="journey-road-label" :x="[490, 1162, 1850][index]" y="1115" dominant-baseline="central" text-anchor="middle">{{ segment.label }}</component>
          </g>
          <g v-if="progress >= 0" :key="'car-' + motionSerial" class="journey-car-position" :style="carStyle">
            <component :is="'image'" :href="asset('vehicle/contact-shadow.png')" x="-212" y="-13" width="425" height="45" />
            <g transform="translate(-216,-187) scale(.931)">
              <g class="journey-trailer">
                <component :is="'image'" :href="asset('vehicle/empty-trailer.png')" x="0" y="89" width="215" height="112" />
                <component :is="'image'" class="journey-parcel" :href="asset('vehicle/parcel.png')" x="20" y="14" width="156" height="100" />
                <g transform="translate(75,164)"><g class="journey-wheel-spin"><path d="M-13 0H13M0-13V13" stroke="#d9d5cc" stroke-width="4" opacity=".65" /></g></g>
              </g>
              <component :is="'image'" class="journey-car" :href="asset('vehicle/car.png')" x="215" y="0" width="249" height="201" />
              <g v-for="x in [263, 407]" :key="x" :transform="'translate(' + x + ',163)'" ><g class="journey-wheel-spin"><path d="M-13 0H13M0-13V13" stroke="#d9d5cc" stroke-width="4" opacity=".65" /></g></g>
            </g>
            <g v-if="journey.carrier" class="journey-carrier" :aria-label="'承运商 ' + journey.carrier"><rect x="-142" y="-250" width="284" height="60" rx="22" fill="#f8fbff" stroke="#91aec8" stroke-width="6" /><component :is="'text'" x="0" y="-218" dominant-baseline="central" text-anchor="middle" :font-size="journey.carrier.length > 5 ? 40 : 48">{{ journey.carrier }}</component></g>
          </g>
        </svg>
      </view>
    </view></view>
    <view class="journey-summary-region" :aria-hidden="!collapsed ? 'true' : null"><view class="journey-region-inner"><view class="journey-summary">
      <view class="journey-time-grid"><view v-for="(point, index) in points" :key="point.key" class="journey-time-block" :class="pointClass(point, index)"><text class="journey-summary-label">{{ point.label }}</text><text class="journey-summary-time">{{ point.at ? point.text : '—' }}</text></view></view>
      <view class="journey-summary-durations"><view v-for="segment in roadSegments" :key="segment.key" class="journey-duration"><text class="journey-duration-label">{{ segment.label }}</text><text class="journey-duration-value">{{ segment.value }}</text></view></view>
    </view></view></view>
  </view>
</template>

<script>
import { parcelJourneyProgress, parcelJourneySegments } from '@/services/parcel-journey.js';
const stages = [{ key: 'order', label: '下单' }, { key: 'ship', label: '发货' }, { key: 'arrival', label: '到货' }, { key: 'pickup', label: '取件' }];
const stations = [{ x: 35, y: 131 }, { x: 651, y: 141 }, { x: 1281, y: 128 }, { x: 1891, y: 144 }];
const positions = [{ x: 228, y: 800 }, { x: 844, y: 822 }, { x: 1474, y: 815 }, { x: 2084, y: 837 }];
const paintPaths = ['M150 913 Q490 918 825 930', 'M850 941 Q1150 946 1480 929', 'M1520 932 Q1850 958 2190 950'];
const ease = value => value * value * (3 - 2 * value);
function curvePosition(value) {
  const segment = Math.min(2, Math.max(0, Math.floor(value))), t = Math.max(0, value - segment);
  const a = positions[segment], b = positions[segment + 1];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * ease(t) + (segment === 1 ? Math.sin(t * Math.PI) * 5 : 0) };
}
const clockListeners = new Set();
let clockTimer, nextRoadId = 0;
function subscribeClock(listener) {
  clockListeners.add(listener);
  if (clockTimer === undefined) clockTimer = setInterval(() => { const now = Date.now(); clockListeners.forEach(update => update(now)); }, 60000);
  return () => { clockListeners.delete(listener); if (!clockListeners.size && clockTimer !== undefined) { clearInterval(clockTimer); clockTimer = undefined; } };
}
export default {
  props: { journey: { type: Object, default: () => ({}) }, mode: { type: String, default: 'road' } },
  emits: ['settled'],
  data() {
    const progress = parcelJourneyProgress(this.journey);
    return { clockNow: Date.now(), stopClock: null, roadId: `parcel-road-${++nextRoadId}`, progress,
      reached: Math.floor(progress), collapsed: this.mode === 'summary' || !!this.journey.completed,
      driving: false, paintAnimate: false, motionSerial: 0, motionFrom: progress, motionTo: progress, motionStarted: 0,
      reducedMotion: false, timers: [], motionQuery: null, motionListener: null };
  },
  mounted() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = this.motionQuery.matches;
      this.motionListener = event => { this.reducedMotion = event.matches; if (event.matches) this.snap(); };
      this.motionQuery.addEventListener?.('change', this.motionListener);
    }
    this.syncClock();
  },
  beforeUnmount() { this.cancelMotion(); this.stopClock?.(); this.motionQuery?.removeEventListener?.('change', this.motionListener); },
  watch: {
    eventStamp() { this.updateJourney(); },
    clockNeeded() { this.syncClock(); },
  },
  computed: {
    stations() { return stations; }, paintPaths() { return paintPaths; },
    points() { return stages.map(stage => ({ ...stage, state: 'pending', at: null, text: '—', ...(this.journey.points || []).find(point => point?.key === stage.key) })); },
    eventStamp() { return [this.journey.currentIndex, this.journey.completed, ...this.points.map(point => point.at)].join('|'); },
    clockNeeded() { return !this.journey.completed && this.mode !== 'summary' && this.journey.currentIndex >= 0 && this.journey.currentIndex < 3; },
    roadSegments() { return parcelJourneySegments(this.journey, this.clockNow).map((segment, index) => ({ ...segment, label: ['发货时间', '运输时间', '取件时间'][index], value: segment.text, text: segment.text === '—' ? '—' : '已用' + segment.text })); },
    motionSamples() { return [0, .2, .4, .6, .8, 1].map(t => curvePosition(this.motionFrom + (this.motionTo - this.motionFrom) * ease(t))); },
    carStyle() {
      const target = curvePosition(Math.max(0, this.progress)), style = { transform: `translate(${target.x}px,${target.y}px)` };
      this.motionSamples.forEach((point, index) => { style[`--drive-${index}`] = `translate(${point.x}px,${point.y}px)`; });
      return style;
    },
    progressStyle() {
      const scale = point => Math.max(0, point.x - 200) / 2320;
      const style = { transform: `scaleX(${scale(curvePosition(Math.max(0, this.progress)))})` };
      this.motionSamples.forEach((point, index) => { style[`--trail-${index}`] = `scaleX(${scale(point)})`; });
      return style;
    },
  },
  methods: {
    // SVG hrefs bypass uni-app URL rewriting; resolve within the packaged document.
    asset(file) { return './static/images/parcel-journey/' + file; },
    lit(point, index) { return point.state !== 'pending' && (!this.driving || index <= this.reached); },
    pointClass(point, index) { return { 'journey-point-pending': !this.lit(point, index), 'journey-point-teal': this.lit(point, index) && index > 0 }; },
    signTime(point, index) { return point.at && this.lit(point, index) ? String(point.text).split(' ') : ['—']; },
    later(callback, delay) { const timer = setTimeout(callback, delay); this.timers.push(timer); },
    cancelMotion() { this.timers.forEach(clearTimeout); this.timers = []; this.driving = false; this.paintAnimate = false; },
    snap() { this.cancelMotion(); this.progress = parcelJourneyProgress(this.journey); this.reached = Math.floor(this.progress); this.collapsed = this.mode === 'summary' || !!this.journey.completed; },
    updateJourney() {
      const target = parcelJourneyProgress(this.journey), previous = this.progress;
      this.clockNow = Date.now();
      if (target === previous) return;
      const elapsed = Math.min(1, Math.max(0, (Date.now() - this.motionStarted) / 1000));
      const from = this.driving ? this.motionFrom + (this.motionTo - this.motionFrom) * ease(elapsed) : previous;
      this.cancelMotion(); this.clockNow = Date.now();
      if (this.reducedMotion || (typeof document !== 'undefined' && document.hidden) || from < 0 || target <= previous || (this.mode === 'summary' && !this.journey.completed)) { this.snap(); return; }
      this.collapsed = false; this.motionFrom = from; this.motionTo = target; this.motionStarted = Date.now();
      this.progress = target; this.reached = Math.floor(from); this.motionSerial++; this.driving = true; this.paintAnimate = true;
      for (let stage = Math.floor(from) + 1; stage <= Math.floor(target); stage++) {
        let fraction = 0; while (fraction < 1 && from + (target - from) * ease(fraction) < stage) fraction += .01;
        this.later(() => { this.reached = stage; }, Math.min(1000, Math.ceil(fraction * 1000)));
      }
      this.later(() => { this.driving = false; this.reached = Math.floor(target); }, 1000);
      if (this.journey.completed) this.later(() => { this.collapsed = true; this.later(() => this.$emit('settled'), 350); }, 1800);
      this.later(() => { this.paintAnimate = false; }, 2150);
    },
    syncClock() { this.stopClock?.(); this.stopClock = null; if (this.clockNeeded) { this.clockNow = Date.now(); this.stopClock = subscribeClock(now => { this.clockNow = now; }); } },
  },
};
</script>

<style scoped lang="scss">
.parcel-journey{position:relative;width:100%;min-width:0;color:#193d5a;font-variant-numeric:tabular-nums;}
.journey-road-region,.journey-summary-region{display:grid;transition:grid-template-rows .35s ease,opacity .3s ease;}
.journey-road-region{grid-template-rows:1fr;opacity:1;}.journey-summary-region{grid-template-rows:0fr;opacity:0;}
.journey-collapsed .journey-road-region{grid-template-rows:0fr;opacity:0;}.journey-collapsed .journey-summary-region{grid-template-rows:1fr;opacity:1;}
.journey-region-inner{min-height:0;overflow:hidden;}.journey-road-scene{position:relative;aspect-ratio:2320/1200;width:100%;}.journey-road-map{position:absolute;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none;}
.journey-stage-label{fill:#fff;font-size:100px;font-weight:750;}.journey-stage-time{fill:#173c56;font-size:83px;font-weight:750;}
.journey-station-color{opacity:0;transition:opacity .25s ease;}.journey-station-color.lit{opacity:1;}.journey-point-pending .journey-stage-time{fill:#53636e;}
.journey-road-duration{fill:#fff5df;font-size:89px;font-weight:850;font-style:italic;letter-spacing:1px;}.journey-road-duration-long{font-size:78px;}
.journey-road-label{fill:#294a6b;font-size:86px;font-weight:700;}.journey-carrier{fill:#173f65;font-weight:750;}
.journey-car-position,.journey-progress-window{transform-origin:0 0;}.journey-driving .journey-car-position{animation:journey-drive 1s linear both;}.journey-driving .journey-progress-window{animation:journey-trail 1s linear both;}
.journey-driving .journey-wheel-spin{animation:journey-wheel .32s linear infinite;transform-origin:0 0;}.journey-driving .journey-trailer{animation:journey-trailer 1s ease-in-out both;transform-origin:200px 156px;}.journey-driving .journey-parcel{animation:journey-parcel 1s ease-out both;transform-origin:98px 114px;}
.journey-time-reveal{animation:journey-time .3s ease both;}.journey-paint-reveal{animation:journey-paint .3s ease-out both;}
@keyframes journey-drive{0%{transform:var(--drive-0);}20%{transform:var(--drive-1);}40%{transform:var(--drive-2);}60%{transform:var(--drive-3);}80%{transform:var(--drive-4);}100%{transform:var(--drive-5);}}
@keyframes journey-trail{0%{transform:var(--trail-0);}20%{transform:var(--trail-1);}40%{transform:var(--trail-2);}60%{transform:var(--trail-3);}80%{transform:var(--trail-4);}100%{transform:var(--trail-5);}}
@keyframes journey-wheel{to{transform:rotate(360deg);}}@keyframes journey-trailer{0%,100%{transform:translate(0,0) rotate(0);}20%{transform:translate(-5px,1px) rotate(-1deg);}55%{transform:translate(-2px,-1px) rotate(.6deg);}}
@keyframes journey-parcel{0%,55%,100%{transform:rotate(0);}16%{transform:rotate(-5deg);}34%{transform:rotate(2deg);}}
@keyframes journey-time{from{opacity:0;}to{opacity:1;}}@keyframes journey-paint{from{transform:scaleX(0);}to{transform:scaleX(1);}}
.journey-summary{padding-top:7px;border-top:1px solid #c5d6e9;}.journey-time-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}.journey-time-block{box-sizing:border-box;min-width:0;padding:5px 10px;border:1px solid #d1e1f2;border-radius:8px;background:#f9fbffe0;}.journey-summary-label,.journey-summary-time{display:block;font-size:12px;line-height:17px;white-space:nowrap;}.journey-summary-label{font-weight:700;}.journey-summary-time{color:#526b88;}.journey-point-teal.journey-time-block{border-color:#a1cec3;background:#eaf5ef;}.journey-point-pending .journey-summary-time{color:#8292a6;}.journey-summary-durations{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:6px 0 2px;gap:3px;}.journey-duration{text-align:center;min-width:0;}.journey-duration-label,.journey-duration-value{display:block;font-size:11px;line-height:16px;}.journey-duration-label{font-weight:650;color:#405b77;}.journey-duration-value{color:#546f8e;}
.journey-reduced .journey-road-region,.journey-reduced .journey-summary-region{transition:none;}
@media(prefers-reduced-motion:reduce){.journey-road-region,.journey-summary-region,.journey-station-color{transition:none;}.journey-car-position,.journey-progress-window,.journey-wheel-spin,.journey-trailer,.journey-parcel,.journey-time-reveal,.journey-paint-reveal{animation:none!important;}}
@media(forced-colors:active){.journey-stage-label{stroke:#000;stroke-width:2px;}.journey-summary,.journey-time-block{border-color:ButtonBorder;color:CanvasText;background:Canvas;}}
</style>
