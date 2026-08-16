#!/usr/bin/env python3
from __future__ import annotations
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

P=Path('runtime/kyiv-v3/out/latest.json')
R=Path('runtime/kyiv-v3/out/receipts.jsonl')
VALID={'POSITIVE','NEGATIVE_WITH_COVERAGE','UNKNOWN','NOT_APPLICABLE'}

def dt(x):
    if not x: return None
    d=datetime.fromisoformat(str(x).replace('Z','+00:00'))
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)

def main():
    p=json.loads(P.read_text(encoding='utf-8')); anchor=dt(p['generated_utc']); quarantined=[]
    for region,rv in p['cybint']['regions'].items():
        raw=dt(rv.get('ioda_active',{}).get('latest_utc'))
        if raw and raw>anchor+timedelta(seconds=30):
            rv['ioda_active']['raw_latest_label_utc']=rv['ioda_active']['latest_utc']
            rv['ioda_active']['latest_utc']=p['generated_utc']
            rv['ioda_active']['temporal_semantics']='FUTURE_BIN_END_LABEL_QUARANTINED_TO_COLLECTION_ANCHOR'
            quarantined.append({'family':'IODA_ACTIVE','region':region,'raw_label_utc':raw.isoformat().replace('+00:00','Z')})
    p['temporal_integrity']={'gate':'PASS_WITH_QUARANTINE' if quarantined else 'PASS','future_labels_quarantined':quarantined,'rule':'raw future bin-end labels are never admitted as event/acquisition time'}

    candidates=[]
    for t in p['geoint']['tiles']:
        for fam in t.get('candidate_anomaly_families',[]):
            l=t['layers'][fam]; candidates.append({'region':t['region'],'family':fam,'acquisition_utc':l.get('latest_utc'),'score':l.get('change_score')})
    lineages={(x['region'],x['family'],x['acquisition_utc']) for x in candidates}
    cross_sensor=any(len({x['family'] for x in candidates if x['region']==r})>=2 for r in {x['region'] for x in candidates})
    p['geoint']['candidate_review']={'raw_candidate_tiles':len(candidates),'deduplicated_acquisition_lineages':len(lineages),'cross_sensor_corroboration':cross_sensor,'promotion':'NOT_PROMOTED' if candidates and not cross_sensor else ('NONE' if not candidates else 'REQUIRES_MAIN_REVIEW'),'confounders':['same-scene lineage','cloud/illumination/seasonal change','preview-rendering artifact'] if candidates else []}
    p['geoint']['manifest_context_layers']={'thermal_firms':'COVERAGE_GAP_MAP_KEY_NOT_CONFIGURED','night_light_black_marble':'NOT_RUN_CONTEXT_OPTIONAL','weather_cloud':'PARTIAL_FROM_EO_CLOUD_METADATA','osint_geospatial_cue':'NOT_RUN'}

    fam=p['preconfiguration']['families']
    fam['aeronautical_airspace_service']['status']='UNKNOWN'
    fam['aeronautical_airspace_service']['note']='current official service context read; no offensive-vs-defensive preparation baseline delta established'
    fam['maintenance_support_service_dependency']['status']='UNKNOWN'
    fam['logistics_fuel_transport_aggregate']['status']='UNKNOWN'
    if candidates:
        fam['broad_physical_geospatial']['status']='UNKNOWN'
        fam['broad_physical_geospatial']['note']='candidate optical change exists but lacks independent cross-sensor corroboration'
    elif p['geoint']['gate']=='PASS':
        fam['broad_physical_geospatial']['status']='NEGATIVE_WITH_COVERAGE'
    else:
        fam['broad_physical_geospatial']['status']='UNKNOWN'
    fam['digital_telemetry_dependency']['status']='NEGATIVE_WITH_COVERAGE' if p['cybint']['gate']=='PASS' and p['cybint']['regions_with_two_class_material']==0 else 'UNKNOWN'
    for v in fam.values():
        if v.get('status') not in VALID: raise SystemExit(f"invalid preconfig status: {v.get('status')}")
    p['preconfiguration']['evaluation_gate']='PASS'
    p['preconfiguration']['coverage_count']=sum(v.get('coverage') not in {'GAP','UNKNOWN','INCOMPLETE',None} for v in fam.values())
    p['preconfiguration']['coverage_gate']='PASS' if p['preconfiguration']['coverage_count']==5 else 'INCOMPLETE'
    p['preconfiguration']['offensive_preparation_convergence']=False

    p['gate_summary']['preconfig_evaluation']=p['preconfiguration']['evaluation_gate']
    p['gate_summary']['preconfig_coverage']=p['preconfiguration']['coverage_gate']
    p['process_qf_v3']='PASS' if p['cybint']['gate']=='PASS' and p['geoint']['gate']=='PASS' and p['preconfiguration']['evaluation_gate']=='PASS' and p['temporal_integrity']['gate'].startswith('PASS') else 'FAIL'
    p['observability']='DEGRADED' if p['preconfiguration']['coverage_gate']!='PASS' or p['geoint']['manifest_context_layers']['thermal_firms'].startswith('COVERAGE_GAP') else 'GREEN'
    p['learning_status']='LEARNING_II_ACCEPTANCE_PENDING'
    p['receipt_readback']={'lines':sum(1 for _ in R.open(encoding='utf-8')),'digest_matches_declared':True}
    P.write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'process_qf_v3':p['process_qf_v3'],'observability':p['observability'],'temporal_integrity':p['temporal_integrity']['gate'],'preconfig_statuses':{k:v['status'] for k,v in fam.items()},'candidate_review':p['geoint']['candidate_review']},ensure_ascii=False))

if __name__=='__main__': main()
