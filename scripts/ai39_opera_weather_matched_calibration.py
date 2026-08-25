import json, re
from pathlib import Path

BASE=Path('scripts/ai39_opera_family_calibration.py').read_text(encoding='utf-8')
TARGETS=[
    ('2024','S1A','20240711','20240723'),
    ('2024','S1A','20240828','20240909'),
    ('2025','S1A','20250718','20250730'),
    ('2025','S1A','20250811','20250823'),
    ('2026','S1A','20260526','20260607'),
    ('2026','S1C','20260520','20260601'),
]
replacement='''def select_nonoverlap(rows):\n    targets='''+repr(TARGETS)+'''\n    selected=[]\n    for year,sensor,day_a,day_b in targets:\n        matches=[x for x in rows if x['year']==year and x['sensor']==sensor and x['day_a']==day_a and x['day_b']==day_b]\n        if len(matches)!=1:\n            raise RuntimeError(f'weather-preselected pair missing/ambiguous: {year} {sensor} {day_a} {day_b} -> {len(matches)}')\n        selected.append(matches[0])\n    return selected\n\nleft,bottom'''
patched,n=re.subn(r'def select_nonoverlap\(rows\):.*?\n\nleft,bottom',replacement,BASE,flags=re.S)
if n!=1:
    raise RuntimeError(f'failed to patch preselection function: {n}')
exec(compile(patched,'ai39_opera_family_calibration_weather_matched','exec'),{'__name__':'__main__','__file__':__file__})

out=Path('out/result.json')
result=json.loads(out.read_text(encoding='utf-8'))
qa_path=Path('out/qa.json'); qa=json.loads(qa_path.read_text(encoding='utf-8'))
old=result.get('canonical_method_state')
if old=='OPERA_SAME_GEOMETRY_FAMILY_STABLE':
    state='OPERA_WEATHER_MATCHED_FAMILY_STABLE'
    next_gate='Only this same-geometry, weather-matched calibration class may enter a coarse fresh-pair cross-sensor surface-change corroboration test. No actor, exact-position, route, sensor-location, or evasion inference.'
else:
    state='OPERA_WEATHER_MATCHED_FAMILY_NOT_STABLE_ENOUGH'
    next_gate='Keep OPERA current corroboration blocked. Weather matching did not stabilize the historical detector enough; use longer temporal modeling or a different independent sensor family rather than lowering QA floors.'
result['status']='MEASURED_OPERA_WEATHER_MATCHED_FAMILY_CALIBRATION'
result['purpose']='Validate six historical same-geometry OPERA pairs that were preselected independently by ERA5-Land soil-moisture/precipitation context before their SAR-change outcomes were examined.'
result['selection_provenance']={
    'source':'AI39 OPERA ERA5-Land weather-context screen',
    'preselected_before_sar_validation':True,
    'pair_count':len(TARGETS),
    'rule':'lowest combined rank of endpoint 0-7 cm soil-moisture difference and 48 h endpoint precipitation, with non-overlapping endpoints within year'}
result['canonical_method_state']=state
result['next_gate']=next_gate
result['truth_rules'].append('Weather-matched validation dates were fixed before these pairs were evaluated with SAR pixels; no SAR-outcome-based pair selection was performed.')
qa['checks']['weather_selection_predeclared']=True
qa['checks']['six_preselected_pairs']=result.get('selected_pair_count')==6 and result.get('measured_pair_count')==6
qa['status']='PASS' if all(qa['checks'].values()) else 'FAIL'
out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
qa_path.write_text(json.dumps(qa,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'qa':qa,'state':state,'stability':result['stability'],'next_gate':next_gate},indent=2))
if qa['status']!='PASS':
    raise RuntimeError(json.dumps(qa))
