import json, math, re, tempfile
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
    '2024':('2024-07-20','2024-09-05'),
    '2025':('2025-07-20','2025-09-05'),
    '2026':('2026-06-20','2026-08-01'),
}
MIN_COMMON_BURSTS=6
MAX_PAIRS_PER_YEAR=2
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
    return {'burst':m.group(1),'acq':m.group(2),'day':m.group(2)[:8],'sensor':m.group(3)}

def query(service,start,end):
    params={
        'where':'1=1','geometry':','.join(map(str,AOI)),'geometryType':'esriGeometryEnvelope','inSR':4326,
        'spatialRel':'esriSpatialRelIntersects','outFields':'objectid,name,startdate,processingdate',
        'returnGeometry':'false','orderByFields':'startdate ASC','resultRecordCount':2000,
        'time':f'{epoch_ms(start)},{epoch_ms(end,True)}','f':'json'}
    r=requests.get(service+'/query',params=params,timeout=120); r.raise_for_status(); j=r.json()
    if j.get('error'): raise RuntimeError(json.dumps(j['error']))
    return j.get('features',[]),params

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

def candidate_pairs(vv,vh,year):
    keys=sorted(set(vv)&set(vh))
    c=[]
    for i,k1 in enumerate(keys):
        sensor1,day1=k1; d1=datetime.strptime(day1,'%Y%m%d')
        if not day1.startswith(year): continue
        for k2 in keys[i+1:]:
            sensor2,day2=k2
            if sensor1!=sensor2 or not day2.startswith(year): continue
            sep=(datetime.strptime(day2,'%Y%m%d')-d1).days
            if not 11<=sep<=13: continue
            common=set(vv[k1])&set(vv[k2])&set(vh[k1])&set(vh[k2])
            if len(common)>=MIN_COMMON_BURSTS:
                c.append({'year':year,'sensor':sensor1,'day_a':day1,'day_b':day2,'separation_days':sep,
                          'bursts':frozenset(common),'common_burst_count':len(common)})
    c.sort(key=lambda x:(-x['common_burst_count'],abs(x['separation_days']-12),x['day_a'],x['day_b']))
    return c

def select_pairs(candidates_by_year):
    selected=[]
    for year in sorted(candidates_by_year):
        chosen=[]
        for cand in candidates_by_year[year]:
            if any(len(cand['bursts']&x['bursts'])/max(1,len(cand['bursts']|x['bursts']))>=0.50 for x in chosen):
                continue
            chosen.append(cand)
            if len(chosen)>=MAX_PAIRS_PER_YEAR: break
        selected.extend(chosen)
    if len(selected)<MIN_TOTAL_PAIRS:
        # Fallback: add strongest remaining distinct date-pairs without relaxing burst/sample floors.
        allc=[x for v in candidates_by_year.values() for x in v]
        for cand in allc:
            if any(cand['year']==x['year'] and cand['day_a']==x['day_a'] and cand['day_b']==x['day_b'] and cand['sensor']==x['sensor'] for x in selected):
                continue
            selected.append(cand)
            if len(selected)>=MIN_TOTAL_PAIRS: break
    if len(selected)<MIN_TOTAL_PAIRS: raise RuntimeError(f'only {len(selected)} qualifying SAR pairs')
    return selected

left,bottom,right,top=transform_bounds('EPSG:4326',CRS,*AOI,densify_pts=41)
left=math.floor(left/RES)*RES; bottom=math.floor(bottom/RES)*RES
right=math.ceil(right/RES)*RES; top=math.ceil(top/RES)*RES
W=int(round((right-left)/RES)); H=int(round((top-bottom)/RES))
TR=from_bounds(left,bottom,right,top,W,H)
row_edges=np.linspace(0,H,5,dtype=int); col_edges=np.linspace(0,W,5,dtype=int)
sector_masks={}
for rr in range(4):
    for cc in range(4):
        sid=f"{'ABCD'[cc]}{rr+1}"
        m=np.zeros((H,W),bool); m[row_edges[rr]:row_edges[rr+1],col_edges[cc]:col_edges[cc+1]]=True
        sector_masks[sid]=m

# Exact-year urban core is intentionally reproduced from the already canonical optical mask recipe.
def rp(href,dtype='float32',resampling=Resampling.bilinear,nodata=np.nan):
    out=np.full((H,W),nodata,dtype=dtype)
    with rasterio.Env(AWS_NO_SIGN_REQUEST='YES',GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
                      CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif,.TIF',GDAL_HTTP_MAX_RETRY='3',GDAL_HTTP_RETRY_DELAY='2'):
        with rasterio.open(href) as src:
            reproject(source=rasterio.band(src,1),destination=out,src_transform=src.transform,src_crs=src.crs,
                      src_nodata=src.nodata,dst_transform=TR,dst_crs=CRS,dst_nodata=nodata,resampling=resampling)
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
stable=(lc21==BUILT)&(lc22==BUILT)
core=stable.copy(); pad=np.pad(stable,1,constant_values=False)
for dy in range(3):
    for dx in range(3): core &= pad[dy:dy+H,dx:dx+W]
core_n=int(core.sum())
if core_n<5000: raise RuntimeError('urban core too small')

# Inventory each polarization; artifact keeps only aggregate query/readback, never burst/object IDs.
all_groups={'VV':{},'VH':{}}; query_summary={}
for year,(start,end) in WINDOWS.items():
    query_summary[year]={}
    for pol,svc in SERVICES.items():
        feats,params=query(svc,start,end); g=groups(feats); all_groups[pol].update(g)
        query_summary[year][pol]={'feature_count':len(feats),'group_count':len(g),'window':[start,end]}

candidates_by_year={}
for year in WINDOWS:
    candidates_by_year[year]=candidate_pairs(all_groups['VV'],all_groups['VH'],year)
selected=select_pairs(candidates_by_year)
wj(Path('provenance')/'inventory_summary.json',{
    'queries':query_summary,
    'candidate_pair_counts':{y:len(v) for y,v in candidates_by_year.items()},
    'selected_pair_count':len(selected),
    'selection_rule':'same sensor, 11-13 days, >=6 common dual-pol bursts; up to two distinct burst families per year; no burst/object IDs exported.'})

def export(service,ids,path):
    params={
        'bbox':f'{left},{bottom},{right},{top}','bboxSR':32637,'imageSR':32637,'size':f'{W},{H}',
        'format':'tiff','pixelType':'F32','interpolation':'RSP_BilinearInterpolation',
        'mosaicRule':json.dumps({'mosaicMethod':'esriMosaicLockRaster','lockRasterIds':ids}),
        'renderingRule':json.dumps({'rasterFunction':'Sentinel-1 RTC Power'}),'f':'image'}
    r=requests.get(service+'/exportImage',params=params,timeout=240)
    if r.status_code!=200 or len(r.content)<1024:
        raise RuntimeError(f'export failed {r.status_code} {r.headers.get("content-type")} {r.text[:500]}')
    Path(path).write_bytes(r.content)

def spread(vals):
    a=np.asarray(vals,float); med=float(np.median(a)); lo=float(a.min()); hi=float(a.max()); rr=float((hi-lo)/max(med,1e-12))
    return {'values':[round(float(x),8) for x in a],'median':round(med,8),'min':round(lo,8),'max':round(hi,8),
            'relative_range_over_median':round(rr,4),'within_25pct_relative_range':bool(rr<=STABILITY_LIMIT)}

pair_rows=[]
for idx,cand in enumerate(selected,1):
    sensor,day_a,day_b=cand['sensor'],cand['day_a'],cand['day_b']; bursts=cand['bursts']
    arrays={}
    with tempfile.TemporaryDirectory() as td:
        for pol,svc in SERVICES.items():
            for label,day in [('a',day_a),('b',day_b)]:
                ids=[all_groups[pol][(sensor,day)][b] for b in bursts]
                p=Path(td)/f'{pol}_{label}.tif'; export(svc,ids,p)
                with rasterio.open(p) as src:
                    if src.width!=W or src.height!=H or not src.dtypes[0].startswith('float'):
                        raise RuntimeError('unexpected OPERA export grid/dtype')
                    arrays[f'{pol}_{label}']=src.read(1).astype(np.float32)
    valid=core.copy()
    for a in arrays.values(): valid &= np.isfinite(a)&(a>0)
    overlap=float(valid.sum()/core_n)
    if overlap<MIN_PAIR_URBAN_OVERLAP:
        pair_rows.append({'pair_index':idx,'year':cand['year'],'sensor':sensor,'separation_days':cand['separation_days'],
                          'common_burst_count':cand['common_burst_count'],'state':'INSUFFICIENT_DATA',
                          'urban_four_layer_overlap_fraction':round(overlap,8),'minimum_required_overlap':MIN_PAIR_URBAN_OVERLAP})
        continue
    db={k:10.0*np.log10(np.maximum(v,1e-8)) for k,v in arrays.items()}
    diffs={'VV':np.abs(db['VV_b']-db['VV_a']),'VH':np.abs(db['VH_b']-db['VH_a'])}
    sectors=[]; totals={str(q):[0,0] for q in QUANTILES}; raw_stats={}
    for pol in ('VV','VH'):
        vals=diffs[pol][valid]
        raw_stats[pol]={'median_abs_db':round(float(np.median(vals)),6),'p95_abs_db':round(float(np.percentile(vals,95)),6),
                        'p99_5_abs_db':round(float(np.percentile(vals,99.5)),6)}
    for sid,sm in sector_masks.items():
        mask=valid&sm; n=int(mask.sum())
        if n<MIN_SECTOR_PX:
            sectors.append({'sector':sid,'state':'INSUFFICIENT_DATA','common_valid_urban_px':n,'minimum_required_px':MIN_SECTOR_PX}); continue
        row={'sector':sid,'state':'MEASURED','common_valid_urban_px':n,'quantiles':{}}
        for q in QUANTILES:
            tv=float(np.percentile(diffs['VV'][mask],q)); th=float(np.percentile(diffs['VH'][mask],q))
            joint=mask&(diffs['VV']>=tv)&(diffs['VH']>=th); k=int(joint.sum()); rate=float(k/n)
            p=1-q/100.0; baseline=p*p
            row['quantiles'][str(q)]={'joint_px':k,'joint_fraction':round(rate,8),
                                     'independent_marginal_baseline':round(baseline,8),
                                     'dependence_amplification':round(rate/max(baseline,1e-12),4),
                                     'vv_abs_db_threshold':round(tv,6),'vh_abs_db_threshold':round(th,6)}
            totals[str(q)][0]+=k; totals[str(q)][1]+=n
        sectors.append(row)
    summary={}
    for q in QUANTILES:
        k,n=totals[str(q)]; summary[str(q)]={'joint_px':k,'denominator_px':n,'joint_fraction':round(float(k/n),8)}
    pair_rows.append({'pair_index':idx,'year':cand['year'],'sensor':sensor,'separation_days':cand['separation_days'],
                      'common_burst_count':cand['common_burst_count'],'state':'MEASURED',
                      'urban_four_layer_overlap_fraction':round(overlap,8),'raw_abs_db':raw_stats,
                      'quantile_summary':summary,'sectors':sectors})

measured=[p for p in pair_rows if p['state']=='MEASURED']
if len(measured)<MIN_TOTAL_PAIRS: raise RuntimeError(f'only {len(measured)} measured pairs after pixel QA')
common_sectors=set(sector_masks)
for p in measured:
    common_sectors &= {s['sector'] for s in p['sectors'] if s['state']=='MEASURED'}
if len(common_sectors)<8: raise RuntimeError(f'too few common measured sectors: {len(common_sectors)}')

stability={}
for q in QUANTILES:
    naive=[]; common=[]
    for p in measured:
        naive.append(p['quantile_summary'][str(q)]['joint_fraction'])
        num=den=0
        for s in p['sectors']:
            if s['sector'] in common_sectors:
                num += s['quantiles'][str(q)]['joint_px']; den += s['common_valid_urban_px']
        common.append(num/den)
    stability[str(q)]={'all_measured_sectors_per_pair':spread(naive),'common_sector_intersection':spread(common)}

rate_stable=all(stability[str(q)]['common_sector_intersection']['within_25pct_relative_range'] for q in QUANTILES)
state='OPERA_DUALPOL_HISTORICAL_CANARY_STABLE' if rate_stable else 'OPERA_DUALPOL_HISTORICAL_CANARY_NOT_STABLE_ENOUGH'
next_gate=('Use the calibrated optical and OPERA historical detectors only for a coarse broad-sector cross-sensor current/fresh-pair corroboration test; keep output surface-change-only and do not infer exact positions, actors, routes, or surveillance evasion.' if rate_stable else
           'Do not use OPERA as a current corroborator yet; expand same-track historical controls or refine SAR contextual normalization without lowering pixel/coverage floors.')

result={
    'status':'MEASURED_OPERA_DUALPOL_HISTORICAL_CANARY','generated_utc':datetime.now(timezone.utc).isoformat(),
    'purpose':'Calibrate an independent OPERA RTC-S1 historical broad-sector surface-change detector after the optical urban-mask method gate.',
    'scope':'Historical method QA only; no current-condition, actor, route, organized-presence, sensor-location, or safe-passage inference.',
    'data_model':'OPERA RTC-S1 F32 gamma0 power, VV+VH, same-sensor same-burst 11-13 day pairs, exported at 30 m on the canonical AI-39 grid.',
    'urban_mask':{'exact_year_ids':{'2021':ids21,'2022':ids22},'coverage':{'2021':cov21,'2022':cov22},'eroded_core_px':core_n},
    'pair_selection':{'selected_count':len(selected),'measured_count':len(measured),'minimum_common_bursts':MIN_COMMON_BURSTS,
                      'minimum_pair_urban_overlap':MIN_PAIR_URBAN_OVERLAP,'years':sorted({p['year'] for p in measured})},
    'pairs':pair_rows,
    'common_measured_sector_count':len(common_sectors),
    'stability':stability,'canonical_method_state':state,
    'truth_rules':['Empirical marginal quantiles are fixed within each SAR pair/sector; the tested quantity is VV/VH joint-tail dependence stability.',
                   'VV and VH are two polarizations of the same SAR sensor family, not two independent source families.',
                   'SAR backscatter change can reflect moisture, roughness, vegetation, structures, geometry, or other physical change; it is not actor/presence evidence by itself.',
                   'No burst IDs, object IDs, raster pixels, geometries, exact locations, or routes are exported.',
                   'INSUFFICIENT_DATA is preserved rather than lowering coverage/sample floors.'],
    'next_gate':next_gate}
wj('result.json',result)
qa={'status':'PASS','checks':{
    'exact_year_landcover':all(x.endswith('-2021') for x in ids21) and all(x.endswith('-2022') for x in ids22),
    'minimum_four_measured_pairs':len(measured)>=MIN_TOTAL_PAIRS,
    'at_least_eight_common_sectors':len(common_sectors)>=8,
    'all_measured_pairs_overlap_ge_0_50':all(p['urban_four_layer_overlap_fraction']>=MIN_PAIR_URBAN_OVERLAP for p in measured),
    'canonical_sector_labels':sorted(sector_masks)==sorted(f"{'ABCD'[cc]}{rr+1}" for rr in range(4) for cc in range(4)),
    'historical_method_qa_only':True,'no_geometry_export':True,'no_raster_artifact':True}}
if not all(qa['checks'].values()): qa['status']='FAIL'
wj('qa.json',qa)
print(json.dumps({'qa':qa,'selected_pairs':len(selected),'measured_pairs':len(measured),'common_sectors':len(common_sectors),
                  'stability':stability,'canonical_method_state':state,'next_gate':next_gate},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
