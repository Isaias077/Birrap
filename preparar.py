"""Precalcula productos diarios de LETKF para un intervalo explícito de San Juan."""
import argparse
import csv
from datetime import date, timedelta
import json
from pathlib import Path

import numpy as np
from matplotlib.path import Path as PolygonPath
from frp_enkf import firms
from frp_enkf.assim import FireFilter, FilterConfig
from frp_enkf.model import FireParams, step

CELL = 0.375
WEST, SOUTH = -71.0, -33.0
KX, KY = 95.8, 110.57
TILE, PAD = 64, 16
SUPPORT_RADIUS_KM, SUPPORT_HOURS = 6, 12
MODES = ('ambos', 'modis', 'viirs')

class GridDomain(firms.Domain):
    @property
    def _km_per_deg(self):
        return KX, KY

def departments(path):
    features = json.loads(path.read_text())['features']
    return [(f['properties']['nombre'], [
        [PolygonPath(ring) for ring in polygon]
        for polygon in (f['geometry']['coordinates'] if f['geometry']['type']=='MultiPolygon'
                        else [f['geometry']['coordinates']])
    ]) for f in features]

def department(regions,lon,lat):
    point=(lon,lat)
    return next((name for name,polygons in regions if any(
        rings[0].contains_point(point) and not any(hole.contains_point(point) for hole in rings[1:])
        for rings in polygons)),None)

def load(folder, start, end, regions):
    rows = []
    inputs = {}
    for path in sorted(folder.glob('*.csv')):
        with path.open(encoding='utf-8-sig', newline='') as file:
            reader = csv.DictReader(file)
            required = {'latitude','longitude','acq_date','acq_time','satellite','frp','scan','track'}
            if not required.issubset(reader.fieldnames or ()):
                raise ValueError(f'{path.name}: el CSV debe incluir latitud, longitud, fecha, hora, satélite, FRP, scan y track de FIRMS.')
            for r in reader:
                lat, lon = float(r['latitude']), float(r['longitude'])
                if not (-33 < lat < -27 and -71 < lon < -65):
                    continue
                t = np.datetime64(r['acq_date']+'T'+r['acq_time'].zfill(4)[:2]+':'+r['acq_time'].zfill(4)[2:])
                local = str((t-np.timedelta64(3,'h')).astype('datetime64[D]'))
                if not start <= local <= end:
                    continue
                dep = department(regions,lon,lat)
                sat = r['satellite'].strip().upper()
                sat = {'SNPP':'N','SUOMI-NPP':'N','NOAA-20':'N20','NOAA-21':'N21'}.get(sat,sat)
                if not dep or sat not in firms.PLATFORMS:
                    continue
                platform = firms.PLATFORMS[sat][0]
                family = 'MODIS' if platform in ('Aqua','Terra') else 'VIIRS'
                frp = float(r['frp']) if r.get('frp') else None
                rows.append([str(t),local,lat,lon,platform,family,frp,float(r['scan']),float(r['track']),r.get('confidence',''),dep,r.get('type',''),r.get('daynight',''),r.get('version','')])
                inputs.setdefault(path.name,set()).add(local)
    unique = {}
    for r in rows:
        key = (r[0],r[2],r[3],r[4])
        # Prioriza el producto estándar si también llegó en tiempo casi real.
        if key not in unique or ('NRT' in unique[key][13] and 'NRT' not in r[13]):
            unique[key] = r
    return sorted(unique.values()), {p:sorted(days) for p,days in inputs.items()}

def assimilation_inputs(rows):
    for family,sensor in [('MODIS',firms.MODIS),('VIIRS',firms.VIIRS)]:
        items = [r for r in rows if r[5]==family and r[6] is not None and r[6]>0
                 and r[11] in ('','0') and r[9].lower() not in ('l','low')
                 and not (r[9].isdigit() and int(r[9])<30)]
        if items:
            yield firms.Detections(sensor,*(np.array(a,dtype=t) for a,t in [
                ([r[2] for r in items],float),([r[3] for r in items],float),
                ([r[6] for r in items],float),([r[7] for r in items],float),
                ([r[8] for r in items],float),([r[0] for r in items],'datetime64[m]'),
                ([r[4] for r in items],object),([r[12]!='N' for r in items],bool)]))

def run_tile(inputs, origin, dates, mode, members):
    x,y = origin
    west,south = WEST+(x-PAD)*CELL/KX, SOUTH+(y-PAD)*CELL/KY
    dom = GridDomain(west,south,west+(TILE+2*PAD-0.01)*CELL/KX,
                     south+(TILE+2*PAD-0.01)*CELL/KY,np.datetime64(dates[0]))
    sub = [d.subset((d.lon>=dom.west)&(d.lon<dom.east)&(d.lat>=dom.south)&(d.lat<dom.north))
           for d in inputs if mode=='ambos' or d.sensor.family.lower()==mode]
    passes = firms.passes_from_detections(sub,dom,False)
    if not passes:
        return None
    utc0 = np.datetime64(dates[0]+'T03:00')
    by_step = {}
    for o in passes:
        minutes = int((dom.utc(o.time_h)-utc0)/np.timedelta64(1,'m'))
        if minutes < 0:
            continue
        by_step.setdefault(minutes//10,[]).append(o)
    rng = np.random.default_rng(16)
    fuel = np.clip(rng.normal(.75,.075,(members,*dom.shape)),.25,1.)
    model = FireParams().perturbed(members,rng,rel=.25,wind_sd=.2)
    flt = FireFilter(fuel,model,rng,FilterConfig(estimate_bias=False,estimate_wind=False))
    result = np.zeros((len(dates),TILE,TILE),dtype=np.float32)
    solar0 = float(dom.hours(utc0))
    expiry = np.full(dom.shape,-1,dtype=int)
    yy,xx = np.indices(dom.shape)
    center_x,center_y = (xx+.5)*CELL,(yy+.5)*CELL
    # Integra FRP en intervalos de diez minutos usando el estado tras la asimilación.
    for k in range(len(dates)*144):
        if k:
            flt.x,flt.f = step(flt.x,flt.f,model,1/6,solar0+(k-1)/6,rng)
        for o in by_step.get(k,()):
            flt.assimilate(o)
            for cx,cy in o.centers_km[o.detected]:
                nearby = (center_x-cx)**2+(center_y-cy)**2 <= SUPPORT_RADIUS_KM**2
                expiry[nearby] = k+SUPPORT_HOURS*6-1
        core = np.s_[PAD:PAD+TILE,PAD:PAD+TILE]
        if np.any(expiry[core]>=k):
            result[k//144] += flt.x[:,core[0],core[1]].mean(axis=0)*(expiry[core]>=k)/6
    return result

def compute(folder, first, last, members, boundaries):
    dates=[str(first+timedelta(days=i)) for i in range((last-first).days+1)]
    regions=departments(boundaries)
    rows,sources=load(folder,dates[0],dates[-1],regions)
    if not rows:
        raise ValueError('Los CSV no aportan detecciones de San Juan para el intervalo elegido.')
    inputs=list(assimilation_inputs(rows))
    if not inputs:
        raise ValueError('Hay registros en San Juan, pero ninguno tiene FRP, confianza y tipo compatibles con el LETKF.')
    tiles=set()
    for d in inputs:
        for lon,lat in zip(d.lon,d.lat):
            x,y=(lon-WEST)*KX/CELL,(lat-SOUTH)*KY/CELL
            for tx in {int(v//TILE)*TILE for v in (x-PAD,x+PAD)}:
                for ty in {int(v//TILE)*TILE for v in (y-PAD,y+PAD)}:
                    tiles.add((tx,ty))
    output={m:[] for m in MODES}
    lookup={}
    for x,y in sorted(tiles):
        for mode in MODES:
            product=run_tile(inputs,(x,y),dates,mode,members)
            if product is None: continue
            for day,dy,dx in np.argwhere(product>=0.01):
                gx,gy=x+int(dx),y+int(dy)
                if (gx,gy) not in lookup:
                    lookup[gx,gy]=department(regions,WEST+(gx+.5)*CELL/KX,SOUTH+(gy+.5)*CELL/KY)
                dep=lookup[gx,gy]
                if dep:
                    output[mode].append([int(day),gx,gy,round(float(product[day,dy,dx]),3),dep])
        print(f'Tesela {x},{y}',flush=True)
    data=dict(dates=dates,rows=rows,products=output,sources=sources,
              grid=[WEST,SOUTH,KX,KY,CELL],members=members,
              support=[SUPPORT_RADIUS_KM,SUPPORT_HOURS])
    return data

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('csv',type=Path)
    ap.add_argument('--start',required=True,type=date.fromisoformat)
    ap.add_argument('--end',required=True,type=date.fromisoformat)
    ap.add_argument('--members',default=16,type=int)
    ap.add_argument('--output',type=Path,default=Path('web/datos.json'))
    args=ap.parse_args()
    if args.end<args.start or args.members<4:
        ap.error('Se requiere un intervalo válido y al menos cuatro miembros.')
    try:
        data = compute(args.csv, args.start, args.end, args.members,
                       Path(__file__).parent/'web/san-juan.json')
    except ValueError as exc:
        ap.error(str(exc))
    args.output.write_text(json.dumps(data,separators=(',',':'),ensure_ascii=False))
    print(f"{len(data['rows'])} detecciones · "+
          str({key:len(rows) for key,rows in data['products'].items()}))


if __name__=='__main__':
    main()
