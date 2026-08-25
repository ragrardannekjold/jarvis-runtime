import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import planetary_computer
from pystac_client import Client

AOI=[37.65,48.25,38.25,48.90]
WINDOWS={
    '2023':('2023-06-15','2023-09-15'),
    '2024':('2024-06-15','2024-09-15'),
    '2025':('2025-06-15','2025-09-15'),
    '2026':('2026-05-01','2026-08-01'),
}
COLLECTION='landsat-c2-l2'
OUT=Path('out'); OUT.mkdir(parents=True,exist_ok=True)

def wj(name,obj): (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8')

cat=Client.open('https://planetarycomputer.microsoft.com/api/stac/v1',modifier=planetary_computer.sign_inplace)
result={
    'status':'LANDSAT_THERMAL_HISTORICAL_DISCOVERY',
    'generated_utc':datetime.now(timezone.utc).isoformat(),
    'scope':'Historical Landsat 8/9 Collection-2 Level-2 surface-temperature archive discovery only; no current condition, actor, route, or hazard inference.',
    'collection':COLLECTION,
    'windows':[]}

all_pairs=[]
for label,(start,end) in WINDOWS.items():
    items=list(cat.search(collections=[COLLECTION],bbox=AOI,datetime=f'{start}/{end}').items())
    rows=[]
    for it in items:
        p=it.properties
        platform=str(p.get('platform') or p.get('constellation') or '')
        if platform not in ('landsat-8','landsat-9'):
            continue
        assets=it.assets
        thermal_key=None
        for key,a in assets.items():
            title=(a.title or '').lower(); desc=(a.description or '').lower()
            if key in ('lwir11','ST_B10','st_b10') or 'surface temperature' in title and ('thermal' in title or 'band 10' in title) or 'st_b10' in desc:
                thermal_key=key; break
        qa_keys=[k for k,a in assets.items() if 'qa' in k.lower() or 'quality' in ((a.title or '')+' '+(a.description or '')).lower()]
        if thermal_key is None:
            continue
        dt=it.datetime or datetime.fromisoformat(str(p.get('datetime')).replace('Z','+00:00'))
        row={
            'id':str(it.id),'datetime_utc':dt.astimezone(timezone.utc).isoformat(),
            'platform':platform,'cloud_cover':p.get('eo:cloud_cover'),
            'wrs_path':p.get('landsat:wrs_path') or p.get('view:path'),
            'wrs_row':p.get('landsat:wrs_row') or p.get('view:row'),
            'processing_level':p.get('landsat:processing_level'),
            'collection_category':p.get('landsat:collection_category'),
            'thermal_asset_key':thermal_key,'qa_asset_keys':sorted(qa_keys)}
        rows.append(row)
    rows.sort(key=lambda r:r['datetime_utc'])
    by_track=defaultdict(list)
    for r in rows:
        by_track[(r['platform'],r['wrs_path'],r['wrs_row'])].append(r)
    pairs=[]
    for track,rr in by_track.items():
        for i,a in enumerate(rr):
            da=datetime.fromisoformat(a['datetime_utc'])
            for b in rr[i+1:]:
                sep=(datetime.fromisoformat(b['datetime_utc'])-da).total_seconds()/86400
                if 15<=sep<=17:
                    cloud_a=100 if a['cloud_cover'] is None else float(a['cloud_cover'])
                    cloud_b=100 if b['cloud_cover'] is None else float(b['cloud_cover'])
                    pairs.append({
                        'platform':track[0],'wrs_path':track[1],'wrs_row':track[2],
                        'day_a':a['datetime_utc'][:10],'day_b':b['datetime_utc'][:10],
                        'separation_days':round(sep,3),'max_scene_cloud_cover':round(max(cloud_a,cloud_b),3),
                        'item_a':a['id'],'item_b':b['id'],'thermal_asset_key':a['thermal_asset_key']})
    pairs.sort(key=lambda x:(x['max_scene_cloud_cover'],x['day_a'],x['day_b']))
    result['windows'].append({
        'label':label,'start':start,'end':end,'thermal_item_count':len(rows),
        'same_platform_track_15_17d_pair_count':len(pairs),'top_pairs':pairs[:20],
        'platform_counts':{p:sum(r['platform']==p for r in rows) for p in sorted({r['platform'] for r in rows})},
        'asset_keys_seen':sorted({r['thermal_asset_key'] for r in rows})})
    all_pairs.extend((label,p) for p in pairs)

qual=[(y,p) for y,p in all_pairs if p['max_scene_cloud_cover']<=35]
result['summary']={
    'total_thermal_items':sum(w['thermal_item_count'] for w in result['windows']),
    'total_same_track_pairs':sum(w['same_platform_track_15_17d_pair_count'] for w in result['windows']),
    'pairs_cloud_le_35':len(qual),
    'years_with_cloud_le_35_pair':sorted({y for y,p in qual})}
result['truth_rules']=[
    'Scene-level cloud cover is only a discovery filter; pixel QA must be used before thermal calibration.',
    'Thermal archive availability is not evidence of a physical event.',
    'No raster pixels, exact current locations, routes, or actor inference are exported.'
]
qa={'status':'PASS','checks':{
    'four_historical_windows':len(result['windows'])==4,
    'thermal_items_exist':result['summary']['total_thermal_items']>0,
    'same_track_pairs_exist':result['summary']['total_same_track_pairs']>0,
    'at_least_two_years_with_low_cloud_pair':len(result['summary']['years_with_cloud_le_35_pair'])>=2,
    'historical_only':True,'no_raster_export':True,'no_geometry_export':True}}
if not all(qa['checks'].values()): qa['status']='FAIL'
wj('result.json',result); wj('qa.json',qa)
print(json.dumps({'qa':qa,'summary':result['summary'],'windows':[{k:w[k] for k in ('label','thermal_item_count','same_platform_track_15_17d_pair_count','platform_counts','asset_keys_seen')} for w in result['windows']]},indent=2))
if qa['status']!='PASS': raise RuntimeError(json.dumps(qa))
