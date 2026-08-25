import hashlib, json, math, re, tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import planetary_computer
import rasterio
import requests
from pystac_client import Client
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds

AOI=[37.65,48.25,38.25,48.90]
CRS='EPSG:32637'; RES=30; BUILT=7
BASE='https://gis.earthdata.nasa.gov/image/rest/services/OPERA_L2_RTC_S1_V1'
SERVICES={'VV':f'{BASE}/OPERA_L2_RTC_S1_V1_VV/ImageServer','VH':f'{BASE}/OPERA_L2_RTC_S1_V1_VH/ImageServer'}
WINDOWS={
    '2024':('2024-06-01','2024-10-01'),
    '2025':('2025-06-01','2025-10-01'),
    '2026':('2026-05-15','2026-08-01'),
}
MIN_COMMON_BURSTS=10
TARGET_PAIRS_PER_YEAR=2
MIN_TOTAL_PAIRS=4
MIN_SECTOR_PX=1000
MIN_PAIR_URBAN_OVERLAP=0.50
QUANTILES=(99.0,99.5)
STABILITY_LIMIT=0.25

OUT=Path('out'); (OUT/'provenance').mkdir(parents=True,exist_ok=True)
def wj(name,obj): (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8')

def epoch_ms(day,end=False):
    t='23:59:59+00:00' if end else '00:00:00+00:00'
    return int(datetime.fromisoformat(day+'T'+t).timestamp()*1000)

def parse_name(name):
    m=re.search(r'RTC-S1_([^_]+)_([0-9]{8}T[0-9]{6}Z)_[^_]+_(S1[A-Z])_',str(name or ''))
    if not m: return None
    return {'burst':m.group(1),'day':m.group(2)[:8],'sensor':m.group(3)}

def query(service,start,end):
    params={
        'where':'1=1','geometry':','.join(map(str,AOI)),'geometryType':'esriGeometryEnvelope','inSR':4326,
        'spatialRel':'esriSpatialRelIntersects','outFields':'objectid,name,startdate,processingdate',
        'returnGeometry':'false','orderByFields':'startdate ASC','resultRecordCount':2000,
        'time':f'{epoch_ms(start)},{epoch_ms(end,True)}','f':'json'}
    r=requests.get(service+'/query',params=params,timeout=120); r.raise_for_status(); j=r.json()
    if j.get('error'): raise RuntimeError(json.dumps(j['error']))
    return j.get('features',[])

def groups(features):
    g=defaultdict(dict)
    for feat in features:
        a=feat.get('attributes',{}); p=parse_name(a.get('name'))
        if not p: continue
        oid=a.get('objectid',a.get('OBJECTID'))
        if oid is None: continue
        key=(p['sensor'],p['day'])
        old=g[key].get(p['burst'])
        if old is None or int(oid)>int(old): g[key][p['burst']]=int(oid)
    return g

def family_candidates(vv,vh):
    by_family=defaultdict(list)
    keys=sorted(set(vv)&set(vh))
    for i,k1 in enumerate(keys):
        sensor1,day1=k1; d1=datetime.strptime(day1,'%Y%m%d')
        for k2 in keys[i+1:]:
            sensor2,day2=k2
            if sensor1!=sensor2 or day1[:4]!=day2[:4]: continue
            sep=(datetime.strptime(day2,'%Y%m%d')-d1).days
            if not 11<=sep<=13: continue
            common=frozenset(set(vv[k1])&set(vv[k2])&set(vh[k1])&set(vh[k2]))
            if len(common)<MIN_COMMON_BURSTS: continue
            fp=hashlib.sha256('|'.join(sorted(common)).encode()).hexdigest()[:12]
            by_family[common].append({'family_fingerprint':fp,'year':day1[:4],'sensor':sensor1,
                                      'day_a':day1,'day_b':day2,'separation_days':sep,
                                      'common_burst_count':len(common),'bursts':common})
    return by_family

def choose_family(by_family):
    scored=[]
    for fam,rows in by_family.items():
        years={x['year'] for x in rows}; count=len(rows)
        scored.append((len(years),len(fam),count,sorted(years),fam,rows))
    if not scored: raise RuntimeError('no >=10-burst dual-pol same-sensor 12-day family')
    scored.sort(key=lambda x:(x[0],x[1],x[2]),reverse=True)
    return scored[0]

def select_nonoverlap(rows):
    selected=[]
    for year in sorted({x['year'] for x in rows}):
        yr=sorted([x for x in rows if x['year']==year],key=lambda x:(x['day_a'],x['day_b']))
        used=set(); chosen=[]
        for x in yr:
            if x['day_a'] in used or x['day_b'] in used: continue
            chosen.append(x); used|={x['day_a'],x['day_b']}
            if len(chosen)>=TARGET_PAIRS_PER_YEAR: break
        selected.extend(chosen)
    if len(selected)<MIN_TOTAL_PAIRS:
        for x in sorted(rows,key=lambda x:(x['year'],x['day_a'],x['day_b'])):
            if any(x['year']==y['year'] and x['sensor']==y['sensor'] and x['day_a']==y['day_a'] and x['day_b']==y['day_b'] for y in selected):
                continue
            selected.append(x)
            if len(selected)>=MIN_TOTAL_PAIRS: break
    if len(selected)<MIN_TOTAL_PAIRS: raise RuntimeError(f'only {len(selected)} family pairs')
    return selected

left,bottom,right,top=transform_bounds('EPSG:4326',CRS,*AOI,densify_pts=41)
left=math.floor(left/RES)*RES; bottom=math.floor(bottom/RES)*RES
right=math.ceil(right/RES)*RES; top=math.ceil(top/RES)*RES
W=int(round((right-left)/RES)); H=int(round((top-bottom)/RES)); TR=from_bounds(left,bottom,right,top,W,H)
row_edges=np.linspace(0,H,5,dtype=int); col_edges=np.linspace(0,W,5,dtype=int)
sector_masks={}
for rr in range(4):
    for cc in range(4):
        sid=f"{'ABCD'[cc]}{rr+1}"; m=np.zeros((H,W),bool)
        m[row_edges[rr]:row_edges[rr+1],col_edges[cc]:col_edges[cc+1]]=True; sector_masks[sid]=m

def rp(href,dtype='float32',resampling=Resampling.bilinear,nodata=np.nan):
    out=np.full((H,W),nodata,dtype=dtype)
    with rasterio.Env(AWS_NO_SIGN_REQUEST='YES',GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif,.TIF',GDAL_HTTP_MAX_RETRY='3',GDAL_HTTP_RETRY_DELAY='2'):
        with rasterio.open(href) as src:
            reproject(source=rasterio.band(src,1),destination=out,src_transform=src.transform,src_crs=src.crs,src_nodata=src.nodata,
                      dst_transform=TR,dst_crs=CRS,dst_nodata=nodata,resampling=resampling)
    return out

pc=Client.open('https://planetarycomputer.microsoft.com/api/stac/v1',modifier=planetary_computer.sign_inplace)
def landcover(year):
    items=list(pc.search(collections=['io-lulc-9-class'],bbox=AOI,datetime=f'{year}-01-01/{year}-12-31').items())
    items=[it for it in items if str(it.id).endswith(f'-{year}')]
    if not items: raise RuntimeError(f'no exact landcover {year}')
    arr=np.zeros((H,W),np.uint8); ids=[]
    for item in items:
        asset=item.assets.get('data') or item.assets.get('map') or next((a for a in item.assets.values() if a.href.lower().endswith(('.tif','.tiff'))),None)
        if asset is None: continue
        tile=rp(asset.href,'uint8',Resampling.nearest,0); m=tile>0; arr[m]=tile[m]; ids.append(str(item.id))
    cov=float((arr>0).mean())
    if cov<0.95 or any(not x.endswith(f'-{year}') for x in ids): raise RuntimeError(f'landcover provenance failed {year}')
    return arr,sorted(ids),cov

lc21,ids21,cov21=landcover(2021); lc22,ids22,cov22=landcover(2022)
stable=(lc21==BUILT)&(lc22==BUILT); core=stable.copy(); pad=np.pad(stable,1,constant_values=False)
for dy in range(3):
    for dx in range(3): core &= pad[dy:dy+H,dx:dx+W]
core_n=int(core.sum())
if core_n<5000: raise RuntimeError('urban core too small')

all_groups={'VV':{},'VH':{}}; inv={}
for year,(start,end) in WINDOWS.items():
    inv[year]={}
    for pol,svc in SERVICES.items():
        fs=query(svc,start,end); g=groups(fs); all_groups[pol].update(g)
        inv[year][pol]={'feature_count':len(fs),'group_count':len(g),'window':[start,end]}
by_family=family_candidates(all_groups['VV'],all_groups['VH'])
year_count,family_size,candidate_count,family_years,family,rows=choose_family(by_family)
selected=select_nonoverlap(rows)
family_fp=hashlib.sha256('|'.join(sorted(family)).encode()).hexdigest()[:12]
wj(Path('provenance')/'family_selection.json',{
    'inventory':inv,'candidate_family_count':len(by_family),'chosen_family_fingerprint':family_fp,
    'chosen_family_common_burst_count':family_size,'chosen_family_year_count':year_count,'chosen_family_candidate_count':candidate_count,
    'selected_pair_count':len(selected),'selected_year_counts':{y:sum(x['year']==y for x in selected) for y in sorted({x['year'] for x in selected})},
    'selection_rule':'largest recurring >=10-burst dual-pol family across years; same sensor, 11-13 days; prefer non-overlapping endpoints; no burst/object IDs exported.'})

def export(service,ids,path):
    params={'bbox':f'{left},{bottom},{right},{top}','bboxSR':32637,'imageSR':32637,'size':f'{W},{H}','format':'tiff','pixelType':'F32',
            'interpolation':'RSP_BilinearInterpolation','mosaicRule':json.dumps({'mosaicMethod':'esriMosaicLockRaster','lockRasterIds':ids}),
            'renderingRule':json.dumps({'rasterFunction':'Sentinel-1 RTC Power'}),'f':'image'}
    r=requests.get(service+'/exportImage',params=params,timeout=240)
    if r.status_code!=200 or len(r.content)<1024: raise RuntimeError(f'export failed {r.status_code} {r.headers.get("content-type")} {r.text[:300]}')
    Path(path).write_bytes(r.content)

def spread(vals):
    a=np.asarray(vals,float); med=float(np.median(a)); lo=float(a.min()); hi=float(a.max()); rr=float((hi-lo)/max(med,1e-12))
    return {'values':[round(float(x),8) for x in a],'median':round(med,8),'min':round(lo,8),'max':round(hi,8),
            'relative_range_over_median':round(rr,4),'within_25pct_relative_range':bool(rr<=STABILITY_LIMIT)}

pair_rows=[]
for idx,c in enumerate(selected,1):
    arrays={}
    with tempfile.TemporaryDirectory() as td:
        for pol,svc in SERVICES.items():
            for lab,day in [('a',c['day_a']),('b',c['day_b'])]:
                ids=[all_groups[pol][(c['sensor'],day)][b] for b in c['bursts']]
                p=Path(td)/f'{pol}_{lab}.tif'; export(svc,ids,p)
                with rasterio.open(p) as src:
                    if src.width!=W or src.height!=H or not src.dtypes[0].startswith('float'): raise RuntimeError('unexpected export')
                    arrays[f'{pol}_{lab}']=src.read(1).astype(np.float32)
    valid=core.copy()
    for a in arrays.values(): valid &= np.isfinite(a)&(a>0)
    overlap=float(valid.sum()/core_n)
    if overlap<MIN_PAIR_URBAN_OVERLAP:
        pair_rows.append({'pair_index':idx,'year':c['year'],'sensor':c['sensor'],'state':'INSUFFICIENT_DATA','separation_days':c['separation_days'],
                          'urban_four_layer_overlap_fraction':round(overlap,8)}); continue
    db={k:10*np.log10(np.maximum(v,1e-8)) for k,v in arrays.items()}
    d={'VV':np.abs(db['VV_b']-db['VV_a']),'VH':np.abs(db['VH_b']-db['VH_a'])}
    sectors=[]; totals={str(q):[0,0] for q in QUANTILES}
    for sid,sm in sector_masks.items():
        m=valid&sm; n=int(m.sum())
        if n<MIN_SECTOR_PX:
            sectors.append({'sector':sid,'state':'INSUFFICIENT_DATA','common_valid_urban_px':n}); continue
        sr={'sector':sid,'state':'MEASURED','common_valid_urban_px':n,'quantiles':{}}
        for q in QUANTILES:
            tv=float(np.percentile(d['VV'][m],q)); th=float(np.percentile(d['VH'][m],q)); joint=m&(d['VV']>=tv)&(d['VH']>=th)
            k=int(joint.sum()); rate=float(k/n); p=1-q/100.; base=p*p
            sr['quantiles'][str(q)]={'joint_px':k,'joint_fraction':round(rate,8),'dependence_amplification':round(rate/max(base,1e-12),4),
                                     'vv_abs_db_threshold':round(tv,6),'vh_abs_db_threshold':round(th,6)}
            totals[str(q)][0]+=k; totals[str(q)][1]+=n
        sectors.append(sr)
    summary={str(q):{'joint_px':totals[str(q)][0],'denominator_px':totals[str(q)][1],
                     'joint_fraction':round(totals[str(q)][0]/totals[str(q)][1],8)} for q in QUANTILES}
    pair_rows.append({'pair_index':idx,'year':c['year'],'sensor':c['sensor'],'state':'MEASURED','separation_days':c['separation_days'],
                      'common_burst_count':c['common_burst_count'],'urban_four_layer_overlap_fraction':round(overlap,8),
                      'quantile_summary':summary,'sectors':sectors})

measured=[p for p in pair_rows if p['state']=='MEASURED']
if len(measured)<MIN_TOTAL_PAIRS: raise RuntimeError(f'only {len(measured)} measured')
common=set(sector_masks)
for p in measured: common &= {s['sector'] for s in p['sectors'] if s['state']=='MEASURED'}
if len(common)<8: raise RuntimeError('too few common sectors')
stability={}
for q in QUANTILES:
    rates=[]
    for p in measured:
        num=den=0
        for s in p['sectors']:
            if s['sector'] in common:
                num+=s['quantiles'][str(q)]['joint_px']; den+=s['common_valid_urban_px']
        rates.append(num/den)
    stability[str(q)]={'common_sector_intersection':spread(rates)}
rate_stable=all(stability[str(q)]['common_sector_intersection']['within_25pct_relative_range'] for q in QUANTILES)
state='OPERA_SAME_GEOMETRY_FAMILY_STABLE' if rate_stable else 'OPERA_SAME_GEOMETRY_FAMILY_NOT_STABLE_ENOUGH'
next_gate=('Permit only this calibrated same-geometry OPERA family to enter a fresh broad-sector cross-sensor surface-change corroboration test; unstable SAR families remain excluded. No actor, exact-position, route, or evasion inference.' if rate_stable else
           'Keep OPERA current corroboration blocked. Add weather/context controls or a longer same-family historical envelope; do not mix track families or lower QA floors.')
result={'status':'MEASURED_OPERA_SAME_GEOMETRY_FAMILY_CALIBRATION','generated_utc':datetime.now(timezone.utc).isoformat(),
        'purpose':'Test whether the largest recurring OPERA acquisition-geometry family is stable enough for independent historical SAR surface-change calibration.',
        'scope':'Historical method QA only; no current-condition, actor, route, organized-presence, sensor-location or safe-passage inference.',
        'family':{'label':'F1','opaque_fingerprint':family_fp,'common_burst_count':family_size,'years':family_years,'candidate_pair_count':candidate_count},
        'urban_mask':{'exact_year_ids':{'2021':ids21,'2022':ids22},'eroded_core_px':core_n},
        'selected_pair_count':len(selected),'measured_pair_count':len(measured),'common_measured_sector_count':len(common),
        'pairs':pair_rows,'stability':stability,'canonical_method_state':state,
        'truth_rules':['Calibration is restricted to one recurring SAR acquisition geometry; results must not be generalized to other track/burst families.',
                       'VV/VH are polarizations of one SAR sensor family, not independent sources.',
                       'Backscatter change is physical surface-change evidence only, not actor/presence evidence.',
                       'No burst IDs, object IDs, raster pixels, geometries, exact locations or routes are exported.',
                       'Coverage/sample floors are preserved.'],
        'next_gate':next_gate}
wj('result.json',result)
qa={'status':'PASS','checks':{'exact_year_mask':all(x.endswith('-2021') for x in ids21) and all(x.endswith('-2022') for x in ids22),
                              'recurring_family_at_least_two_years':year_count>=2,'minimum_four_measured_pairs':len(measured)>=MIN_TOTAL_PAIRS,
                              'at_least_eight_common_sectors':len(common)>=8,'all_measured_overlap_ge_0_50':all(p['urban_four_layer_overlap_fraction']>=MIN_PAIR_URBAN_OVERLAP for p in measured),
                              'historical_only':True,'no_geometry_export':True,'no_raster_artifact':True}}
if not all(qa['checks'].values()): qa['status']='FAIL'
wj('qa.json',qa)
print(json.dumps({'qa':qa,'family':result['family'],'measured_pairs':len(measured),'stability':stability,'state':state,'next_gate':next_gate},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
