import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildReviewExplanation} from '../src/reviewExplanations.js';
import {CURATED_PART_DETAILS} from '../src/reviewCurated.js';

const grading=JSON.parse(fs.readFileSync(new URL('../metadata/grading.json',import.meta.url),'utf8'));
const scoring=JSON.parse(fs.readFileSync(new URL('../metadata/scoring.json',import.meta.url),'utf8'));

const mustHave=['2019-1-1','2020-1-1','2021-1-1','2022-1-1','2023-1-1','2024-1-1','2025-1-1','2026-1-1'];
for(const id of mustHave){
  assert.ok(CURATED_PART_DETAILS[id],`${id}: detailed part guidance missing`);
  assert.equal(CURATED_PART_DETAILS[id].parts.length,5,`${id}: expected 5 detailed items`);
  assert.ok(CURATED_PART_DETAILS[id].method.length>40,`${id}: method too generic/short`);
  assert.ok(CURATED_PART_DETAILS[id].evidence.length>35,`${id}: evidence too generic/short`);
}

const id='2023-1-1';
const [year,section,question]=id.split('-');
const rule=grading[year][`${section}-${question}`];
const points=Number(scoring[year][section][question]);
const ex=buildReviewExplanation({
  question:{id,section:+section,question:+question,points,topic:'漢字・語彙',page:8},
  result:{score:0,points,answer:'',selectionAnswer:'',reason:'知識不足'},
  rule,totalScore:50
});
assert.equal(ex.partAnalyses.length,5);
assert.match(ex.source,/挙げる/);
assert.match(ex.source,/一貫/);
assert.match(ex.method,/挙げ・一貫・由来・的確・依頼/);
const a=ex.partAnalyses.find(x=>x.label==='a');
assert.equal(a.answer,'ウ');
assert.match(a.why,/町を挙げて/);
assert.ok(a.candidates.some(x=>/凧揚げ＝揚/.test(x)));
const b=ex.partAnalyses.find(x=>x.label==='b');
assert.ok(b.candidates.some(x=>/突貫＝貫/.test(x)));
assert.match(ex.replay,/町を挙げて/);

// Manual write/read questions must also render concrete per-item detail.
for(const manualId of ['2019-1-1','2020-1-1']){
  const [y,s,q]=manualId.split('-');
  const e=buildReviewExplanation({
    question:{id:manualId,section:+s,question:+q,points:10,topic:'漢字・語彙',page:8},
    result:{score:0,points:10,answer:'',reason:'知識不足'},
    rule:null,totalScore:50
  });
  assert.equal(e.partAnalyses.length,5,`${manualId}: manual item detail not rendered`);
  assert.ok(!/本文理解とは切り分け/.test(e.method),`${manualId}: old generic method remains`);
}

// Same-kanji explanations must include actual target kanji and not only answer letters.
for(const id2 of ['2021-1-1','2022-1-1','2023-1-1','2024-1-1','2025-1-1','2026-1-1']){
  for(const part of CURATED_PART_DETAILS[id2].parts){
    assert.ok(part.target.length>=2,`${id2}/${part.label}: target missing`);
    assert.ok(part.why.length>=12,`${id2}/${part.label}: explanation too short`);
    assert.ok(!/^正解/.test(part.why),`${id2}/${part.label}: explanation is answer-only`);
  }
}
console.log('v1.1.5 specific explanation audit: OK');
