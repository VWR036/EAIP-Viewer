"""Prepare audited, approximate boundary connections from downloaded source vectors.

Uses only Python's standard library. Source data and attribution are documented in
docs/airac-map/boundary-sources/README.md. This does not modify the AIRAC snapshot.
"""
import argparse
import collections
import datetime as dt
import hashlib
import heapq
import itertools
import json
import math
from pathlib import Path

A = 'http://www.aixm.aero/schema/5.1.1'
G = 'http://www.opengis.net/gml/3.2'
MAX_OFFSET_M = 10000
SOURCE_INFO = {
    'National Boundaries': {
        'name': 'Natural Earth 1:10m 国界参考线',
        'url': 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-boundary-lines/',
        'downloadUrl': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_boundary_lines_land.geojson',
        'license': 'Public domain',
        'licenseUrl': 'https://www.naturalearthdata.com/about/terms-of-use/',
        'filename': 'ne_10m_admin_0_boundary_lines_land.geojson',
    },
    'Hong Kong Boundaries': {
        'name': '香港政府民政事务总署行政区边界（提取外边界）',
        'url': 'https://data.gov.hk/en-data/dataset/hk-had-json1-hong-kong-administrative-boundaries',
        'downloadUrl': 'https://www.had.gov.hk/psi/hong-kong-administrative-boundaries/hksar_18_district_boundary.json',
        'license': '© HKSAR Government, Home Affairs Department; DATA.GOV.HK Terms of Use',
        'licenseUrl': 'https://data.gov.hk/en/terms-and-conditions',
        'filename': 'hksar_18_district_boundary.json',
    },
}


def children(node, name, namespace=A):
    return [n for n in node['children'] if n['name'] == name and n['namespace'] == namespace]


def one(node, name, namespace=A):
    nodes = children(node, name, namespace)
    if len(nodes) != 1:
        raise ValueError(f'Expected one {name}, got {len(nodes)}')
    return nodes[0]


def walk(node):
    yield node
    for child in node['children']:
        yield from walk(child)


def distance(p, q):
    lat1, lat2 = math.radians(p[1]), math.radians(q[1])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(math.radians(q[0] - p[0]) / 2) ** 2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(h)))


def national_edges(data):
    for feature in data['features']:
        p = feature['properties']
        sides = [p.get('ADM0_A3_L'), p.get('ADM0_A3_R')]
        if 'CHN' not in sides or any(code in sides for code in ['HKG', 'MAC']):
            continue
        # Use the source's China-view classification; do not mix alternative lines.
        if (p.get('FCLASS_CN') or p['FEATURECLA']) == 'Unrecognized':
            continue
        geometry = feature['geometry']
        if geometry['type'] not in ['LineString', 'MultiLineString']:
            raise ValueError('Unexpected national boundary geometry')
        lines = geometry['coordinates'] if geometry['type'] == 'MultiLineString' else [geometry['coordinates']]
        for line in lines:
            yield from zip(line, line[1:])


def hong_kong_edges(data):
    edges = collections.Counter()
    for feature in data['features']:
        geometry = feature['geometry']
        if geometry['type'] not in ['Polygon', 'MultiPolygon']:
            raise ValueError('Unexpected Hong Kong district geometry')
        polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
        for polygon in polygons:
            for ring in polygon:
                for p, q in zip(ring, ring[1:]):
                    edges[tuple(sorted((tuple(p), tuple(q))))] += 1
    if any(count > 2 for count in edges.values()):
        raise ValueError('Hong Kong district edges overlap more than twice')
    # Shared district edges occur twice. They must never be used as the SAR boundary.
    return [edge for edge, count in edges.items() if count == 1]


class BoundaryGraph:
    def __init__(self, edges):
        self.graph = collections.defaultdict(dict)
        self.edges = []
        for p, q in edges:
            p, q = tuple(p), tuple(q)
            if not all(math.isfinite(v) for point in [p, q] for v in point) or any(abs(point[0]) > 180 or abs(point[1]) > 90 for point in [p, q]):
                raise ValueError('Invalid boundary source coordinate')
            if p == q:
                continue
            self.graph[p][q] = self.graph[q][p] = distance(p, q)
            self.edges.append((p, q))

    def nearest(self, point):
        scale = math.cos(math.radians(point[1]))
        candidates = []
        for p, q in self.edges:
            dx, dy = (q[0] - p[0]) * scale, q[1] - p[1]
            t = max(0, min(1, ((point[0] - p[0]) * scale * dx + (point[1] - p[1]) * dy) / (dx * dx + dy * dy)))
            projected = (p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]))
            candidates.append((distance(point, projected), p, q, projected))
        return min(candidates)

    def route(self, start, end):
        first, last = self.nearest(start), self.nearest(end)
        offsets = [first[0], last[0]]
        if max(offsets) > MAX_OFFSET_M:
            raise ValueError(f'端点距参考边界过远：{offsets[0]:.0f} / {offsets[1]:.0f} M（上限 {MAX_OFFSET_M} M）')
        source, target = 'start', 'end'
        extras = collections.defaultdict(dict)
        for key, (_, p, q, projected) in [(source, first), (target, last)]:
            for vertex in [p, q]:
                extras[key][vertex] = extras[vertex][key] = distance(projected, vertex)
        if set(first[1:3]) == set(last[1:3]):
            extras[source][target] = extras[target][source] = distance(first[3], last[3])
        serial = itertools.count()
        queue = [(0, next(serial), source)]
        costs, previous = {source: 0}, {}
        while queue:
            cost, _, node = heapq.heappop(queue)
            if cost != costs[node]:
                continue
            if node == target:
                break
            for neighbor, weight in {**self.graph.get(node, {}), **extras.get(node, {})}.items():
                value = cost + weight
                if value < costs.get(neighbor, math.inf):
                    costs[neighbor], previous[neighbor] = value, node
                    heapq.heappush(queue, (value, next(serial), neighbor))
        if target not in costs:
            raise ValueError('参考边界路径不连通，未跨缺口补线')
        path, node = [], target
        while node != source:
            path.append(last[3] if node == target else node)
            node = previous[node]
        path.append(first[3])
        coordinates = [tuple(start), *reversed(path), tuple(end)]
        coordinates = [p for i, p in enumerate(coordinates) if not i or p != coordinates[i - 1]]
        return coordinates, offsets, costs[target]


def border_requests(objects):
    for obj in objects.values():
        if obj['type'] != 'Airspace' or not obj['active']:
            continue
        for ring in (n for n in walk(obj['properties']) if n['namespace'] == G and n['name'] == 'Ring'):
            curves = [one(n, 'Curve') for n in children(ring, 'curveMember', G)]
            for i, curve in enumerate(curves):
                notes = [one(a, 'Note') for a in children(curve, 'annotation')]
                notes = [n for n in notes if any(p['text'] == 'boundary' for p in children(n, 'propertyName'))]
                if not notes:
                    continue
                texts = [n['text'] for note in notes for n in walk(note) if n['namespace'] == A and n['name'] == 'note' and n['attributes'].get('lang') == 'eng']
                if len(texts) != 1 or texts[0] not in SOURCE_INFO:
                    raise ValueError(f'Unsupported boundary note: {texts}')
                segments = one(curve, 'segments', G)['children']
                next_segment = one(curves[(i + 1) % len(curves)], 'segments', G)['children'][0]
                if segments[-1]['name'] != 'GeodesicString' or next_segment['name'] != 'GeodesicString':
                    raise ValueError('Boundary note endpoints must be explicit GeodesicString points')
                tail = one(segments[-1], 'posList', G)['text'].split()[-2:]
                head = one(next_segment, 'posList', G)['text'].split()[:2]
                yield obj, curve, texts[0], [float(tail[1]), float(tail[0])], [float(head[1]), float(head[0])]


def build(index, source_dir):
    manifest = json.loads((index / 'manifest.json').read_text(encoding='utf-8'))
    objects = json.loads((index / manifest['objectsFile']).read_text(encoding='utf-8'))
    sources, graphs = {}, {}
    for kind, info in SOURCE_INFO.items():
        raw = (source_dir / info['filename']).read_bytes()
        data = json.loads(raw)
        sources[kind] = {**info, 'sha256': hashlib.sha256(raw).hexdigest()}
        graphs[kind] = BoundaryGraph(national_edges(data) if kind == 'National Boundaries' else hong_kong_edges(data))
    connections, unmatched = {}, []
    for obj, curve, kind, start, end in border_requests(objects):
        record = {'objectId': obj['id'], 'code': obj['fields'].get('designator') or obj['name'], 'curveId': curve['attributes']['{' + G + '}id'], 'kind': kind, 'start': start, 'end': end}
        try:
            coordinates, offsets, length = graphs[kind].route(start, end)
            connections[record['curveId']] = {**record, 'coordinates': coordinates, 'endpointOffsetsM': offsets, 'boundaryLengthM': length}
        except ValueError as error:
            unmatched.append({**record, 'reason': str(error)})
    return {'formatVersion': 1, 'datasetGeneration': manifest['generation'], 'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'maxEndpointOffsetM': MAX_OFFSET_M, 'sources': sources, 'connections': connections, 'unmatched': unmatched}


def main():
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, default=project / 'docs/airac-map/boundary-sources')
    args = parser.parse_args()
    data = build(project / 'public/data/airac-index', args.sources)
    target = project / 'public/data/airac-boundaries.json'
    target.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(json.dumps({'connections': len(data['connections']), 'unmatched': len(data['unmatched']), 'objects': len({r['objectId'] for r in data['connections'].values()}), 'bytes': target.stat().st_size}, ensure_ascii=False))
    for record in data['unmatched']:
        print(record['code'], record['kind'], record['reason'])


if __name__ == '__main__':
    main()
