#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,math,statistics,time,urllib.error,urllib.parse,urllib.request
from datetime import datetime,timezone,timedelta
from pathlib import Path

P=Path('runtime/kyiv-v3/out/latest.json');R=Path('runtime/kyiv-v3/out/receipts.jsonl')
IODA='https://api.ioda.inetintel.cc.gatech.edu/v2';UA='KyivV3PublicCollector/1.2 (+defensive-civilian-safety; passive-only)'
REGIONS={'BRY':'Bryansk','KUR':'Kursk','BEL':'Belgorod','VOR':'Voronezh'}

def now():return datetime.now(timezone.utc)
def isoz(d):return d.astimezone(timezone.utc).isoformat().replace('+00:00','Z') if d else None

def pdt(v):
    if not v:return None
    if isinstance(v,(int,float)):
        try:return datetime.fromtimestamp(float(v),timezone.utc)
        except Exception:return None
    try:
        d=datetime.fromisoformat(str(v).replace('Z','+00:00'));return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except Exception:return None

def digest(b):return hashlib.sha256(b).hexdigest()
def compact(x):return digest(json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())[:20]

def fetch(url,cls,semantic,receipts,timeout=25):
    st=now();t=time.monotonic();status=0;raw=b'';err=None
    try:
        req=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'application/json,*/*;q=0.5'})
        with urllib.request.urlopen(req,timeout=timeout) as r:status=r.status;raw=r.read()
    except urllib.error.HTTPError as e:
        status=e.code;err=f'HTTP_{e.code}'
        try:raw=e.read()
        except Exception:pass
    except Exception as e:err=type(e).__name__
    receipts.append({'class':cls,'semantic':semantic,'started_utc':isoz(st),'ended_utc':isoz(now()),'host':urllib.parse.urlparse(url).netloc,'path':urllib.parse.urlparse(url).path,'status':status,'bytes':len(raw),'elapsed_ms':int((time.monotonic()-t)*1000),'sha256':digest(raw) if raw else None,'error':err})
    return status,raw

def jfetch(url,cls,semantic,receipts):
    s,b=fetch(url,cls,semantic,receipts)
    if s!=200 or not b:return None
    try:return json.loads(b.decode())
    except Exception:return None

def data_list(o):
    d=o.get('data') if isinstance(o,dict) else None;return [x for x in d if isinstance(x,dict)] if isinstance(d,list) else []

def walk(o):
    if isinstance(o,dict):
        if 'datasource' in o and 'values' in o:yield o
        for v in o.values():yield from walk(v)
    elif isinstance(o,list):
        for v in o:yield from walk(v)

def nums(v):
    out=[]
    if not isinstance(v,list):return out
    for x in v:
        y=x[-1] if isinstance(x,list) and x else x
        if isinstance(y,(int,float)) and math.isfinite(float(y)):out.append(float(y))
    return out

def tchange(v):
    if len(v)<6:return {'enough_points':False,'material_change':False}
    k=max(3,int(len(v)*.75));a=statistics.median(v[:k]);b=statistics.median(v[k:]);f=(b-a)/a if a else None
    return {'enough_points':True,'baseline':round(a,3),'recent':round(b,3),'fractional_change':round(f,4) if f is not None else None,'material_change':bool(f is not None and abs(f)>=.20)}

def resolve(name,receipts):
    q=urllib.parse.urlencode({'entityType':'region','search':name,'limit':30});o=jfetch(f'{IODA}/entities/query?{q}','relationship_metadata',f'IODA aggregate region resolution {name}',receipts)
    for x in data_list(o):
        if name.casefold() in str(x.get('name','')).casefold() and str(x.get('code','')).strip():return str(x['code']).strip()
    return None

def ioda_bgp(tag,name,receipts,anchor):
    code=resolve(name,receipts)
    if not code:return {'status':'UNAVAILABLE','fresh':False,'reason':'REGION_NOT_RESOLVED'}
    q=urllib.parse.urlencode({'from':int((anchor-timedelta(hours=6)).timestamp()),'until':int(anchor.timestamp()),'datasource':'bgp','maxPoints':180})
    o=jfetch(f'{IODA}/signals/raw/region/{urllib.parse.quote(code)}?{q}','routing_control_plane_fallback',f'IODA BGP aggregate routing fallback {tag}',receipts)
    vals=[];latest=None
    for s in walk(o):
        if str(s.get('datasource'))!='bgp':continue
        vals.extend(nums(s.get('values')));d=pdt(s.get('until'));latest=d if d and (not latest or d>latest) else latest
    raw_latest=latest
    if latest and latest>anchor:latest=anchor
    return {'status':'OK' if vals else 'NO_SERIES','fresh':bool(latest and anchor-latest<=timedelta(hours=6)),'latest_utc':isoz(latest),'raw_latest_label_utc':isoz(raw_latest) if raw_latest and raw_latest>anchor else None,'temporal_semantics':'FUTURE_BIN_END_LABEL_CLAMPED' if raw_latest and raw_latest>anchor else 'DIRECT','points':len(vals),'trend':tchange(vals),'measurement_class':'routing_control_plane','provider_independence':'SAME_PROVIDER_DIFFERENT_MEASUREMENT_CLASS'}

def main():
    p=json.loads(P.read_text(encoding='utf-8'));anchor=pdt(p['generated_utc']);receipts=[json.loads(x) for x in R.read_text(encoding='utf-8').splitlines() if x.strip()]
    covered=0;material_regions=[];pivot_checked=0
    for tag,name in REGIONS.items():
        rv=p['cybint']['regions'][tag];ripe=rv.get('ripe_ris',{});routing_ok=ripe.get('status')=='OK' and ripe.get('fresh') is True
        if not routing_ok:
            fb=ioda_bgp(tag,name,receipts,anchor);rv['routing_fallback']=fb;routing_ok=fb.get('status')=='OK' and fb.get('fresh') is True;routing_material=bool(fb.get('trend',{}).get('material_change'))
        else:
            rv['routing_fallback']={'status':'NOT_NEEDED'};routing_material=bool(ripe.get('material_churn'))
        active=rv.get('ioda_active',{});active_ok=active.get('status')=='OK' and active.get('fresh') is True;active_material=bool(active.get('trend',{}).get('material_drop'))
        rv['technical_two_class_coverage']=bool(active_ok and routing_ok);covered+=int(rv['technical_two_class_coverage'])
        rv['two_class_material']=bool(active_material and routing_material)
        if rv['two_class_material']:
            material_regions.append(tag)
            if rv.get('relationship_pivot') is True:
                rv['documentary_relationship_pivot']={'status':'CHECKED','source':'IODA_REGION_ASN_RELATION_METADATA'};pivot_checked+=1
            else:rv['documentary_relationship_pivot']={'status':'UNKNOWN','reason':'MATERIAL_DELTA_WITHOUT_RELATIONSHIP_PIVOT'}
        else:rv['documentary_relationship_pivot']={'status':'NOT_APPLICABLE','reason':'NO_TWO_CLASS_MATERIAL_DIGITAL_DELTA'}
    p['cybint']['regions_two_class_covered']=covered;p['cybint']['regions_with_two_class_material']=len(material_regions)
    p['cybint']['relationship_pivot_applicable_regions']=material_regions;p['cybint']['relationship_pivot_checked_applicable']=pivot_checked
    pivot_gate='NOT_APPLICABLE_NO_DELTA' if not material_regions else ('PASS' if pivot_checked==len(material_regions) else 'INCOMPLETE')
    p['cybint']['relationship_pivot_gate']=pivot_gate
    p['cybint']['regional_coverage_gate']='PASS' if covered==4 and pivot_gate!='INCOMPLETE' else 'INCOMPLETE'
    p['cybint']['cloudflare_radar_timeseries']='CREDENTIAL_GATED_API_TOKEN_REQUIRED'
    p['cybint']['independence_note']='IODA active probing and BGP are distinct measurement classes; Bryansk may use same-provider IODA BGP fallback, while RIPE RIS supplies independent routing lineage elsewhere. Relationship pivot becomes mandatory only for a material two-class digital delta.'
    R.write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in receipts),encoding='utf-8');p['receipt_count']=len(receipts);p['receipt_digest']=compact(receipts)
    P.write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'regions_two_class_covered':covered,'material_regions':material_regions,'relationship_pivot_gate':pivot_gate,'regional_coverage_gate':p['cybint']['regional_coverage_gate'],'receipt_count':len(receipts)},ensure_ascii=False))

if __name__=='__main__':main()
