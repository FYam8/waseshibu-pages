import {buildReviewExplanation} from '../src/reviewExplanations.js';
import {REVIEW_PROFILES} from '../src/reviewProfiles.js';

const ids=Object.keys(REVIEW_PROFILES);
if(ids.length!==145) throw new Error(`expected 145 profiles, got ${ids.length}`);
const banned=[
  'この問の決め手は、本文と一致',
  '本文理解とは切り分け、語そのものの読み・意味・漢字を確認する',
  '本文確認ポイント：設問が指している箇所',
  '知識＝事b1実',
  'abcde',
  '適4XY当'
];
for(const id of ids){
  const [year,section,question]=id.split('-').map(Number);
  const ex=buildReviewExplanation({
    question:{id,section,question,points:0,topic:''},
    result:{score:0,answer:'',selectionAnswer:''},
    rule:null,totalScore:0
  });
  const joined=[ex.source,ex.method,ex.replay].join('\n');
  for(const b of banned) if(joined.includes(b)) throw new Error(`${id}: generic/OCR phrase remained: ${b}`);
  if(!ex.method || ex.method.length<28) throw new Error(`${id}: method too thin`);
  if(!ex.source || ex.source.length<28) throw new Error(`${id}: source too thin`);
}
console.log(`PASS production-path all-145 profile specificity audit (${ids.length} profiles)`);
