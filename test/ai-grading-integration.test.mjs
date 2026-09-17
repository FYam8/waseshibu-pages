import test from 'node:test';
import assert from 'node:assert/strict';
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

