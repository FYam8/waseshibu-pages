import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildReviewExplanation} from '../src/reviewExplanations.js';
import {CURATED_PART_DETAILS} from '../src/reviewCurated.js';

const mustHave=['2019-1-1','2020-1-1','2021-1-1','2022-1-1','2023-1-1','2024-1-1','2025-1-1','2026-1-1'];
for(const id of mustHave){
  assert.ok(CURATED_PART_DETAILS[id],`${id}: detailed part guidance missing`);
  assert.equal(CURATED_PART_DETAILS[id].parts.length,5,`${id}: expected 5 detailed items`);
  assert.ok(CURATED_PART_DETAILS[id].method.length>40,`${id}: method too generic/short`);
  assert.ok(CURATED_PART_DETAILS[id].evidence.length>35,`${id}: evidence too generic/short`);
}

const id='2023-1-1';
const rule={kind:'parts',answers:['ウ','イ','オ','ア','オ'],points:[2,2,2,2,2]};
const ex=buildReviewExplanation({
  question:{id,section:1,question:1,points:10,topic:'漢字・語彙',page:8},
  result:{score:0,points:10,answer:'',selectionAnswer:'',reason:'知識不足'},
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

for(const manualId of ['2019-1-1','2020-1-1']){
  const [year,section,question]=manualId.split('-').map(Number);
  const e=buildReviewExplanation({
    question:{id:manualId,section,question,points:10,topic:'漢字・語彙',page:8},
    result:{score:0,points:10,answer:'',reason:'知識不足'},
    rule:null,totalScore:50
  });
  assert.equal(e.partAnalyses.length,5,`${manualId}: manual item detail not rendered`);
  assert.ok(!/本文理解とは切り分け/.test(e.method),`${manualId}: old generic method remains`);
}

const artifactAudit=String.raw`#!/usr/bin/env python3
"""Fail closed on source PDFs, keys, private history, or source metadata leaking into Pages."""
from pathlib import Path
import sys
ROOT=Path(sys.argv[1] if len(sys.argv)>1 else "dist")
FORBIDDEN_SUFFIX={".pdf",".docx",".pem",".key"}
FORBIDDEN_NAMES={"questions.local.json","scoring.json","grading.json","source_pdfs.json","keyring.enc",".env"}
FORBIDDEN_TERMS=["国語_問題","国語_解答","ROOT_KEY","PRIVATE KEY","github_pat_"]
bad=[]
for p in ROOT.rglob("*"):
    if not p.is_file() or ".git" in p.parts: continue
    if p.suffix.lower() in FORBIDDEN_SUFFIX or p.name in FORBIDDEN_NAMES:
        bad.append(str(p)); continue
    if any(t.lower() in p.name.lower() for t in FORBIDDEN_TERMS):
        bad.append(str(p)); continue
    if p.stat().st_size < 2_000_000 and p.suffix.lower() in {".html",".js",".css",".json",".md",".txt"}:
        try:
            s=p.read_text(errors="ignore")
            if any(t in s for t in ["github_pat_","ROOT_KEY_B64=","BEGIN PRIVATE KEY"]):
                bad.append(f"sensitive token/key marker: {p}")
        except Exception: pass
size=sum(p.stat().st_size for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts)
if size>900*1024*1024: bad.append(f"artifact too large: {size/1024/1024:.1f} MB")
if bad:
    print("PUBLIC ARTIFACT CHECK FAILED")
    for x in bad: print(" -",x)
    raise SystemExit(1)
print(f"PUBLIC ARTIFACT CHECK OK ({size/1024/1024:.1f} MB)")
`;
fs.writeFileSync(new URL('./check_public_artifact.py',import.meta.url),artifactAudit,'utf8');
console.log('v1.1.5 production-path specific explanation audit: OK');
