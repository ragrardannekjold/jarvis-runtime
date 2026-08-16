#!/usr/bin/env python3
from __future__ import annotations

import hashlib, io, json, math, re, statistics, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from receipt_contract import (
    RECEIPT_SCHEMA_VERSION,
    build_receipt,
    finalize_json_receipt,
    finalize_non_json_receipt,
    finalize_parse_failure,
    run_id_from_environment,
    set_receipt_result,
)

UA = "KyivV3PublicCollector/1.3 (+defensive-civilian-safety; passive-only)"
IODA = "https://api.ioda.inetintel.cc.gatech.edu/v2"
RIPE = "https://stat.ripe.net/data/bgp-updates/data.json"
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"

# Broad public oblast envelopes only. Runtime output never emits these boxes.
AOIS = {
    "BRY": ("Bryansk", "P1", [31.20, 52.10, 35.35, 54.05]),
    "KUR": ("Kursk", "P1", [34.05, 50.90, 38.55, 52.55]),
    "BEL": ("Belgorod", "P1", [35.30, 49.75, 39.35, 51.45]),
    "VOR": ("Voronezh", "P2", [38.05, 49.45, 42.95, 52.15]),
}
LAYERS = {"sar":"sentinel-1-grd", "optical":"sentinel-2-l2a", "landsat":"landsat-c2-l2"}
ACTIVE_RUN_ID = ""


def now(): return datetime.now(timezone.utc)
def isoz(d): return d.astimezone(timezone.utc).isoformat().replace("+00:00","Z") if d else None

def pdt(v):
    if isinstance(v,(int,float)):
        try: return datetime.fromtimestamp(float(v),timezone.utc)
        except Exception: return None
    if not isinstance(v,str) or not v: return None
    try:
        d=datetime.fromisoformat(v.replace("Z","+00:00")); return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except Exception: return None

def digest(b): return hashlib.sha256(b).hexdigest()
def hobj(x): return digest(json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode())[:20]


def fetch(url, receipts, cls, semantic, *, payload=None, timeout=30):
    body=None; method="GET"; headers={"User-Agent":UA,"Accept":"application/json,image/*,*/*;q=0.5"}
    if payload is not None:
        method="POST"; body=json.dumps(payload).encode(); headers["Content-Type"]="application/json"
    st=now(); t=time.monotonic(); status=0; raw=b""; err=None
    try:
        req=urllib.request.Request(url,data=body,method=method,headers=headers)
        with urllib.request.urlopen(req,timeout=timeout) as r: status=r.status; raw=r.read()
    except urllib.error.HTTPError as e:
        status=e.code; err=f"HTTP_{e.code}"
        try: raw=e.read()
        except Exception: pass
    except Exception as e: err=type(e).__name__
    en=now(); receipts.append(build_receipt(
        run_id=ACTIVE_RUN_ID or run_id_from_environment(st),
        url=url,
        measurement_class=cls,
        query_id=semantic,
        started=st,
        ended=en,
        http_status=status,
        raw=raw,
        elapsed_ms=int((time.monotonic()-t)*1000),
        error=err,
        payload=payload,
    ))
    return status,raw


def jfetch(url, receipts, cls, semantic, *, payload=None):
    s,b=fetch(url,receipts,cls,semantic,payload=payload)
    if s!=200 or not b: return None
    try:
        obj=json.loads(b.decode()); finalize_json_receipt(receipts[-1],obj); return obj
    except Exception as e:
        finalize_parse_failure(receipts[-1],"JSON_PARSE_FAILED",type(e).__name__); return None


def walk_series(o):
    if isinstance(o,dict):
        if "datasource" in o and "values" in o: yield o
        for v in o.values(): yield from walk_series(v)
    elif isinstance(o,list):
        for v in o: yield from walk_series(v)


def nums(v):
    out=[]
    if not isinstance(v,list): return out
    for x in v:
        y=x[-1] if isinstance(x,list) and x else x
        if isinstance(y,(int,float)) and math.isfinite(float(y)): out.append(float(y))
    return out


def trend(vals):
    if len(vals)<6: return {"enough_points":False,"material_drop":False}
    k=max(3,int(len(vals)*.75)); a=statistics.median(vals[:k]); b=statistics.median(vals[k:]); f=(b-a)/a if a else None
    return {"enough_points":True,"baseline":round(a,3),"recent":round(b,3),"fractional_change":round(f,4) if f is not None else None,"material_drop":bool(f is not None and f<=-.20)}


def data_list(o):
    if not isinstance(o,dict): return []
    d=o.get("data"); return [x for x in d if isinstance(x,dict)] if isinstance(d,list) else []


def resolve_region(tag,name,receipts):
    q=urllib.parse.urlencode({"entityType":"region","search":name,"limit":30})
    o=jfetch(f"{IODA}/entities/query?{q}",receipts,"relationship_metadata",f"IODA region relation {tag}")
    if receipts:
        set_receipt_result(receipts[-1],"NOT_APPLICABLE","RELATIONSHIP_LOOKUP_ONLY",observation_opportunity=isinstance(o,dict))
    for x in data_list(o):
        n=str(x.get("name","")).casefold(); c=str(x.get("code","")).strip()
        if name.casefold() in n and c: return c
    return None


def collect_ioda(tag,code,receipts,t0):
    if not code: return {"status":"UNAVAILABLE","fresh":False,"reason":"REGION_NOT_RESOLVED"}
    q=urllib.parse.urlencode({"from":int((t0-timedelta(hours=6)).timestamp()),"until":int(t0.timestamp()),"datasource":"ping-slash24","maxPoints":180})
    o=jfetch(f"{IODA}/signals/raw/region/{urllib.parse.quote(code)}?{q}",receipts,"active_probing_reachability",f"IODA active probing {tag}")
    vals=[]; latest=None
    for s in walk_series(o):
        if str(s.get("datasource"))!="ping-slash24": continue
        vals.extend(nums(s.get("values"))); d=pdt(s.get("until")); latest=d if d and (not latest or d>latest) else latest
    raw_latest=latest
    if latest and latest>t0:
        latest=t0 if latest-t0<=timedelta(minutes=5) else None
    result={"status":"OK" if vals else "NO_SERIES","fresh":bool(latest and t0-latest<=timedelta(hours=6)),"latest_utc":isoz(latest),"points":len(vals),"trend":trend(vals)}
    if receipts:
        if raw_latest and raw_latest>t0:
            receipts[-1]["source_latest_raw_utc"]=isoz(raw_latest);receipts[-1]["temporal_semantics"]="FUTURE_BIN_END_LABEL_CLAMPED" if latest else "FUTURE_LABEL_QUARANTINED"
        observed=bool(vals and result["fresh"])
        semantic="DELTA_PRESENT" if observed and result["trend"].get("material_drop") else ("NO_DELTA_OBSERVED" if observed else "UNKNOWN")
        set_receipt_result(receipts[-1],semantic,"MATERIAL_REACHABILITY_DROP" if semantic=="DELTA_PRESENT" else ("NO_MATERIAL_REACHABILITY_DROP" if semantic=="NO_DELTA_OBSERVED" else "INSUFFICIENT_FRESH_PARSED_SERIES"),observation_opportunity=observed,source_latest=latest,record_count=len(vals))
    return result


def region_asns(tag,code,receipts):
    if not code: return []
    q=urllib.parse.urlencode({"entityType":"asn","relatedTo":f"region/{code}","limit":12,"page":1})
    o=jfetch(f"{IODA}/entities/query?{q}",receipts,"relationship_metadata",f"IODA region-ASN relation {tag}")
    if receipts:
        set_receipt_result(receipts[-1],"NOT_APPLICABLE","RELATIONSHIP_LOOKUP_ONLY",observation_opportunity=isinstance(o,dict))
    out=[]
    for x in data_list(o):
        c=str(x.get("code","")).upper().replace("AS","")
        if c.isdigit(): out.append("AS"+c)
    return out[:6]


def collect_ripe(tag,asns,receipts,t0):
    if not asns: return {"status":"UNAVAILABLE","fresh":False,"reason":"NO_ASN_RELATION_SET"}
    cur=prev=withd=total=0; latest=None; good=0
    region_receipts=[]
    for asn in asns:
        q=urllib.parse.urlencode({"resource":asn,"starttime":(t0-timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%S"),"endtime":t0.strftime("%Y-%m-%dT%H:%M:%S")})
        o=jfetch(f"{RIPE}?{q}",receipts,"routing_control_plane",f"RIPE RIS aggregate regional routing {tag}")
        if receipts: region_receipts.append(receipts[-1])
        d=o.get("data") if isinstance(o,dict) and isinstance(o.get("data"),dict) else None
        if not d: continue
        good+=1; ups=d.get("updates") if isinstance(d.get("updates"),list) else []; total+=int(d.get("nr_updates",len(ups)) or 0)
        for u in ups:
            if not isinstance(u,dict): continue
            dt=pdt(u.get("timestamp")); latest=dt if dt and (not latest or dt>latest) else latest
            if dt and dt>=t0-timedelta(hours=3): cur+=1
            elif dt: prev+=1
            if u.get("type")=="W": withd+=1
    material=bool(cur>=max(12,prev*3) and cur>prev+8)
    for receipt in region_receipts:
        parser_ok=receipt.get("parser",{}).get("status") in {"PARSED","PARSED_EMPTY"}
        observed=bool(parser_ok and receipt.get("freshness",{}).get("status")=="FRESH" and receipt.get("http_status")==200)
        set_receipt_result(receipt,"DELTA_PRESENT" if material and observed else ("NO_DELTA_OBSERVED" if observed else "UNKNOWN"),"MATERIAL_ROUTING_CHURN" if material and observed else ("NO_MATERIAL_ROUTING_CHURN" if observed else "INSUFFICIENT_PARSED_ROUTING_WINDOW"),observation_opportunity=observed)
    return {"status":"OK" if good else "NO_DATA","fresh":good>=1,"asn_queries_ok":good,"regional_asn_count":len(asns),"updates_6h":total,"updates_current_3h":cur,"updates_previous_3h":prev,"withdrawals_6h":withd,"latest_event_utc":isoz(latest),"material_churn":material}


def tiles():
    out=[]
    for tag,(name,pri,b) in AOIS.items():
        w,s,e,n=b; mx=(w+e)/2; my=(s+n)/2
        for i,bb in enumerate(([w,s,mx,my],[mx,s,e,my],[w,my,mx,n],[mx,my,e,n]),1): out.append((f"{tag}-{pri}-{i:02d}",tag,pri,bb))
    return out


def item_dt(x):
    p=x.get("properties") if isinstance(x.get("properties"),dict) else {}; return pdt(p.get("datetime") or p.get("start_datetime") or p.get("end_datetime"))

def cloud(x):
    p=x.get("properties") if isinstance(x.get("properties"),dict) else {}; v=p.get("eo:cloud_cover"); return float(v) if isinstance(v,(int,float)) else None

def preview(x):
    a=x.get("assets") if isinstance(x.get("assets"),dict) else {}
    for k in ("rendered_preview","preview","thumbnail"):
        if isinstance(a.get(k),dict) and isinstance(a[k].get("href"),str): return a[k]["href"]
    for l in x.get("links",[]) if isinstance(x.get("links"),list) else []:
        if isinstance(l,dict) and l.get("rel") in {"preview","thumbnail"} and isinstance(l.get("href"),str): return l["href"]
    return None


def pix(url,receipts,semantic):
    if not url: return None
    s,b=fetch(url,receipts,"raster_preview_readback",semantic,timeout=40)
    if s!=200 or not b: return None
    try:
        from PIL import Image,ImageStat
        im=Image.open(io.BytesIO(b)).convert("L").resize((64,64)); st=ImageStat.Stat(im); hist=im.histogram(); z=sum(hist) or 1; ps=[v/z for v in hist if v]
        finalize_non_json_receipt(receipts[-1],parser_status="IMAGE_PARSED",record_count=4096,source_latest=None,schema_id="RASTER_PREVIEW_64X64")
        set_receipt_result(receipts[-1],"NOT_APPLICABLE","PREVIEW_READBACK_ONLY_CHANGE_SEMANTIC_COMPUTED_SEPARATELY",observation_opportunity=True,record_count=4096)
        return {"mean":st.mean[0],"std":st.stddev[0],"entropy":-sum(p*math.log2(p) for p in ps),"hist":hist}
    except Exception as e:
        finalize_parse_failure(receipts[-1],"IMAGE_PARSE_FAILED",type(e).__name__); return None

def hdist(a,b):
    if not a or not b: return None
    za=sum(a["hist"]) or 1; zb=sum(b["hist"]) or 1; return .5*sum(abs(x/za-y/zb) for x,y in zip(a["hist"],b["hist"]))


def tile_collect(tile_id,tag,pri,bbox,receipts,t0):
    ls={}
    for fam,col in LAYERS.items():
        body={"collections":[col],"bbox":bbox,"datetime":f"{isoz(t0-timedelta(days=12))}/{isoz(t0)}","limit":8}
        o=jfetch(STAC,receipts,f"geoint_{fam}_catalog",f"STAC {fam} {tile_id}",payload=body)
        fs=o.get("features") if isinstance(o,dict) and isinstance(o.get("features"),list) else []; fs=[x for x in fs if isinstance(x,dict)]; fs.sort(key=lambda x:item_dt(x) or datetime.min.replace(tzinfo=timezone.utc),reverse=True)
        latest=fs[0] if fs else None; prior=fs[1] if len(fs)>1 else None; dt=item_dt(latest) if latest else None; age=(t0-dt).total_seconds()/3600 if dt else None; cc=cloud(latest) if latest else None
        if receipts:
            set_receipt_result(receipts[-1],"NOT_APPLICABLE","CATALOG_DISCOVERY_ONLY",observation_opportunity=isinstance(o,dict),source_latest=dt,record_count=len(fs))
        cur=base=None; dist=None
        if latest and pri=="P1":
            cur=pix(preview(latest),receipts,f"current {fam} {tile_id}")
            if prior: base=pix(preview(prior),receipts,f"baseline {fam} {tile_id}")
            dist=hdist(cur,base)
        ls[fam]={"catalog_ok":isinstance(o,dict),"items":len(fs),"latest_utc":isoz(dt),"fresh_24h":bool(age is not None and -1<=age<=24),"fresh_72h":bool(age is not None and -1<=age<=72),"cloud_pct":round(cc,2) if cc is not None else None,"preview_current":bool(cur),"preview_baseline":bool(base),"change_score":round(dist,4) if dist is not None else None,"candidate_anomaly":bool(dist is not None and dist>=.40 and (fam!="optical" or cc is None or cc<=55))}
    usable=[f for f,x in ls.items() if x["fresh_72h"] and (pri!="P1" or x["preview_current"])]; return {"tile_id":tile_id,"region":tag,"priority":pri,"layers":ls,"fresh_24h_family_count":sum(1 for x in ls.values() if x["fresh_24h"]),"usable_family_count":len(usable),"candidate_anomaly_families":[f for f,x in ls.items() if x["candidate_anomaly"]]}


def geoint(receipts,t0):
    ts=[tile_collect(*t,receipts,t0) for t in tiles()]; p1=[x for x in ts if x["priority"]=="P1"]; recent=sum(x["fresh_24h_family_count"]>=1 for x in p1); usable=sum(x["usable_family_count"]>=2 for x in p1); an=sum(bool(x["candidate_anomaly_families"]) for x in p1)
    return {"gate":"PASS" if len(ts)==16 and recent>=10 and usable>=8 else "INCOMPLETE","tiles_expected":16,"tiles_attempted":len(ts),"p1_expected":12,"p1_recent_24h":recent,"p1_two_usable_families":usable,"p1_candidate_anomaly_tiles":an,"tiles":ts}


def documentary(receipts,t0):
    s,b=fetch("https://t.me/s/favt_info",receipts,"aeronautical_documentary","Rosaviatsia public service context")
    txt=b.decode("utf-8",errors="replace") if b else ""; times=[pdt(x) for x in re.findall(r'<time[^>]+datetime="([^"]+)"',txt)]; times=[x for x in times if x]
    if receipts:
        if s==200 and txt:
            finalize_non_json_receipt(receipts[-1],parser_status="HTML_PARSED",record_count=len(times),source_latest=max(times) if times else None,schema_id="TELEGRAM_PUBLIC_HTML_TIME_TAGS")
            set_receipt_result(receipts[-1],"UNKNOWN","DOCUMENTARY_CONTEXT_REQUIRES_CONFOUNDER_REVIEW",observation_opportunity=False,source_latest=max(times) if times else None,record_count=len(times))
        else:
            finalize_parse_failure(receipts[-1],"HTML_PARSE_FAILED","EMPTY_OR_HTTP_FAILURE")
    recent=any(t0-x<=timedelta(hours=6) for x in times) if times else False
    return {"coverage":"COVERED" if s==200 and bool(txt) else "UNKNOWN","recent_page_timestamp":recent,"restriction_markers":txt.casefold().count("введены временные ограничения"),"confounder":"DEFENSIVE_REACTION_POSSIBLE"}


def main():
    global ACTIVE_RUN_ID
    t0=now(); ACTIVE_RUN_ID=run_id_from_environment(t0); receipts=[]; regions={}; af=rf=rel=both=0
    for tag,(name,_,_) in AOIS.items():
        code=resolve_region(tag,name,receipts); asns=region_asns(tag,code,receipts); a=collect_ioda(tag,code,receipts,t0); r=collect_ripe(tag,asns,receipts,t0)
        if code and asns: rel+=1
        if a.get("fresh"): af+=1
        if r.get("fresh"): rf+=1
        mat=bool(a.get("trend",{}).get("material_drop") and r.get("material_churn")); both+=int(mat)
        regions[tag]={"relationship_pivot":bool(code and asns),"ioda_active":a,"ripe_ris":r,"two_class_material":mat}
    cy={"gate":"PASS" if af>=3 and rf>=3 and rel>=3 else "INCOMPLETE","ioda_active_regions_fresh":af,"ripe_regions_fresh":rf,"relationship_regions_resolved":rel,"regions_with_two_class_material":both,"regions":regions}
    geo=geoint(receipts,t0); doc=documentary(receipts,t0)
    pre={"evaluation_gate":"PASS","coverage_gate":"INCOMPLETE","families":{
        "aeronautical_airspace_service":{"status":"OBSERVED_CONTEXT" if doc["coverage"]=="COVERED" else "UNKNOWN","coverage":doc["coverage"]},
        "maintenance_support_service_dependency":{"status":"UNKNOWN","coverage":"GAP"},
        "logistics_fuel_transport_aggregate":{"status":"UNKNOWN","coverage":"GAP"},
        "broad_physical_geospatial":{"status":"OBSERVED" if geo["gate"]=="PASS" else "UNKNOWN","coverage":geo["gate"]},
        "digital_telemetry_dependency":{"status":"OBSERVED" if cy["gate"]=="PASS" else "UNKNOWN","coverage":cy["gate"]},
    },"offensive_preparation_convergence":False}
    out={"schema_version":1,"receipt_schema_version":RECEIPT_SCHEMA_VERSION,"run_id":ACTIVE_RUN_ID,"quality_floor":"QUALITY_FLOOR_V3","generated_utc":isoz(t0),"collection_anchor_utc":isoz(t0),"safety_scope":"DEFENSIVE_CIVILIAN_AGGREGATE_ONLY","cybint":cy,"geoint":geo,"documentary":doc,"preconfiguration":pre,"gate_summary":{"passive_cybint":cy["gate"],"geoint_16_tile":geo["gate"],"preconfig_evaluation":pre["evaluation_gate"],"preconfig_coverage":pre["coverage_gate"]},"receipt_count":len(receipts),"receipt_digest":hobj(receipts),"high_prealert_authority":False}
    root=Path("runtime/kyiv-v3/out"); root.mkdir(parents=True,exist_ok=True); (root/"latest.json").write_text(json.dumps(out,ensure_ascii=False,indent=2)+"\n"); (root/"receipts.jsonl").write_text("".join(json.dumps(x,ensure_ascii=False)+"\n" for x in receipts)); print(json.dumps({"gate_summary":out["gate_summary"],"receipt_count":len(receipts)},ensure_ascii=False)); return 0

if __name__=="__main__": raise SystemExit(main())
