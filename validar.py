"""Comparación exploratoria de las tres corridas LETKF a escalas y umbrales fijos."""
from collections import defaultdict
from pathlib import Path
import csv
import json
import sys


def active(fields, block, threshold):
    energy = defaultdict(float)
    for day, x, y, mwh, _ in fields:
        energy[day, x//block, y//block] += mwh
    return {key for key,value in energy.items() if value>=threshold}


def main():
    data = json.loads(Path('web/datos.json').read_text())
    writer = csv.writer(sys.stdout)
    writer.writerow(['lado_km','umbral_mwh','fecha','modis','viirs','ambos',
                     'interseccion_modis_viirs','union_modis_viirs','jaccard_modis_viirs'])
    for block in (1,4,8,16):
        for threshold in (0.5, 1, 5, 10):
            sets = {k:active(rows,block,threshold) for k,rows in data['products'].items()}
            for i, day in enumerate(data['dates']):
                m,v,a = ({k for k in sets[mode] if k[0]==i} for mode in ('modis','viirs','ambos'))
                inter, union = len(m&v), len(m|v)
                writer.writerow([block*data['grid'][4],threshold,day,
                                 len(m),len(v),len(a),inter,union,round(inter/union,4) if union else ''])


if __name__=='__main__':
    main()
