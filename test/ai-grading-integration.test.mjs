import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cacheSource, parseConstraints, pastQuestionId } from '../assets/ai-grading-integration.js';

test('maps only the five reviewed past-paper questions', () => {
  assert.equal(pastQuestionId('2024', '大問2 問6'), '2024-2-6');
  assert.equal(pastQuestionId('2024', '大問1 問6'), null);
});

test('extracts written-answer limits', () => {
  assert.deepEqual(parseConstraints('20字以上40字以内'), { minChars: 20, maxChars: 40, requiredWords: [] });
  assert.deepEqual(parseConstraints('40字以内'), { minChars: 0, maxChars: 40, requiredWords: [] });
});

test('cache identity changes when the answer changes', () => {
  assert.notEqual(cacheSource('original', '問', '答案A'), cacheSource('original', '問', '答案B'));
});

test('AI integration cannot write to existing learning history or score controls', () => {
  const source = readFileSync(new URL('../assets/ai-grading-integration.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /indexedDB|waseshibu-progress-api|exam_claimed|exam_completed|dispatchEvent/);
  assert.doesNotMatch(source, /\.click\s*\(|\.value\s*=/);
  assert.equal((source.match(/localStorage\.setItem/g) || []).length, 1);
  assert.match(source, /localStorage\.setItem\(STORAGE_PREFIX \+ key/);
  assert.match(source, /const STORAGE_PREFIX = 'kokugo-ai-feedback:v1:'/);
});
