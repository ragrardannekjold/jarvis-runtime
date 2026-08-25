import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

AOI=[37.65,48.25,38.25,48.90]
STAC='https://earth-search.aws.element84.com/v1/search'
COLL='sentinel-2-c1-l2a'
THERMAL_ANCHORS=[
    ('T2023_1','2023-06-20','2023-07-06'),
    ('T2023_2','2023-06-04','2023-06-20'),
    ('T2023_3','2023-09-08','2023-09-24'),
    ('T2024_1','2024-08-09','2024-08-25'),
    ('T2025_1','2025-08-28','2025-09-13'),
    ('T2025_2','2025-07-11','2025-07-27'),
    ('T2025_3','2025-05-24','2025-06-09'),
    ('T2025_4','2025-07-27','2025-08-12'),
]
OUT=Path('out'); OUT.mkdir(parents=True,exist_ok=True)

def wj(name,obj): (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8')
def dt(s): return datetime.fromisoformat(s+'T00:00:00+00:00')

def search(start,end):
    body={'collections':[COLL],'bbox':AOI,'datetime':f'{start}T00:00:00Z/{end}T23:59:59Z','limit':100}
    r=requests.post(STAC,json=body,timeout=120); r.raise_for_status(); j=r.json()
    feats=j.get('features',[])
    # Bounded windows should fit 100; fail closed rather than silently truncate.
    if len(feats)>=100:
        raise RuntimeError(f'possible STAC truncation {start} {end}: {len(feats)}')
    return feats,body

rows=[]; provenance={}
for label,ta,tb in THERMAL_ANCHORS:
    start=(dt(ta)-timedelta(days=12)).date().isoformat()
    end=(dt(tb)+timedelta(days=12)).date().isoformat()
    feats,body=search(start,end)
    provenance[label]={'request':body,'feature_count':len(feats)}
    days=defaultdict(lambda:{'clouds':[],'ids':[]})
    for f in feats:
        fid=str(f.get('id') or '')
        platform=fid.split('_',1)[0]
        if platform not in ('S2A','S2B','S2C'):
            continue
        t=f.get('properties',{}).get('datetime') or f.get('properties',{}).get('start_datetime')
        if not t: continue
        day=t[:10]
        cc=f.get('properties',{}).get('eo:cloud_cover')
        if cc is not None: days[(platform,day)]['clouds'].append(float(cc))
        days[(platform,day)]['ids'].append(fid)
    keys=sorted(days)
    candidates=[]
    for i,(p1,d1) in enumerate(keys):
        a=dt(d1)
        for p2,d2 in keys[i+1:]:
            if p1!=p2: continue
            sep=(dt(d2)-a).days
            if sep<9: continue
            if sep>11: break
            clouds=days[(p1,d1)]['clouds']+days[(p2,d2)]['clouds']
            max_cloud=max(clouds) if clouds else 100.0
            mean_cloud=sum(clouds)/len(clouds) if clouds else 100.0
            endpoint_error=abs((dt(d1)-dt(ta)).days)+abs((dt(d2)-dt(tb)).days)
            overlap=max(0,(min(dt(d2),dt(tb))-max(dt(d1),dt(ta))).days)
            candidates.append({
                'platform':p1,'day_a':d1,'day_b':d2,'separation_days':sep,
                'endpoint_error_days':endpoint_error,'interval_overlap_days':overlap,
                'max_scene_cloud':round(max_cloud,3),'mean_scene_cloud':round(mean_cloud,3),
                'scene_count_a':len(days[(p1,d1)]['ids']),'scene_count_b':len(days[(p1,d2)]['ids'])})
    candidates.sort(key=lambda x:(x['endpoint_error_days'],-x['interval_overlap_days'],x['max_scene_cloud'],x['mean_scene_cloud'],x['platform'],x['day_a']))
    selected=candidates[0] if candidates else None
    rows.append({'anchor':label,'thermal_day_a':ta,'thermal_day_b':tb,'candidate_count':len(candidates),'selected':selected,'top_candidates':candidates[:8]})

selected_count=sum(r['selected'] is not None for r in rows)
result={'status':'HISTORICAL_CROSSSENSOR_ANCHOR_DISCOVERY','generated_utc':datetime.now(timezone.utc).isoformat(),
        'purpose':'Preselect Sentinel-2 same-platform ~10-day pairs nearest to eight already-QA-passed Landsat thermal controls before optical change outcomes are examined.',
        'scope':'Historical metadata matching only; no pixel-change, current condition, actor, route, organized-presence or hazard inference.',
        'selection_rule':'For each fixed thermal anchor, choose same-platform Sentinel-2 pair separated 9-11 days minimizing endpoint-date error; maximize interval overlap next; scene cloud is only a later tie-break. Pixel common-clear and empirical-quantile QA are not used in selection.',
        'anchors':rows,
        'truth_rules':['Thermal anchors were fixed by prior Landsat pixel QA before this optical matching pass.','Selected optical pairs are metadata-selected before optical-change outcomes are examined.','Scene cloud metadata does not replace pixel QA.','No raster pixels, geometry or current tactical information is exported.']}
qa={'status':'PASS','checks':{'eight_fixed_thermal_anchors':len(rows)==8,'at_least_six_selected_optical_pairs':selected_count>=6,'historical_only':True,'no_pixel_use':True,'no_geometry_export':True}}
if not all(qa['checks'].values()): qa['status']='FAIL'
wj('result.json',result); wj('qa.json',qa); wj('provenance.json',provenance)
print(json.dumps({'qa':qa,'selected_count':selected_count,'selected':[{'anchor':r['anchor'],**(r['selected'] or {})} for r in rows]},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
