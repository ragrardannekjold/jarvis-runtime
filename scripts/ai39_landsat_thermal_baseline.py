import json, math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import planetary_computer
import rasterio
from pystac_client import Client
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds

AOI=[37.65,48.25,38.25,48.90]
CRS='EPSG:32637'; RES=30; BUILT=7
PLATFORM='landsat-9'; WRS_PATH='176'; COLL='landsat-c2-l2'
WINDOWS={'2023':('2023-06-15','2023-09-15'),'2024':('2024-06-15','2024-09-15'),'2025':('2025-06-15','2025-09-15'),'2026':('2026-05-01','2026-08-01')}
MAX_PAIR_SCENE_CLOUD=35.0; MAX_PAIRS_PER_YEAR=4
DEFAULT_SCALE=0.00341802; DEFAULT_OFFSET=149.0
MIN_URBAN_COMMON=0.50; MIN_URBAN_SECTOR=300; MIN_REFERENCE_SECTOR=1000
MIN_MEASURED_PAIRS=8; MIN_VALUES_PER_SECTOR=6
OUT=Path('out'); (OUT/'provenance').mkdir(parents=True,exist_ok=True)

def wj(name,obj): (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8')

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

cat=Client.open('https://planetarycomputer.microsoft.com/api/stac/v1',modifier=planetary_computer.sign_inplace)

def rp(href,dtype='float32',resampling=Resampling.bilinear,nodata=np.nan):
    out=np.full((H,W),nodata,dtype=dtype)
    with rasterio.Env(AWS_NO_SIGN_REQUEST='YES',GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif,.TIF',GDAL_HTTP_MAX_RETRY='3',GDAL_HTTP_RETRY_DELAY='2'):
        with rasterio.open(href) as src:
            reproject(source=rasterio.band(src,1),destination=out,src_transform=src.transform,src_crs=src.crs,
                      src_nodata=src.nodata,dst_transform=TR,dst_crs=CRS,dst_nodata=nodata,resampling=resampling)
    return out

def landcover(year):
    items=list(cat.search(collections=['io-lulc-9-class'],bbox=AOI,datetime=f'{year}-01-01/{year}-12-31').items())
    items=[it for it in items if str(it.id).endswith(f'-{year}')]
    if not items: raise RuntimeError(f'no exact landcover {year}')
    arr=np.zeros((H,W),np.uint8); ids=[]
    for it in items:
        asset=it.assets.get('data') or it.assets.get('map') or next((a for a in it.assets.values() if a.href.lower().endswith(('.tif','.tiff'))),None)
        if asset is None: continue
        t=rp(asset.href,'uint8',Resampling.nearest,0); m=t>0; arr[m]=t[m]; ids.append(str(it.id))
    cov=float((arr>0).mean())
    if cov<0.95 or any(not x.endswith(f'-{year}') for x in ids): raise RuntimeError(f'landcover provenance failed {year}')
    return arr,sorted(ids),cov

lc21,ids21,cov21=landcover(2021); lc22,ids22,cov22=landcover(2022)
stable=(lc21==lc22); urban=stable&(lc21==BUILT)
pad=np.pad(urban,1,constant_values=False); core=urban.copy()
for dy in range(3):
    for dx in range(3): core &= pad[dy:dy+H,dx:dx+W]
reference=stable&np.isin(lc21,np.array([2,5,11],np.uint8))
core_n=int(core.sum()); ref_n=int(reference.sum())
if core_n<5000 or ref_n<5000: raise RuntimeError('mask too small')

def choose_assets(it):
    thermal=it.assets.get('lwir11')
    qa=None; qa_key=None
    for k,a in it.assets.items():
        txt=((a.title or '')+' '+(a.description or '')).lower()
        if k.lower() in ('qa_pixel','pixel_qa') or ('pixel' in txt and 'quality' in txt): qa=a; qa_key=k; break
    if thermal is None or qa is None: raise RuntimeError(f'missing thermal/qa on {it.id}')
    bands=thermal.extra_fields.get('raster:bands') or []
    if bands and bands[0].get('scale') is not None and bands[0].get('offset') is not None:
        scale=float(bands[0]['scale']); offset=float(bands[0]['offset']); src='asset_raster_bands'
    else:
        scale=DEFAULT_SCALE; offset=DEFAULT_OFFSET; src='USGS_C2_L2_default'
    return thermal,qa,qa_key,scale,offset,src

# Metadata-only selection first; thermal values are not examined for pair selection.
date_meta={}; pair_candidates=[]
for year,(start,end) in WINDOWS.items():
    items=list(cat.search(collections=[COLL],bbox=AOI,datetime=f'{start}/{end}').items())
    groups=defaultdict(list)
    for it in items:
        p=it.properties
        if str(p.get('platform'))!=PLATFORM or str(p.get('landsat:wrs_path') or '')!=WRS_PATH or 'L2SP' not in str(it.id) or 'lwir11' not in it.assets:
            continue
        day=(it.datetime or datetime.fromisoformat(str(p['datetime']).replace('Z','+00:00'))).date().isoformat()
        groups[day].append(it)
    for day,rr in groups.items():
        # Conservative scene-level discovery statistic: maximum cloud across intersecting WRS rows.
        clouds=[float(x.properties.get('eo:cloud_cover') if x.properties.get('eo:cloud_cover') is not None else 100) for x in rr]
        date_meta[day]={'year':year,'max_scene_cloud':max(clouds),'item_ids':[str(x.id) for x in rr]}
    days=sorted(groups)
    c=[]
    for i,a in enumerate(days):
        da=datetime.fromisoformat(a)
        for b in days[i+1:]:
            sep=(datetime.fromisoformat(b)-da).days
            if sep<16: continue
            if sep>16: break
            maxcloud=max(date_meta[a]['max_scene_cloud'],date_meta[b]['max_scene_cloud'])
            if maxcloud<=MAX_PAIR_SCENE_CLOUD:
                c.append({'year':year,'day_a':a,'day_b':b,'separation_days':16,'max_scene_cloud':round(maxcloud,3)})
    c.sort(key=lambda x:(x['max_scene_cloud'],x['day_a'],x['day_b']))
    pair_candidates.extend(c[:MAX_PAIRS_PER_YEAR])

if len(pair_candidates)<MIN_MEASURED_PAIRS: raise RuntimeError(f'too few metadata-selected pairs: {len(pair_candidates)}')
wj(Path('provenance')/'selection.json',{'platform':PLATFORM,'wrs_path':WRS_PATH,'selection':'same-platform same-path 16-day; <=35% conservative scene-cloud; up to 4 lowest-cloud pairs/year; selected before pixel temperatures are examined','pairs':pair_candidates})

scene_cache={}; scene_prov={}
def load_day(day):
    if day in scene_cache: return scene_cache[day]
    items=list(cat.search(collections=[COLL],bbox=AOI,datetime=f'{day}T00:00:00Z/{day}T23:59:59Z').items())
    items=[it for it in items if str(it.properties.get('platform'))==PLATFORM and str(it.properties.get('landsat:wrs_path') or '')==WRS_PATH and 'L2SP' in str(it.id)]
    dn=np.full((H,W),np.nan,np.float32); qa_out=np.zeros((H,W),np.uint16); valid_any=np.zeros((H,W),bool)
    scales=[]; prov=[]
    for it in sorted(items,key=lambda x:str(x.id)):
        thermal,qa,qk,scale,offset,src=choose_assets(it); scales.append((scale,offset))
        t=rp(thermal.href,'float32',Resampling.bilinear,np.nan); q=rp(qa.href,'uint16',Resampling.nearest,0)
        valid=np.isfinite(t)&(t>0); take=valid&(~valid_any); dn[take]=t[take]; qa_out[take]=q[take]; valid_any[take]=True
        prov.append({'item_id':str(it.id),'wrs_row':it.properties.get('landsat:wrs_row'),'cloud_cover':it.properties.get('eo:cloud_cover'),'qa_key':qk,'scale':scale,'offset':offset,'scale_source':src})
    if not scales or len(set(scales))!=1: raise RuntimeError(f'inconsistent/missing scale {day}: {scales}')
    scale,offset=scales[0]; kelvin=dn*scale+offset
    bad=(1<<0)|(1<<1)|(1<<2)|(1<<3)|(1<<4)|(1<<5)
    clear=valid_any&((qa_out&bad)==0)&np.isfinite(kelvin)&(kelvin>180)&(kelvin<380)
    scene_cache[day]=(kelvin,clear); scene_prov[day]=prov
    return scene_cache[day]

pair_rows=[]
for p in pair_candidates:
    ka,ca=load_day(p['day_a']); kb,cb=load_day(p['day_b']); common=ca&cb
    uall=core&common; rall=reference&common; uf=float(uall.sum()/core_n); rf=float(rall.sum()/ref_n)
    if uf<MIN_URBAN_COMMON:
        pair_rows.append({**p,'state':'INSUFFICIENT_DATA','urban_common_clear_fraction':round(uf,8),'reference_common_clear_fraction':round(rf,8),'sectors':[]}); continue
    sectors=[]; measured=0
    for sid,sm in sector_masks.items():
        u=uall&sm; r=rall&sm; un=int(u.sum()); rn=int(r.sum())
        if un<MIN_URBAN_SECTOR or rn<MIN_REFERENCE_SECTOR:
            sectors.append({'sector':sid,'state':'INSUFFICIENT_DATA','urban_common_clear_px':un,'reference_common_clear_px':rn}); continue
        ua=float(np.median(ka[u])); ub=float(np.median(kb[u])); ra=float(np.median(ka[r])); rb=float(np.median(kb[r]))
        caa=ua-ra; cab=ub-rb; delta=cab-caa
        # Hot-fraction context: fraction of urban pixels above same-sector stable-vegetation p95 on each date.
        r95a=float(np.percentile(ka[r],95)); r95b=float(np.percentile(kb[r],95))
        hfa=float((ka[u]>=r95a).mean()); hfb=float((kb[u]>=r95b).mean())
        sectors.append({'sector':sid,'state':'MEASURED','urban_common_clear_px':un,'reference_common_clear_px':rn,
                        'contrast_k_a':round(caa,5),'contrast_k_b':round(cab,5),'contrast_delta_k':round(delta,5),'abs_contrast_delta_k':round(abs(delta),5),
                        'urban_hot_fraction_vs_reference_p95_a':round(hfa,8),'urban_hot_fraction_vs_reference_p95_b':round(hfb,8),'abs_hot_fraction_delta':round(abs(hfb-hfa),8)})
        measured+=1
    state='MEASURED' if measured>=8 else 'INSUFFICIENT_DATA'
    pair_rows.append({**p,'state':state,'urban_common_clear_fraction':round(uf,8),'reference_common_clear_fraction':round(rf,8),'measured_sector_count':measured,'sectors':sectors})

wj(Path('provenance')/'scenes.json',scene_prov)
measured_pairs=[p for p in pair_rows if p['state']=='MEASURED']
years=sorted({p['year'] for p in measured_pairs})
common_sectors=set(sector_masks)
for p in measured_pairs: common_sectors &= {s['sector'] for s in p['sectors'] if s['state']=='MEASURED'}

sector_baseline={}
for sid in sector_masks:
    absd=[]; signed=[]; hotd=[]
    for p in measured_pairs:
        s=next((x for x in p['sectors'] if x['sector']==sid and x['state']=='MEASURED'),None)
        if s:
            absd.append(s['abs_contrast_delta_k']); signed.append(s['contrast_delta_k']); hotd.append(s['abs_hot_fraction_delta'])
    if len(absd)<MIN_VALUES_PER_SECTOR:
        sector_baseline[sid]={'state':'INSUFFICIENT_DATA','pair_count':len(absd)}; continue
    a=np.asarray(absd,float); h=np.asarray(hotd,float); sg=np.asarray(signed,float)
    sector_baseline[sid]={'state':'MEASURED','pair_count':len(absd),
                          'abs_contrast_delta_k':{'median':round(float(np.median(a)),5),'p75':round(float(np.percentile(a,75)),5),'p90':round(float(np.percentile(a,90)),5),'max':round(float(a.max()),5)},
                          'signed_contrast_delta_k':{'median':round(float(np.median(sg)),5),'p10':round(float(np.percentile(sg,10)),5),'p90':round(float(np.percentile(sg,90)),5)},
                          'abs_hot_fraction_delta':{'median':round(float(np.median(h)),8),'p90':round(float(np.percentile(h,90)),8),'max':round(float(h.max()),8)}}

baseline_sectors=sum(v['state']=='MEASURED' for v in sector_baseline.values())
state='THERMAL_CONTEXT_BASELINE_ESTABLISHED' if len(measured_pairs)>=MIN_MEASURED_PAIRS and len(years)>=3 and baseline_sectors>=12 else 'THERMAL_CONTEXT_BASELINE_INSUFFICIENT'
next_gate=('Use this Landsat TIRS historical sector envelope as an independent thermal context layer in a historical cross-sensor validation against the calibrated optical empirical-quantile method. Do not use it as actor/presence proof or current route guidance.' if state=='THERMAL_CONTEXT_BASELINE_ESTABLISHED' else
           'Expand historical Landsat TIRS controls without lowering pixel/cloud/sample floors before any cross-sensor test.')
result={'status':'LANDSAT_THERMAL_HISTORICAL_CONTEXT_BASELINE','generated_utc':datetime.now(timezone.utc).isoformat(),
        'purpose':'Establish a historical sector-wise Landsat TIRS surface-temperature context envelope using urban-vs-stable-vegetation contrast, independent of Sentinel-2 optical and OPERA SAR calibration.',
        'scope':'Historical method QA only; no current condition, actor, route, organized-presence or hazard inference.',
        'data_model':'Landsat-9 Collection-2 Level-2 lwir11 surface temperature with QA_PIXEL cloud/cirrus/shadow/snow masking, canonical 30 m AI-39 grid.',
        'selection':{'metadata_selected_pair_count':len(pair_candidates),'measured_pair_count':len(measured_pairs),'years_measured':years,'platform':PLATFORM,'wrs_path':WRS_PATH,'max_pairs_per_year':MAX_PAIRS_PER_YEAR,'max_scene_cloud':MAX_PAIR_SCENE_CLOUD},
        'mask':{'exact_year_ids':{'2021':ids21,'2022':ids22},'eroded_urban_core_px':core_n,'stable_vegetated_reference_px':ref_n},
        'common_measured_sector_count':len(common_sectors),'baseline_measured_sector_count':baseline_sectors,
        'pairs':pair_rows,'sector_baseline':sector_baseline,'canonical_method_state':state,
        'truth_rules':['Thermal contrast is physical surface-temperature context only; it is not actor, equipment, or organized-presence evidence by itself.',
                       'Pair selection is metadata/QA driven and was fixed before pair thermal outcomes were evaluated.',
                       'Stable trees/crops/rangeland are a broad same-sector contextual reference, not a perfect counterfactual.',
                       'No raster pixels, geometries, exact current positions or routes are exported.'],
        'next_gate':next_gate}
qa={'status':'PASS','checks':{'exact_year_mask':all(x.endswith('-2021') for x in ids21) and all(x.endswith('-2022') for x in ids22),
                              'metadata_pairs_ge_8':len(pair_candidates)>=MIN_MEASURED_PAIRS,
                              'measured_pairs_ge_8':len(measured_pairs)>=MIN_MEASURED_PAIRS,
                              'at_least_three_years':len(years)>=3,
                              'baseline_sectors_ge_12':baseline_sectors>=12,
                              'historical_only':True,'no_raster_export':True,'no_geometry_export':True}}
if not all(qa['checks'].values()): qa['status']='FAIL'
wj('result.json',result); wj('qa.json',qa)
print(json.dumps({'qa':qa,'state':state,'selection':result['selection'],'common_measured_sector_count':len(common_sectors),'baseline_measured_sector_count':baseline_sectors,
                  'pair_summaries':[{'year':p['year'],'day_a':p['day_a'],'day_b':p['day_b'],'state':p['state'],'urban_common_clear_fraction':p['urban_common_clear_fraction'],'measured_sector_count':p.get('measured_sector_count')} for p in pair_rows],
                  'next_gate':next_gate},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
