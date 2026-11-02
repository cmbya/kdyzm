import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisDetails } from '../public/station-admin.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.className = ''; }
  append(...children) { this.children.push(...children); }
  set innerHTML(_value) { throw new Error('Untrusted detail must never use innerHTML'); }
}
const content = element => [element.textContent, ...element.children.map(content)].join('\n');
test('analysis detail view distinguishes absent, unfinished and validated data and renders hostile text literally', t => {
  const original = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  assert.match(content(createAnalysisDetails(null)), /尚未分析/);
  const hostile = '<img src=x onerror=alert(1)>';
  const analysis = { startedAt: Date.now(), finishedAt: 0, input: { fragment: hostile, region: '', knownStations: [], headers: { Authorization: 'MUST_NOT_RENDER' } }, result: null, error: null };
  const pending = createAnalysisDetails(analysis, { running: true });
  assert.match(content(pending), /后台任务仍在运行/); assert.match(content(pending), /尚无通过校验的返回结构/);
  assert.ok(content(pending).includes(hostile)); assert.ok(!content(pending).includes('MUST_NOT_RENDER'));
  assert.ok(pending.children.every(child => child.tagName !== 'img'));
  const failed = createAnalysisDetails({ ...analysis, finishedAt: Date.now(), error: { code: 'AI_INVALID_RESULT', message: 'AI结果未通过校验' } });
  assert.match(content(failed), /安全错误/); assert.match(content(failed), /AI_INVALID_RESULT/);
  const completed = createAnalysisDetails({ ...analysis, finishedAt: Date.now(), result: { kind: 'unknown', evidence: [] } });
  assert.match(content(completed), /校验后的返回结构/); assert.match(content(completed), /unknown/);
  assert.match(content(createAnalysisDetails(analysis)), /任务已停止或中断/);
});
