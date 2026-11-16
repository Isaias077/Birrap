"""Extrae las celdas históricas de San Juan de los productos previos V10 y V12."""
import argparse
import csv
import io
import json
from pathlib import Path
from zipfile import ZipFile

from preparar import department, departments


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('atlas_v12', type=Path)
    ap.add_argument('entrada_v10', type=Path)
    ap.add_argument('--output', type=Path, default=Path('dist/historico.json'))
    args = ap.parse_args()
    regions = departments(Path(__file__).parent / 'web/san-juan.json')
    with ZipFile(args.atlas_v12) as archive:
        code = archive.read('codigo_fuente/data.js').decode('utf-8-sig')
    atlas = json.loads(code.split('=', 1)[1].strip().rstrip(';'))
    cells, v12_index = {}, {}
    for i, cell in enumerate(atlas['cells']):
        lon = sum(p[0] for p in cell['p']) / len(cell['p'])
        lat = sum(p[1] for p in cell['p']) / len(cell['p'])
        if dep := department(regions,lon,lat):
            ident = cell['id'].removeprefix('50km_')
            cells[ident] = [dep, cell['p'], cell['c']]
            v12_index[i] = ident
    months = {
        month:{v12_index[r[0]]:r[1:] for r in rows if r[0] in v12_index}
        for month,rows in zip(atlas['months'],atlas['rows'])
    }
    sources = ['Terra','Aqua','SNPP','N20','N21']
    daily = {}
    with ZipFile(args.entrada_v10) as archive, archive.open('09_CALENDARIO_DIARIO_CELDAS_50KM.csv') as source:
        for r in csv.DictReader(io.TextIOWrapper(source, encoding='utf-8-sig', newline='')):
            ident = r['gx']+'_'+r['gy']
            if ident in cells and r['sensor'] in sources:
                record = daily.setdefault(r['day'],{}).setdefault(ident,[0]*len(sources))
                record[sources.index(r['sensor'])] += int(r['n'])
    result = dict(cells=cells,sources=sources,daily=daily,months=months,
                  source_by_month=dict(zip(atlas['months'],atlas['src'])))
    args.output.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
    print(f'{len(cells)} celdas, {len(daily)} fechas con detecciones, {len(months)} meses V12')


if __name__=='__main__':
    main()
