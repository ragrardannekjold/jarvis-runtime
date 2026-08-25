import hashlib, json, re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

AOI=[37.65,48.25,38.25,48.90]
CENTER_LAT=(AOI[1]+AOI[3])/2
CENTER_LON=(AOI[0]+AOI[2])/2
BASE='https://gis.earthdata.nasa.gov/image/rest/services/OPERA_L2_RTC_S1_V1'
SERVICES={'VV':f'{BASE}/OPERA_L2_RTC_S1_V1_VV/ImageServer','VH':f'{BASE}/OPERA_L2_RTC_S1_V1_VH/ImageServer'}
WINDOWS={'2024':('2024-06-01','2024-10-01'),'2025':('2025-06-01','2025-10-01'),'2026':('2026-05-15','2026-08-01')}
MIN_COMMON_BURSTS=10
TARGET_PER_YEAR=2
MIN_SELECTED=4
OUT=Path('out'); OUT.mkdir(parents=True,exist_ok=True)

def wj(name,obj): (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8')
def epoch_ms(day,end=False):
    return int(datetime.fromisoformat(day+('T23:59:59+00:00' if end else 'T00:00:00+00:00')).timestamp()*1000)
def parse_name(name):
    m=re.search(r'RTC-S1_([^_]+)_([0-9]{8}T[0-9]{6}Z)_[^_]+_(S1[A-Z])_',str(name or ''))
    return None if not m else {'burst':m.group(1),'day':m.group(2)[:8],'sensor':m.group(3)}
def query(service,start,end):
    p={'where':'1=1','geometry':','.join(map(str,AOI)),'geometryType':'esriGeometryEnvelope','inSR':4326,
       'spatialRel':'esriSpatialRelIntersects','outFields':'objectid,name','returnGeometry':'false','resultRecordCount':2000,
       'time':f'{epoch_ms(start)},{epoch_ms(end,True)}','f':'json'}
    r=requests.get(service+'/query',params=p,timeout=120); r.raise_for_status(); j=r.json()
    if j.get('error'): raise RuntimeError(j['error'])
    return j.get('features',[])
def groups(features):
    g=defaultdict(dict)
    for f in features:
        a=f.get('attributes',{}); p=parse_name(a.get('name'))
        if not p: continue
        oid=a.get('objectid',a.get('OBJECTID'))
        if oid is None: continue
        old=g[(p['sensor'],p['day'])].get(p['burst'])
        if old is None or int(oid)>int(old): g[(p['sensor'],p['day'])][p['burst']]=int(oid)
    return g
def families(vv,vh):
    by=defaultdict(list); keys=sorted(set(vv)&set(vh))
    for i,k1 in enumerate(keys):
        s1,d1=k1; dt1=datetime.strptime(d1,'%Y%m%d')
        for k2 in keys[i+1:]:
            s2,d2=k2
            if s1!=s2 or d1[:4]!=d2[:4]: continue
            sep=(datetime.strptime(d2,'%Y%m%d')-dt1).days
            if not 11<=sep<=13: continue
            common=frozenset(set(vv[k1])&set(vv[k2])&set(vh[k1])&set(vh[k2]))
            if len(common)<MIN_COMMON_BURSTS: continue
            by[common].append({'year':d1[:4],'sensor':s1,'day_a':d1,'day_b':d2,'separation_days':sep,'bursts':common,'common_burst_count':len(common)})
    return by

g={'VV':{},'VH':{}}
for y,(a,b) in WINDOWS.items():
    for pol,svc in SERVICES.items(): g[pol].update(groups(query(svc,a,b)))
by=families(g['VV'],g['VH'])
if not by: raise RuntimeError('no recurring dual-pol families')
family,rows=max(by.items(),key=lambda kv:(len({x['year'] for x in kv[1]}),len(kv[0]),len(kv[1])))
fp=hashlib.sha256('|'.join(sorted(family)).encode()).hexdigest()[:12]

# ERA5-Land via Open-Meteo historical API. Center-point context is a broad confound screen, not local ground truth.
weather={}
for y,(start,end) in WINDOWS.items():
    p={'latitude':CENTER_LAT,'longitude':CENTER_LON,'start_date':start,'end_date':end,
       'hourly':'soil_moisture_0_to_7cm,precipitation','models':'era5_land','timezone':'UTC'}
    r=requests.get('https://archive-api.open-meteo.com/v1/archive',params=p,timeout=120); r.raise_for_status(); j=r.json()
    h=j.get('hourly',{}); times=h.get('time',[]); sm=h.get('soil_moisture_0_to_7cm',[]); pr=h.get('precipitation',[])
    daily=defaultdict(lambda:{'sm':[],'precip':0.0})
    for t,s,pv in zip(times,sm,pr):
        d=t[:10]
        if s is not None: daily[d]['sm'].append(float(s))
        if pv is not None: daily[d]['precip']+=float(pv)
    for d,v in daily.items():
        weather[d]={'soil_mean':None if not v['sm'] else float(np.mean(v['sm'])),'precip_sum':float(v['precip'])}

def ctx(day8):
    d=datetime.strptime(day8,'%Y%m%d').date(); ds=d.isoformat(); prev=(d-timedelta(days=1)).isoformat()
    a=weather.get(ds,{}); b=weather.get(prev,{})
    sm=a.get('soil_mean'); p48=float(a.get('precip_sum',0.0))+float(b.get('precip_sum',0.0))
    return sm,p48

cands=[]
for x in rows:
    sm_a,p_a=ctx(x['day_a']); sm_b,p_b=ctx(x['day_b'])
    if sm_a is None or sm_b is None: continue
    cands.append({**x,'soil_delta':abs(sm_b-sm_a),'endpoint_precip48_total':p_a+p_b,
                  'endpoint_precip48_max':max(p_a,p_b),'soil_mean_pair':(sm_a+sm_b)/2})
if len(cands)<MIN_SELECTED: raise RuntimeError('too few weather-complete candidates')

def percentile_ranks(vals):
    arr=np.asarray(vals,float); order=np.argsort(arr,kind='mergesort'); ranks=np.empty(len(arr),float)
    ranks[order]=np.linspace(0,1,len(arr),endpoint=True) if len(arr)>1 else 0.0
    return ranks
r_sm=percentile_ranks([x['soil_delta'] for x in cands]); r_pr=percentile_ranks([x['endpoint_precip48_total'] for x in cands])
for i,x in enumerate(cands): x['confound_score']=float((r_sm[i]+r_pr[i])/2)

selected=[]
for y in sorted({x['year'] for x in cands}):
    yr=sorted([x for x in cands if x['year']==y],key=lambda x:(x['confound_score'],x['day_a'],x['day_b']))
    used=set(); chosen=[]
    for x in yr:
        if x['day_a'] in used or x['day_b'] in used: continue
        chosen.append(x); used|={x['day_a'],x['day_b']}
        if len(chosen)>=TARGET_PER_YEAR: break
    selected.extend(chosen)
if len(selected)<MIN_SELECTED:
    raise RuntimeError(f'only {len(selected)} non-overlap weather-screened pairs')

# Export dates because they are historical method-QA metadata; never export burst/object IDs or geometry.
def safe(x):
    return {'year':x['year'],'sensor':x['sensor'],'day_a':datetime.strptime(x['day_a'],'%Y%m%d').date().isoformat(),
            'day_b':datetime.strptime(x['day_b'],'%Y%m%d').date().isoformat(),'separation_days':x['separation_days'],
            'common_burst_count':x['common_burst_count'],'soil_delta_m3m3':round(x['soil_delta'],6),
            'endpoint_precip48_total_mm':round(x['endpoint_precip48_total'],3),
            'endpoint_precip48_max_mm':round(x['endpoint_precip48_max'],3),'confound_score':round(x['confound_score'],4)}
result={'status':'OPERA_WEATHER_CONTEXT_SCREEN','generated_utc':datetime.now(timezone.utc).isoformat(),
        'scope':'Historical independent weather-confound screening only; no SAR change result, current condition, actor, route or hazard inference.',
        'family':{'label':'F1','opaque_fingerprint':fp,'common_burst_count':len(family),'candidate_count':len(cands),'years':sorted({x['year'] for x in cands})},
        'weather_source':'Open-Meteo Historical Weather API, ERA5-Land; center-point broad context.',
        'selection_rule':'Within the recurring SAR family, rank endpoint absolute 0-7 cm soil-moisture difference and combined 48 h endpoint precipitation independently; mean percentile rank is the confound score; choose up to two lowest-score non-overlapping pairs per year.',
        'selected_pairs':[safe(x) for x in selected],
        'candidate_context_summary':{'soil_delta_min':round(min(x['soil_delta'] for x in cands),6),'soil_delta_median':round(float(np.median([x['soil_delta'] for x in cands])),6),
                                     'soil_delta_max':round(max(x['soil_delta'] for x in cands),6),'precip48_total_median_mm':round(float(np.median([x['endpoint_precip48_total'] for x in cands])),3)},
        'truth_rules':['Weather screen is independent of SAR pixel-change outcomes for the newly selected pairs.','ERA5-Land center-point context is a broad confound proxy, not local ground truth.','No burst IDs, object IDs, raster pixels or geometries are exported.']}
qa={'status':'PASS','checks':{'recurring_family':len(family)>=MIN_COMMON_BURSTS,'weather_complete_candidates':len(cands)>=MIN_SELECTED,
                              'selected_minimum':len(selected)>=MIN_SELECTED,'nonoverlap_within_year':all(len({d for x in selected if x['year']==y for d in (x['day_a'],x['day_b'])})==2*sum(x['year']==y for x in selected) for y in {x['year'] for x in selected}),
                              'historical_only':True,'no_geometry_export':True}}
if not all(qa['checks'].values()): qa['status']='FAIL'
wj('result.json',result); wj('qa.json',qa)
print(json.dumps({'qa':qa,'family':result['family'],'selected_pairs':result['selected_pairs'],'summary':result['candidate_context_summary']},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
