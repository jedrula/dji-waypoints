#!/usr/bin/env python3
"""Turn Poland's free LiDAR into a height model for one site.

NOT part of the app, and deliberately not a dependency of it: this needs
laspy and a LAZ decoder, where the app itself has no dependencies at all.
It exists because the numbers the importer assumes had to come from
somewhere, and because it is the shape the real feature would take.

    python3 -m venv venv && ./venv/bin/pip install "laspy[lazrs]" numpy
    ./venv/bin/python tools/lidar-spike.py 51.1166299 17.0308393

What it does, and what it found:

  * The tile index is a WFS with one layer per survey year, 2018-2026 in
    PL-EVRF2007 and 2010-2019 in PL-KRON86. Its BBOX wants NORTH,EAST with
    an EPSG:2180 URN, and so do the GML envelopes it returns. Get that
    backwards -- easy at Wroclaw, where easting and northing are both about
    362000 and a swap is invisible -- and it hands back neighbouring tiles
    that look plausible and do not contain your point.
  * A tile is about 21 MB at 12 p/m2 and 103 MB at 20 p/m2, classified into
    ground, building, and low/medium/high vegetation. Enough to read the
    height of every roof and tree crown to a tenth of a metre.
  * Reducing one to a 1 m height raster over a 200 m site gives 39 kB, or
    11 kB gzipped. That is the thing a browser should fetch: the same
    answer, roughly nineteen hundred times smaller.
  * Newer surveys are published in PL-2000 zones rather than PUWG92, and a
    PL-2000 easting starts with the zone number (6432800, not 362800). Read
    one as PUWG92 and it looks like the tile is empty. This script sticks to
    PL-1992 tiles for that reason; a real version would convert.
  * Wires are NOT classified in the tiles sampled -- no class 13/14/15/16 --
    so power lines still have to come from OpenStreetMap geometry, and
    their heights are still assumed.
"""
import sys, math, urllib.request, urllib.parse, re, gzip

WFS = ('https://mapy.geoportal.gov.pl/wss/service/PZGIK/'
       'DanePomiaroweLidarEVRF2007/WFS/Skorowidze')


def to_puwg92(lat, lon):
    """EPSG:2180. Returns (east, north) -- the service wants them the other
    way round, which is the Polish convention and the opposite of the guess."""
    a, f = 6378137.0, 1 / 298.257222101
    e2 = f * (2 - f)
    k0, lon0 = 0.9993, math.radians(19)
    p, l = math.radians(lat), math.radians(lon)
    ep2 = e2 / (1 - e2)
    N = a / math.sqrt(1 - e2 * math.sin(p) ** 2)
    T, C = math.tan(p) ** 2, ep2 * math.cos(p) ** 2
    A = (l - lon0) * math.cos(p)
    M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
             - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * p)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * p)
             - (35 * e2 ** 3 / 3072) * math.sin(6 * p))
    east = 500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6
                              + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120)
    north = -5300000 + k0 * (M + N * math.tan(p) * (A * A / 2
             + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
             + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720))
    return east, north


def find_tile(east, north, pad=1200):
    """The newest tile whose envelope really contains the point."""
    for year in range(2026, 2017, -1):
        bbox = f'{north-pad},{east-pad},{north+pad},{east+pad},urn:ogc:def:crs:EPSG::2180'
        url = (f'{WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
               f'&TYPENAMES=gugik:SkorowidzDanychPomiarowychLIDAR{year}'
               f'&COUNT=60&BBOX={urllib.parse.quote(bbox, safe=",:")}')
        try:
            xml = urllib.request.urlopen(url, timeout=40).read().decode('utf-8', 'replace')
        except Exception:
            continue
        for member in xml.split('<wfs:member>')[1:]:
            lc = re.search(r'<gml:lowerCorner>([^<]+)<', member)
            uc = re.search(r'<gml:upperCorner>([^<]+)<', member)
            link = re.search(r'<gugik:url_do_pobrania>([^<]+)<', member)
            dens = re.search(r'<gugik:char_przestrz>([^<]+)<', member)
            crs = re.search(r'<gugik:uklad_xy>([^<]+)<', member)
            if not (lc and uc and link):
                continue
            # The index is in PUWG92 whatever the tile is, but the LAZ itself
            # carries whichever system the survey was flown in -- and the newer
            # ones are PL-2000 zones, whose eastings start with the zone number
            # (6432800 rather than 362800). Reading one as PUWG92 finds no
            # points anywhere near the site and looks like empty coverage.
            if crs and 'PL-1992' not in crs.group(1):
                continue
            n0, e0 = map(float, lc.group(1).split())
            n1, e1 = map(float, uc.group(1).split())
            if n0 <= north <= n1 and e0 <= east <= e1:
                return {'year': year, 'url': link.group(1),
                        'density': dens.group(1) if dens else '?',
                        'crs': crs.group(1) if crs else '?'}
    return None


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    lat, lon = float(sys.argv[1]), float(sys.argv[2])
    radius = float(sys.argv[3]) if len(sys.argv) > 3 else 100.0
    east, north = to_puwg92(lat, lon)
    print(f'{lat}, {lon}  ->  PUWG92 east {east:.0f} north {north:.0f}')

    tile = find_tile(east, north)
    if not tile:
        print('no LiDAR tile covers that point (Poland only)')
        return 1
    print(f'tile: {tile["year"]}, {tile["density"]}, {tile["crs"]}\n  {tile["url"]}')

    import laspy, numpy as np
    path = '/tmp/lidar-spike.laz'
    urllib.request.urlretrieve(tile['url'], path)
    f = laspy.read(path)
    x, y, z, c = (np.asarray(f.x), np.asarray(f.y), np.asarray(f.z),
                  np.asarray(f.classification))
    m = (np.abs(x - east) <= radius) & (np.abs(y - north) <= radius) & (c != 7)
    x, y, z, c = x[m], y[m], z[m], c[m]
    if not len(x):
        print('the tile does not reach that point')
        return 1

    W = int(2 * radius)
    ix = ((x - (east - radius))).astype(int).clip(0, W - 1)
    iy = ((y - (north - radius))).astype(int).clip(0, W - 1)
    cell = iy * W + ix
    dtm = np.full(W * W, np.nan)
    dsm = np.full(W * W, np.nan)
    np.minimum.at(dtm, cell[c == 2], z[c == 2])
    dsm[:] = -np.inf
    np.maximum.at(dsm, cell, z)
    dsm[np.isinf(dsm)] = np.nan
    # Cells with no ground return borrow the lowest ground in the site rather
    # than becoming NaN, or every height measured against them is missing.
    floor = z.min() if np.isnan(dtm).all() else np.nanmin(dtm)
    ground = np.where(np.isnan(dtm), floor, dtm)
    ndsm = np.nan_to_num(dsm - ground, nan=0.0).clip(0, 120)

    for label, klass, assumed in [('buildings', [6], 24), ('trees', [4, 5], 20)]:
        sel = np.isin(c, klass)
        if sel.sum() < 50:
            continue
        hh = (z[sel] - ground[cell[sel]])
        hh = hh[np.isfinite(hh) & (hh > 1)]
        print(f'  {label:<10} p50 {np.percentile(hh,50):5.1f}  p90 {np.percentile(hh,90):5.1f}'
              f'  max {hh.max():5.1f}   (the app assumes {assumed} m)')

    q = (ndsm * 2).astype(np.uint8).tobytes()   # half-metre steps
    print(f'  1 m height raster: {len(q)/1024:.1f} kB raw, '
          f'{len(gzip.compress(q))/1024:.1f} kB gzipped '
          f'(the LAZ tile it came from is tens of MB)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
