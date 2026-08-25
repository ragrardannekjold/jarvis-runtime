import re
from pathlib import Path

base=Path('scripts/ai39_landsat_thermal_pixel_probe.py').read_text(encoding='utf-8')
base,n1=re.subn(r"PLATFORM='landsat-9'; WRS_PATH='176'; DAYS=\['2024-08-09','2024-08-25'\]",
                "PLATFORM='landsat-8'; WRS_PATH='176'; DAYS=['2023-07-30','2023-08-15']",base)
base,n2=re.subn(r"'pair':\{'platform':PLATFORM,'wrs_path':WRS_PATH,'day_a':DAYS\[0\],'day_b':DAYS\[1\],'separation_days':16\}",
                "'pair':{'platform':PLATFORM,'wrs_path':WRS_PATH,'day_a':DAYS[0],'day_b':DAYS[1],'separation_days':16}",base)
if n1!=1: raise RuntimeError(f'platform/date patch failed: {n1}')
exec(compile(base,'ai39_landsat_thermal_pixel_probe_2023_match','exec'),{'__name__':'__main__','__file__':__file__})
