import re
from pathlib import Path

base=Path('scripts/ai39_landsat_thermal_baseline.py').read_text(encoding='utf-8')
replacement="WINDOWS={'2023':('2023-05-01','2023-10-01'),'2024':('2024-05-01','2024-10-01'),'2025':('2025-05-01','2025-10-01'),'2026':('2026-05-01','2026-08-01')}"
patched,n=re.subn(r"WINDOWS=\{.*?\}\nMAX_PAIR_SCENE_CLOUD",replacement+'\nMAX_PAIR_SCENE_CLOUD',base,flags=re.S)
if n!=1:
    raise RuntimeError(f'failed to patch historical windows: {n}')
exec(compile(patched,'ai39_landsat_thermal_baseline_v2','exec'),{'__name__':'__main__','__file__':__file__})
