import re
from pathlib import Path

base=Path('scripts/ai39_landsat_thermal_pixel_probe.py').read_text(encoding='utf-8')
base,n=re.subn(r"PLATFORM='landsat-9'; WRS_PATH='176'; DAYS=\['2024-08-09','2024-08-25'\]",
               "PLATFORM='landsat-9'; WRS_PATH='176'; DAYS=['2023-08-07','2023-08-23']",base)
if n!=1: raise RuntimeError(f'platform/date patch failed: {n}')
exec(compile(base,'ai39_landsat_thermal_pixel_probe_2023_l9_match','exec'),{'__name__':'__main__','__file__':__file__})
