#!/usr/bin/env python3
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
scoring=json.loads((ROOT/'metadata/scoring.json').read_text(encoding='utf-8'))
grading=json.loads((ROOT/'metadata/grading.json').read_text(encoding='utf-8'))
valid_kinds={'single','parts','set','order','mixed'}
choice_chars=set('アイウエオカキクケコ')
count=0
for year in map(str,range(2019,2027)):
    if year not in scoring or year not in grading:
        raise SystemExit(f'missing year {year}')
    total=sum(sum(int(v) for v in sec.values()) for sec in scoring[year].values())
    if total!=100:
        raise SystemExit(f'{year}: scoring total {total}, expected 100')
    for short_id,rule in grading[year].items():
        sec,q=short_id.split('-')
        expected=int(scoring[year][sec][q])
        if rule.get('kind') not in valid_kinds:
            raise SystemExit(f'{year}-{short_id}: invalid kind')
        r=rule.get('choice') if rule['kind']=='mixed' else rule
        if rule['kind']=='mixed':
            if int(rule.get('manualPoints',0))+sum(r.get('points') or [])!=expected:
                raise SystemExit(f'{year}-{short_id}: mixed max point mismatch')
        elif sum(rule.get('points') or [])!=expected:
            raise SystemExit(f'{year}-{short_id}: max point mismatch')
        answers=(r or {}).get('answers') or []
        if any(a not in choice_chars for a in answers):
            raise SystemExit(f'{year}-{short_id}: invalid choice token')
        count+=1
print(f'grading metadata validation OK: {count} selection-bearing grading rules')
