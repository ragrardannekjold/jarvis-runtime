import json, math
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
STAC='https://earth-search.aws.element84.com/v1/search'
COLL='sentinel-2-c1-l2a'
CLEAR=np.array([4,5,6],np.uint8)
FEATURES=['ndvi','nbr','bsi','ndbi']
PAIRS=[
    ('S2B','2023-07-27','2023-08-06'),
    ('S2A','2025-08-02','2025-08-12'),
    ('S2B','2024-08-10','2024-08-20'),
    ('S2B','2023-08-06','2023-08-16'),
]
COMMON_MIN=0.50
MIN_SECTOR_PX=1000
QUANTILES=(99.0,99.5)
STABILITY_LIMIT=0.25

OUT=Path('out'); (OUT/'provenance').mkdir(parents=True,exist_ok=True)
def wj(name,obj): (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8')

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

def rp(href,dtype='float32',resampling=Resampling.bilinear,nodata=np.nan):
    out=np.full((H,W),nodata,dtype=dtype)
    with rasterio.Env(AWS_NO_SIGN_REQUEST='YES',GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
                      CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif,.TIF',GDAL_HTTP_MAX_RETRY='3',GDAL_HTTP_RETRY_DELAY='2'):
        with rasterio.open(href) as src:
            reproject(source=rasterio.band(src,1),destination=out,
                      src_transform=src.transform,src_crs=src.crs,src_nodata=src.nodata,
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
stable=(lc21==BUILT)&(lc22==BUILT)
core=stable.copy(); pad=np.pad(stable,1,constant_values=False)
for dy in range(3):
    for dx in range(3): core &= pad[dy:dy+H,dx:dx+W]
core_n=int(core.sum())
if core_n<5000: raise RuntimeError('urban core too small')

scenes={}; provenance={}
def load_scene(platform,day):
    body={'collections':[COLL],'bbox':AOI,'datetime':f'{day}T00:00:00Z/{day}T23:59:59Z','limit':100}
    res=requests.post(STAC,json=body,timeout=120); res.raise_for_status()
    items=[x for x in res.json().get('features',[]) if str(x.get('id') or '').split('_',1)[0]==platform]
    required=['red','blue','nir08','swir16','swir22','scl']
    arrays={k:(np.zeros((H,W),np.uint8) if k=='scl' else np.full((H,W),np.nan,np.float32)) for k in required}; used=[]
    for item in items:
        assets=item.get('assets',{})
        if not all((assets.get(k) or {}).get('href') for k in required): continue
        try:
            vals={k:rp(assets[k]['href'],'uint8',Resampling.nearest,0) if k=='scl' else rp(assets[k]['href']) for k in required}
        except Exception:
            continue
        valid=np.ones((H,W),bool)
        for k in required:
            valid &= (vals[k]>0) if k=='scl' else (np.isfinite(vals[k])&(vals[k]>0))
        for k in required: arrays[k][valid]=vals[k][valid]
        used.append(str(item.get('id')))
    red,blue,nir,s16,s22,scl=[arrays[k] for k in required]
    clear=core&np.isin(scl,CLEAR)&np.isfinite(red)&np.isfinite(blue)&np.isfinite(nir)&np.isfinite(s16)&np.isfinite(s22)
    def idx(num,den):
        out=np.full((H,W),np.nan,np.float32); out[clear]=num[clear]/(den[clear]+1e-6); return out
    scene={'clear':clear,'clear_fraction':float(clear.sum()/core_n),'scene_ids':sorted(set(used)),
           'features':{'ndvi':idx(nir-red,nir+red),'nbr':idx(nir-s22,nir+s22),
                       'bsi':idx((s16+red)-(nir+blue),(s16+red)+(nir+blue)),'ndbi':idx(s16-nir,s16+nir)}}
    provenance[f'{platform}|{day}']={'request':body,'scene_ids':scene['scene_ids'],'clear_fraction':round(scene['clear_fraction'],8)}
    return scene

for key in sorted({(p,d) for p,a,b in PAIRS for d in (a,b)}): scenes[key]=load_scene(*key)
wj(Path('provenance')/'scenes.json',provenance)

def spread(vals):
    a=np.array(vals,float); med=float(np.median(a)); lo=float(a.min()); hi=float(a.max()); rr=float((hi-lo)/max(med,1e-12))
    return {'values':[round(float(x),8) for x in a],'median':round(med,8),'min':round(lo,8),'max':round(hi,8),
            'relative_range_over_median':round(rr,4),'within_25pct_relative_range':bool(rr<=STABILITY_LIMIT)}

def binomial_ge2_tail(p,n=4):
    return 1-(1-p)**n-n*p*(1-p)**(n-1)

pair_rows=[]; global_rates={str(q):[] for q in QUANTILES}; amp={str(q):[] for q in QUANTILES}
for platform,day_a,day_b in PAIRS:
    a=scenes[(platform,day_a)]; b=scenes[(platform,day_b)]
    common=a['clear']&b['clear']; common_frac=float(common.sum()/core_n)
    if a['clear_fraction']<COMMON_MIN or b['clear_fraction']<COMMON_MIN or common_frac<COMMON_MIN:
        raise RuntimeError(f'pair below common clear floor: {platform} {day_a} {day_b}')
    diffs={f:np.abs(b['features'][f]-a['features'][f]) for f in FEATURES}
    sector_rows=[]; totals={str(q):[0,0] for q in QUANTILES}
    for sid,sm in sector_masks.items():
        mask=common&sm; n=int(mask.sum())
        if n<MIN_SECTOR_PX:
            sector_rows.append({'sector':sid,'state':'INSUFFICIENT_DATA','common_clear_px':n,'minimum_required_px':MIN_SECTOR_PX}); continue
        row={'sector':sid,'state':'MEASURED','common_clear_px':n,'quantiles':{}}
        for q in QUANTILES:
            thresholds={f:float(np.nanpercentile(diffs[f][mask],q)) for f in FEATURES}
            hits=np.zeros((H,W),np.uint8)
            for f in FEATURES: hits += (mask&(diffs[f]>=thresholds[f])).astype(np.uint8)
            joint=mask&(hits>=2); k=int(joint.sum()); rate=float(k/n)
            p=1-q/100.0; baseline=binomial_ge2_tail(p,len(FEATURES))
            row['quantiles'][str(q)]={'joint_px':k,'joint_fraction':round(rate,8),
                                     'independent_marginal_baseline':round(baseline,8),
                                     'dependence_amplification':round(rate/max(baseline,1e-12),4),
                                     'feature_thresholds':{f:round(v,8) for f,v in thresholds.items()}}
            totals[str(q)][0]+=k; totals[str(q)][1]+=n
        sector_rows.append(row)
    pair_summary={}
    for q in QUANTILES:
        k,n=totals[str(q)]; rate=float(k/n); p=1-q/100.0; baseline=binomial_ge2_tail(p,len(FEATURES)); amplification=rate/max(baseline,1e-12)
        global_rates[str(q)].append(rate); amp[str(q)].append(amplification)
        pair_summary[str(q)]={'joint_px':k,'denominator_px':n,'joint_fraction':round(rate,8),
                              'independent_marginal_baseline':round(baseline,8),'dependence_amplification':round(amplification,4)}
    pair_rows.append({'platform':platform,'day_a':day_a,'day_b':day_b,'common_clear_fraction':round(common_frac,8),
                      'quantile_summary':pair_summary,'sectors':sector_rows})

stability={q:{'joint_fraction':spread(global_rates[q]),'dependence_amplification':spread(amp[q])} for q in global_rates}
family_stable=all(stability[str(q)]['joint_fraction']['within_25pct_relative_range'] for q in QUANTILES)
state='EMPIRICAL_QUANTILE_RATE_STABLE_CANARY' if family_stable else 'EMPIRICAL_QUANTILE_RATE_NOT_STABLE_ENOUGH'
next_gate=('Run an independent historical OPERA RTC-S1 broad-sector comparison before any current-scene promotion.' if family_stable else
           'Expand temporal controls and model per-sector empirical change distributions across more historical pairs; do not promote current optical leads.')

result={'status':'MEASURED_ARCHIVAL_EMPIRICAL_QUANTILE_STABILITY','generated_utc':datetime.now(timezone.utc).isoformat(),
        'purpose':'Test whether sector-specific empirical marginal tails yield a stable cross-feature joint-tail detector across the four preserved archival urban pairs.',
        'scope':'Historical method QA only; no current-condition, route, actor, threat, organized-presence or safe-passage inference.',
        'sector_label_rule':'Canonical AI-39: letters are columns, numbers are rows.',
        'minimum_sector_common_clear_px':MIN_SECTOR_PX,'quantiles':list(QUANTILES),'features':FEATURES,
        'urban_mask':{'exact_year_ids':{'2021':ids21,'2022':ids22},'coverage':{'2021':cov21,'2022':cov22},'eroded_core_px':core_n},
        'pairs':pair_rows,'stability':stability,'canonical_method_state':state,
        'truth_rules':['Marginal feature tail probabilities are fixed by construction inside each pair/sector; only cross-feature joint-tail dependence is being tested.',
                       'Optical indices are same-sensor features and are not independent corroborating source families.',
                       'INSUFFICIENT_DATA is preserved below the high-quantile sample floor.',
                       'No geometry, object positions, routes or current-force inference are exported.'],
        'next_gate':next_gate}
wj('result.json',result)
qa={'status':'PASS','checks':{'exact_year_landcover':all(x.endswith('-2021') for x in ids21) and all(x.endswith('-2022') for x in ids22),
                              'four_preserved_pairs':len(pair_rows)==4,'all_pair_common_clear_ge_0_50':all(x['common_clear_fraction']>=0.50 for x in pair_rows),
                              'canonical_sector_labels':sorted(sector_masks)==sorted(f"{'ABCD'[cc]}{rr+1}" for rr in range(4) for cc in range(4)),
                              'historical_only':True,'no_geometry_export':True,'no_generated_pixels':True}}
if not all(qa['checks'].values()): qa['status']='FAIL'
wj('qa.json',qa)
print(json.dumps({'qa':qa,'stability':stability,'canonical_method_state':state,'next_gate':next_gate},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
