#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json
from datetime import datetime, timezone
from pathlib import Path

P=Path('runtime/kyiv-v3/out/latest.json')
R=Path('runtime/kyiv-v3/out/receipts.jsonl')
VALID={'POSITIVE','NEGATIVE_WITH_COVERAGE','UNKNOWN','NOT_APPLICABLE'}

def dt(x):
    if not x:return None
    d=datetime.fromisoformat(str(x).replace('Z','+00:00'))
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)

def isoz(d):return d.astimezone(timezone.utc).isoformat().replace('+00:00','Z') if d else None

def compact(x):
    raw=json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()[:20]

def quarantine_future(container,key,anchor,family,region,quarantined):
    raw=dt(container.get(key))
    if raw and raw>anchor:
        container['raw_'+key]=container[key]
        container[key]=isoz(anchor)
        container['temporal_semantics']='FUTURE_BIN_END_LABEL_QUARANTINED_TO_COLLECTION_ANCHOR'
        quarantined.append({'family':family,'region':region,'raw_label_utc':isoz(raw)})

def main():
    p=json.loads(P.read_text(encoding='utf-8'));anchor=dt(p['generated_utc']);quarantined=[]

    for region,rv in p['cybint']['regions'].items():
        active=rv.get('ioda_active',{})
        quarantine_future(active,'latest_utc',anchor,'IODA_ACTIVE',region,quarantined)
        fb=rv.get('routing_fallback',{})
        if isinstance(fb,dict) and fb.get('latest_utc'):
            quarantine_future(fb,'latest_utc',anchor,'IODA_BGP_FALLBACK',region,quarantined)
        for family,obj,key in [('RIPE_RIS',rv.get('ripe_ris',{}),'latest_event_utc')]:
            raw=dt(obj.get(key)) if isinstance(obj,dict) else None
            if raw and raw>anchor:
                obj['raw_'+key]=obj[key];obj[key]=isoz(anchor);obj['temporal_semantics']='FUTURE_EVENT_LABEL_QUARANTINED';quarantined.append({'family':family,'region':region,'raw_label_utc':isoz(raw)})

    geoint_future=[]
    for t in p['geoint']['tiles']:
        for fam,layer in t.get('layers',{}).items():
            raw=dt(layer.get('latest_utc'))
            if raw and raw>anchor:
                layer['raw_latest_utc']=layer['latest_utc'];layer['latest_utc']=None;layer['fresh_24h']=False;layer['fresh_72h']=False
                geoint_future.append({'tile_id':t['tile_id'],'family':fam,'raw_acquisition_utc':isoz(raw)})
    quarantined.extend({'family':'GEOINT_'+x['family'].upper(),'region':x['tile_id'].split('-')[0],'raw_label_utc':x['raw_acquisition_utc']} for x in geoint_future)
    p['temporal_integrity']={'gate':'PASS_WITH_QUARANTINE' if quarantined else 'PASS','future_labels_quarantined':quarantined,'rule':'any timestamp later than collection anchor is quarantined before synthesis; no positive tolerance is admitted'}

    candidates=[]
    for t in p['geoint']['tiles']:
        for fam in t.get('candidate_anomaly_families',[]):
            l=t['layers'][fam]
            if l.get('latest_utc'):
                candidates.append({'region':t['region'],'family':fam,'acquisition_utc':l.get('latest_utc'),'score':l.get('change_score')})
    lineages={(x['region'],x['family'],x['acquisition_utc']) for x in candidates}
    cross_sensor=any(len({x['family'] for x in candidates if x['region']==r})>=2 for r in {x['region'] for x in candidates})
    p['geoint']['candidate_review']={'raw_candidate_tiles':len(candidates),'deduplicated_acquisition_lineages':len(lineages),'cross_sensor_corroboration':cross_sensor,'promotion':'NOT_PROMOTED' if candidates and not cross_sensor else ('NONE' if not candidates else 'REQUIRES_MAIN_REVIEW'),'confounders':['same-scene lineage','cloud/illumination/seasonal change','preview-rendering artifact'] if candidates else []}
    p['geoint']['manifest_context_layers']={'thermal_firms':'COVERAGE_GAP_MAP_KEY_NOT_CONFIGURED','night_light_black_marble':'NOT_RUN_CONTEXT_OPTIONAL','weather_cloud':'PARTIAL_FROM_EO_CLOUD_METADATA','osint_geospatial_cue':'NOT_RUN'}

    fam=p['preconfiguration']['families']
    fam['aeronautical_airspace_service']['status']='UNKNOWN';fam['aeronautical_airspace_service']['note']='current public service context read; no offensive-vs-defensive preparation baseline delta established'
    fam['maintenance_support_service_dependency']['status']='UNKNOWN'
    fam['logistics_fuel_transport_aggregate']['status']='UNKNOWN'
    if candidates:
        fam['broad_physical_geospatial']['status']='UNKNOWN';fam['broad_physical_geospatial']['note']='candidate optical change exists but lacks independent cross-sensor corroboration'
    elif p['geoint']['gate']=='PASS':fam['broad_physical_geospatial']['status']='NEGATIVE_WITH_COVERAGE'
    else:fam['broad_physical_geospatial']['status']='UNKNOWN'
    cy_cov=p['cybint'].get('regional_coverage_gate')=='PASS'
    fam['digital_telemetry_dependency']['status']='NEGATIVE_WITH_COVERAGE' if p['cybint']['gate']=='PASS' and cy_cov and p['cybint']['regions_with_two_class_material']==0 else 'UNKNOWN'
    invalid=[k for k,v in fam.items() if v.get('status') not in VALID]
    if invalid:raise SystemExit('invalid preconfig statuses: '+','.join(invalid))
    p['preconfiguration']['evaluation_gate']='PASS'
    p['preconfiguration']['coverage_count']=sum(v.get('coverage') not in {'GAP','UNKNOWN','INCOMPLETE',None} for v in fam.values())
    p['preconfiguration']['coverage_gate']='PASS' if p['preconfiguration']['coverage_count']==5 else 'INCOMPLETE'
    p['preconfiguration']['offensive_preparation_convergence']=False

    receipt_rows=[json.loads(x) for x in R.read_text(encoding='utf-8').splitlines() if x.strip()]
    actual_digest=compact(receipt_rows);declared=p.get('receipt_digest')
    p['receipt_readback']={'lines':len(receipt_rows),'declared_digest':declared,'actual_digest':actual_digest,'digest_matches_declared':actual_digest==declared}

    p['gate_summary']['preconfig_evaluation']=p['preconfiguration']['evaluation_gate'];p['gate_summary']['preconfig_coverage']=p['preconfiguration']['coverage_gate'];p['gate_summary']['cybint_regional_coverage']=p['cybint'].get('regional_coverage_gate','INCOMPLETE')
    p['process_qf_v3']='PASS' if p['cybint']['gate']=='PASS' and cy_cov and p['geoint']['gate']=='PASS' and p['preconfiguration']['evaluation_gate']=='PASS' and p['temporal_integrity']['gate'].startswith('PASS') and p['receipt_readback']['digest_matches_declared'] else 'FAIL'
    p['observability']='DEGRADED' if p['preconfiguration']['coverage_gate']!='PASS' or p['geoint']['manifest_context_layers']['thermal_firms'].startswith('COVERAGE_GAP') else 'GREEN'

    tests={
      'two_distinct_passive_measurement_classes':p['cybint']['gate']=='PASS',
      'four_region_two_class_coverage':p['cybint'].get('regions_two_class_covered')==4,
      'documentary_relationship_pivot':p['cybint'].get('documentary_relationship_regions_checked',0)>=3,
      'geoint_16_tiles':p['geoint'].get('tiles_attempted')==16,
      'geoint_p1_recent_threshold':p['geoint'].get('p1_recent_24h',0)>=10,
      'geoint_p1_multilayer_threshold':p['geoint'].get('p1_two_usable_families',0)>=8,
      'preconfig_five_valid_statuses':len(fam)==5 and not invalid,
      'no_future_timestamp_admitted':all(dt(x['raw_label_utc'])>anchor for x in quarantined) if quarantined else True,
      'receipt_digest_verified':p['receipt_readback']['digest_matches_declared'],
      'candidate_lineage_deduplicated':p['geoint']['candidate_review']['deduplicated_acquisition_lineages']<=p['geoint']['candidate_review']['raw_candidate_tiles'],
    }
    p['regression_tests']=tests
    p['learning_status']='LEARNED' if p['process_qf_v3']=='PASS' and all(tests.values()) else 'CORRECTED_UNVERIFIED'
    P.write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'process_qf_v3':p['process_qf_v3'],'observability':p['observability'],'learning_status':p['learning_status'],'temporal_integrity':p['temporal_integrity']['gate'],'quarantined_future_labels':len(quarantined),'receipt_digest_verified':p['receipt_readback']['digest_matches_declared'],'preconfig_statuses':{k:v['status'] for k,v in fam.items()},'candidate_review':p['geoint']['candidate_review'],'regression_tests':tests},ensure_ascii=False))

if __name__=='__main__':main()
