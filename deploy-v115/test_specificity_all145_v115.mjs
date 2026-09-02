import fs from 'node:fs';
import {buildReviewExplanation} from '../src/reviewExplanations.js';
import {REVIEW_PROFILES} from '../src/reviewProfiles.js';
import {CURATED_PART_DETAILS} from '../src/reviewCurated.js';

const grading=JSON.parse(fs.readFileSync(new URL('../metadata/grading.json',import.meta.url),'utf8'));
const scoring=JSON.parse(fs.readFileSync(new URL('../metadata/scoring.json',import.meta.url),'utf8'));

const rows=[];
for(const [year,yrules] of Object.entries(grading)){
  for(const [short,rule] of Object.entries(yrules)){
    const [section,question]=short.split('-').map(Number);
    const id=`${year}-${short}`;
    const points=Number(scoring[year][String(section)][String(question)]);
    const ex=buildReviewExplanation({
      question:{id,section,question,points,topic:''},
      result:{score:0,answer:'',selectionAnswer:''},
      rule,totalScore:0
    });
    rows.push({id,ex});
  }
}
for(const [id,p] of Object.entries(REVIEW_PROFILES)){
  if(rows.some(x=>x.id===id)) continue;
  const [year,section,question]=id.split('-').map(Number);
  const points=Number(scoring[year]?.[String(section)]?.[String(question)]||0);
  const ex=buildReviewExplanation({
    question:{id,section,question,points,topic:''},
    result:{score:0,answer:'',selectionAnswer:''},
    rule:null,totalScore:0
  });
  rows.push({id,ex});
}
if(rows.length!==145) throw new Error(`expected 145 explanations, got ${rows.length}`);

const banned=[
  'この問の決め手は、本文と一致',
  '本文理解とは切り分け、語そのものの読み・意味・漢字を確認する',
  '本文確認ポイント：設問が指している箇所',
  '知識＝事b1実',
  'abcde',
  '適4XY当'
];
for(const {id,ex} of rows){
  const joined=[ex.source,ex.method,ex.replay].join('\n');
  for(const b of banned) if(joined.includes(b)) throw new Error(`${id}: generic/OCR phrase remained: ${b}`);
  if(!ex.method || ex.method.length<28) throw new Error(`${id}: method too thin`);
  if(!ex.source || ex.source.length<28) throw new Error(`${id}: source too thin`);
}

const methods=new Map();
for(const {id,ex} of rows){
  const prev=methods.get(ex.method);
  if(prev) throw new Error(`${id}: identical method reused from ${prev}`);
  methods.set(ex.method,id);
}

for(const [year,yrules] of Object.entries(grading)){
  for(const [short,r0] of Object.entries(yrules)){
    const r=r0.kind==='mixed'?r0.choice:r0;
    if(r.kind!=='parts') continue;
    const id=`${year}-${short}`;
    const d=CURATED_PART_DETAILS[id];
    if(!d) throw new Error(`${id}: missing composite detail`);
    if(d.parts?.length!==r.answers.length) throw new Error(`${id}: ${d.parts?.length||0} details for ${r.answers.length} answers`);
    d.parts.forEach((p,i)=>{
      if(p.answer!==r.answers[i]) throw new Error(`${id}/${p.label}: answer mismatch`);
      if(!p.why || p.why.length<18) throw new Error(`${id}/${p.label}: explanation too thin`);
    });
  }
}

const q2023=rows.find(x=>x.id==='2023-1-1')?.ex;
for(const term of ['挙げる','一貫','由来','的確','依頼','凧揚げ＝揚','突貫＝貫']){
  const text=JSON.stringify(q2023);
  if(!text.includes(term)) throw new Error(`2023-1-1 missing concrete term ${term}`);
}
console.log(`PASS all-145 specificity audit (${rows.length} explanations / composite details complete)`);
