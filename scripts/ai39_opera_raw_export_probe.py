import json, math, re, tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.warp import transform_bounds

AOI=[37.65,48.25,38.25,48.90]
CRS=32637; RES=30
BASE='https://gis.earthdata.nasa.gov/image/rest/services/OPERA_L2_RTC_S1_V1'
SERVICES={'VV':f'{BASE}/OPERA_L2_RTC_S1_V1_VV/ImageServer','VH':f'{BASE}/OPERA_L2_RTC_S1_V1_VH/ImageServer'}
WINDOW=('2024-07-20','2024-09-05')
MIN_COMMON_BURSTS=4

out=Path('out'); out.mkdir(parents=True,exist_ok=True)

def epoch_ms(day,end=False):
    t='23:59:59+00:00' if end else '00:00:00+00:00'
    return int(datetime.fromisoformat(day+'T'+t).timestamp()*1000)

def query(service):
    params={
        'where':'1=1','geometry':','.join(map(str,AOI)),'geometryType':'esriGeometryEnvelope','inSR':4326,
        'spatialRel':'esriSpatialRelIntersects','outFields':'objectid,name,startdate,processingdate',
        'returnGeometry':'false','orderByFields':'startdate ASC','resultRecordCount':2000,
        'time':f'{epoch_ms(WINDOW[0])},{epoch_ms(WINDOW[1],True)}','f':'json'}
    r=requests.get(service+'/query',params=params,timeout=120); r.raise_for_status(); j=r.json()
    if j.get('error'): raise RuntimeError(j['error'])
    return j.get('features',[])

def parse_name(name):
    m=re.search(r'RTC-S1_([^_]+)_([0-9]{8}T[0-9]{6}Z)_[^_]+_(S1[A-Z])_',str(name or ''))
    if not m: return None
    return {'burst':m.group(1),'acq':m.group(2),'day':m.group(2)[:8],'sensor':m.group(3)}

def groups(features):
    g=defaultdict(dict)
    for feat in features:
        a=feat.get('attributes',{}); p=parse_name(a.get('name'))
        if not p: continue
        key=(p['sensor'],p['day'])
        oid=a.get('objectid',a.get('OBJECTID'))
        # If the service has duplicates, keep the greatest object id deterministically.
        old=g[key].get(p['burst'])
        if old is None or int(oid)>int(old): g[key][p['burst']]=int(oid)
    return g

def select_candidate(vv,vh):
    candidates=[]
    keys=sorted(set(vv)&set(vh))
    for i,k1 in enumerate(keys):
        sensor1,day1=k1
        d1=datetime.strptime(day1,'%Y%m%d')
        for k2 in keys[i+1:]:
            sensor2,day2=k2
            if sensor1!=sensor2: continue
            sep=(datetime.strptime(day2,'%Y%m%d')-d1).days
            if not 11<=sep<=13: continue
            common=set(vv[k1])&set(vv[k2])&set(vh[k1])&set(vh[k2])
            if len(common)>=MIN_COMMON_BURSTS:
                candidates.append((len(common),-abs(sep-12),day1,day2,sensor1,sorted(common)))
    if not candidates: raise RuntimeError('no dual-pol same-sensor 12-day candidate')
    candidates.sort(reverse=True)
    return candidates[0],candidates

left,bottom,right,top=transform_bounds('EPSG:4326',f'EPSG:{CRS}',*AOI,densify_pts=41)
left=math.floor(left/RES)*RES; bottom=math.floor(bottom/RES)*RES
right=math.ceil(right/RES)*RES; top=math.ceil(top/RES)*RES
W=int(round((right-left)/RES)); H=int(round((top-bottom)/RES))

def export(service,ids,path):
    params={
        'bbox':f'{left},{bottom},{right},{top}','bboxSR':CRS,'imageSR':CRS,
        'size':f'{W},{H}','format':'tiff','pixelType':'F32','interpolation':'RSP_BilinearInterpolation',
        'mosaicRule':json.dumps({'mosaicMethod':'esriMosaicLockRaster','lockRasterIds':ids}),
        'renderingRule':json.dumps({'rasterFunction':'Sentinel-1 RTC Power'}),'f':'image'}
    r=requests.get(service+'/exportImage',params=params,timeout=180)
    if r.status_code!=200 or len(r.content)<1024:
        raise RuntimeError(f'export failed {r.status_code} {r.headers.get("content-type")} {r.text[:500]}')
    Path(path).write_bytes(r.content)

def stats(path):
    with rasterio.open(path) as src:
        arr=src.read(1,masked=False).astype(np.float32)
        finite=np.isfinite(arr); pos=finite&(arr>0)
        vals=arr[pos]
        if vals.size<100: raise RuntimeError('too few positive raw samples')
        sample=vals[::max(1,vals.size//200000)]
        return {
            'dtype':str(src.dtypes[0]),'width':src.width,'height':src.height,'crs':str(src.crs),
            'finite_fraction':round(float(finite.mean()),8),'positive_fraction':round(float(pos.mean()),8),
            'positive_min':round(float(vals.min()),8),'positive_median':round(float(np.median(sample)),8),
            'positive_p99':round(float(np.percentile(sample,99)),8),'positive_max':round(float(vals.max()),8),
            'sample_unique_count':int(np.unique(sample).size)}

features={pol:query(svc) for pol,svc in SERVICES.items()}
g={pol:groups(fs) for pol,fs in features.items()}
(best,candidates)=select_candidate(g['VV'],g['VH'])
common_count,_,day1,day2,sensor,bursts=best
records={}
with tempfile.TemporaryDirectory() as td:
    for pol,svc in SERVICES.items():
        for label,day in [('a',day1),('b',day2)]:
            ids=[g[pol][(sensor,day)][b] for b in bursts]
            p=Path(td)/f'{pol}_{label}.tif'
            export(svc,ids,p)
            records[f'{pol}_{label}']=stats(p)
    arrays={}
    for pol in SERVICES:
        for label in ('a','b'):
            with rasterio.open(Path(td)/f'{pol}_{label}.tif') as src:
                arrays[f'{pol}_{label}']=src.read(1).astype(np.float32)
    valid=np.ones((H,W),bool)
    for a in arrays.values(): valid &= np.isfinite(a)&(a>0)
    overlap=float(valid.mean())

qa_checks={
    'dual_pol_services':all(len(features[p])>0 for p in SERVICES),
    'same_sensor_12day_candidate':common_count>=MIN_COMMON_BURSTS,
    'requested_grid_shape':all(x['width']==W and x['height']==H for x in records.values()),
    'float_rasters':all(x['dtype'].startswith('float') for x in records.values()),
    'continuous_values':all(x['sample_unique_count']>1000 for x in records.values()),
    'positive_overlap_gt_5pct':overlap>0.05,
    'historical_only':True,'no_raster_export_artifact':True,'no_geometry_export':True}
qa={'status':'PASS' if all(qa_checks.values()) else 'FAIL','checks':qa_checks}
result={
    'status':'OPERA_RAW_POWER_EXPORT_PROBE','generated_utc':datetime.now(timezone.utc).isoformat(),
    'scope':'Historical raw-power access and grid QA only; no current-condition, actor, route, or hazard inference.',
    'service_claim':'F32 OPERA RTC-S1 power via NASA EGIS lock-raster mosaic.',
    'selected_pair':{'year':day1[:4],'separation_days':(datetime.strptime(day2,'%Y%m%d')-datetime.strptime(day1,'%Y%m%d')).days,
                     'sensor':sensor,'common_burst_count':common_count},
    'candidate_pair_count':len(candidates),'grid':{'width':W,'height':H,'resolution_m':RES,'crs':f'EPSG:{CRS}'},
    'raw_stats':records,'four_layer_positive_overlap_fraction':round(overlap,8),
    'truth_rules':['Probe validates technical pixel access only.','No surface-change inference is made.','No object IDs, burst IDs, raster pixels, or geometry are exported.']}
(out/'qa.json').write_text(json.dumps(qa,indent=2),encoding='utf-8')
(out/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({'qa':qa,'selected_pair':result['selected_pair'],'candidate_pair_count':len(candidates),'overlap':overlap,'raw_stats':records},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
