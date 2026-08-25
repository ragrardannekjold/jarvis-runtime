import json, math
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
PLATFORM='landsat-9'; WRS_PATH='176'; DAYS=['2024-08-09','2024-08-25']
COLL='landsat-c2-l2'
DEFAULT_SCALE=0.00341802; DEFAULT_OFFSET=149.0
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
stable=(lc21==lc22)
urban=(stable&(lc21==BUILT))
pad=np.pad(urban,1,constant_values=False); core=urban.copy()
for dy in range(3):
    for dx in range(3): core &= pad[dy:dy+H,dx:dx+W]
# Stable vegetated context only: trees=2, crops=5, rangeland=11.
reference=stable&np.isin(lc21,np.array([2,5,11],np.uint8))
core_n=int(core.sum()); ref_n=int(reference.sum())
if core_n<5000 or ref_n<5000: raise RuntimeError('mask too small')

def asset_scale_offset(asset):
    bands=asset.extra_fields.get('raster:bands') or []
    if bands:
        b=bands[0] or {}; scale=b.get('scale'); offset=b.get('offset')
        if scale is not None and offset is not None: return float(scale),float(offset),'asset_raster_bands'
    return DEFAULT_SCALE,DEFAULT_OFFSET,'USGS_C2_L2_default'

def choose_assets(it):
    thermal=it.assets.get('lwir11')
    if thermal is None:
        thermal=next((a for k,a in it.assets.items() if 'surface temperature' in ((a.title or '')+' '+(a.description or '')).lower() and ('band 10' in ((a.title or '')+' '+(a.description or '')).lower() or 'thermal' in ((a.title or '')+' '+(a.description or '')).lower())),None)
    qa=None; qa_key=None
    for k,a in it.assets.items():
        txt=((a.title or '')+' '+(a.description or '')).lower()
        if k.lower() in ('qa_pixel','pixel_qa') or ('pixel' in txt and 'quality' in txt): qa=a; qa_key=k; break
    if thermal is None or qa is None: raise RuntimeError(f'missing thermal/qa asset on {it.id}; keys={sorted(it.assets)}')
    return thermal,qa,qa_key

def load_day(day):
    items=list(cat.search(collections=[COLL],bbox=AOI,datetime=f'{day}T00:00:00Z/{day}T23:59:59Z').items())
    items=[it for it in items if str(it.properties.get('platform'))==PLATFORM and str(it.properties.get('landsat:wrs_path') or '')==WRS_PATH and 'L2SP' in str(it.id)]
    if not items: raise RuntimeError(f'no L2SP {PLATFORM} path {WRS_PATH} {day}')
    dn=np.full((H,W),np.nan,np.float32); qa_out=np.zeros((H,W),np.uint16); valid_any=np.zeros((H,W),bool)
    provenance=[]; scales=[]
    for it in sorted(items,key=lambda x:str(x.id)):
        thermal,qa,qa_key=choose_assets(it); scale,offset,scale_source=asset_scale_offset(thermal); scales.append((scale,offset))
        t=rp(thermal.href,'float32',Resampling.bilinear,np.nan)
        q=rp(qa.href,'uint16',Resampling.nearest,0)
        valid=np.isfinite(t)&(t>0)
        # Fill previously empty pixels; overlapping WRS rows from the same pass are equivalent observations for this probe.
        take=valid&(~valid_any)
        dn[take]=t[take]; qa_out[take]=q[take]; valid_any[take]=True
        provenance.append({'item_id':str(it.id),'wrs_row':it.properties.get('landsat:wrs_row'),'cloud_cover':it.properties.get('eo:cloud_cover'),
                           'thermal_key':'lwir11','qa_key':qa_key,'scale':scale,'offset':offset,'scale_source':scale_source})
    if len(set(scales))!=1: raise RuntimeError(f'inconsistent scales {scales}')
    scale,offset=scales[0]
    kelvin=dn*scale+offset
    # Collection 2 QA_PIXEL: reject fill, dilated cloud, cirrus, cloud, cloud shadow, snow.
    bad_bits=(1<<0)|(1<<1)|(1<<2)|(1<<3)|(1<<4)|(1<<5)
    clear=valid_any&((qa_out&bad_bits)==0)&np.isfinite(kelvin)&(kelvin>180)&(kelvin<380)
    return kelvin,clear,provenance

scenes={}; prov={}
for day in DAYS:
    k,c,p=load_day(day); scenes[day]=(k,c); prov[day]=p
wj(Path('provenance')/'scenes.json',prov)
ka,ca=scenes[DAYS[0]]; kb,cb=scenes[DAYS[1]]
common=ca&cb
urban_common=core&common; ref_common=reference&common
uc=int(urban_common.sum()); rc=int(ref_common.sum())
uf=float(uc/core_n); rf=float(rc/ref_n)
if uf<0.50: raise RuntimeError(f'urban common clear below 0.50: {uf}')

rows=[]; measured=0
for sid,sm in sector_masks.items():
    u=urban_common&sm; r=ref_common&sm; un=int(u.sum()); rn=int(r.sum())
    if un<300 or rn<1000:
        rows.append({'sector':sid,'state':'INSUFFICIENT_DATA','urban_common_clear_px':un,'reference_common_clear_px':rn}); continue
    ua=float(np.median(ka[u])); ub=float(np.median(kb[u])); ra=float(np.median(ka[r])); rb=float(np.median(kb[r]))
    caa=ua-ra; cab=ub-rb
    rows.append({'sector':sid,'state':'MEASURED','urban_common_clear_px':un,'reference_common_clear_px':rn,
                 'urban_median_k_a':round(ua,4),'urban_median_k_b':round(ub,4),
                 'reference_median_k_a':round(ra,4),'reference_median_k_b':round(rb,4),
                 'urban_reference_contrast_k_a':round(caa,4),'urban_reference_contrast_k_b':round(cab,4),
                 'abs_contrast_change_k':round(abs(cab-caa),4)})
    measured+=1

result={'status':'LANDSAT_THERMAL_PIXEL_QA_PROBE','generated_utc':datetime.now(timezone.utc).isoformat(),
        'scope':'Historical Landsat TIRS surface-temperature pixel/QA probe only; no current condition, actor, route, organized-presence or hazard inference.',
        'pair':{'platform':PLATFORM,'wrs_path':WRS_PATH,'day_a':DAYS[0],'day_b':DAYS[1],'separation_days':16},
        'grid':{'crs':CRS,'resolution_m':RES,'width':W,'height':H},
        'mask':{'exact_year_ids':{'2021':ids21,'2022':ids22},'eroded_urban_core_px':core_n,'stable_vegetated_reference_px':ref_n},
        'common_clear':{'urban_px':uc,'urban_fraction':round(uf,8),'reference_px':rc,'reference_fraction':round(rf,8)},
        'sector_count_measured':measured,'sectors':rows,
        'truth_rules':['Surface temperature uses Landsat Collection-2 Level-2 scaling; pixel QA rejects fill/cloud/cirrus/shadow/snow.',
                       'Stable vegetated land cover is used only as same-sector thermal context.',
                       'Urban-reference thermal contrast is physical temperature context, not actor/presence evidence.',
                       'No raster pixels, geometries, exact current positions or routes are exported.']}
qa={'status':'PASS','checks':{'exact_year_mask':all(x.endswith('-2021') for x in ids21) and all(x.endswith('-2022') for x in ids22),
                              'urban_common_clear_ge_0_50':uf>=0.50,'at_least_eight_measured_sectors':measured>=8,
                              'historical_only':True,'no_raster_export':True,'no_geometry_export':True}}
if not all(qa['checks'].values()): qa['status']='FAIL'
wj('result.json',result); wj('qa.json',qa)
print(json.dumps({'qa':qa,'pair':result['pair'],'common_clear':result['common_clear'],'sector_count_measured':measured,
                  'contrast_changes':[r['abs_contrast_change_k'] for r in rows if r['state']=='MEASURED']},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
