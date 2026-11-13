"""EAIP offline directory assignments -> viewer JSON indexes (Python stdlib only)."""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit


BASE = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = BASE / 'public' / 'data' / 'eaip'


def read_assignment(path, variable, unquoted_keys=False):
    text = path.read_text(encoding='utf-8-sig')
    match = re.fullmatch(r'\s*var\s+' + re.escape(variable) + r'\s*=\s*(.*?)\s*;?\s*', text, re.S)
    if not match:
        raise ValueError(f'{path}: expected data assignment for {variable}')
    payload = match[1]
    if unquoted_keys:
        payload = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z_0-9]*)\s*:', r'\1"\2":', payload)
    return json.loads(payload)


def validate_pdf(source, path):
    if not path:
        return
    target = (source / path).resolve()
    if not target.is_relative_to(source.resolve()) or target.suffix.lower() != '.pdf':
        raise ValueError(f'Invalid PDF path: {path}')
    if not target.is_file():
        raise FileNotFoundError(target)


def directory(rows, source):
    by_id, children = {}, {}
    for row in rows:
        if row['id'] in by_id:
            raise ValueError(f'Duplicate directory ID: {row["id"]}')
        by_id[row['id']] = row
        validate_pdf(source, row['pdfPath'])
        children.setdefault(row['pId'], []).append(row)
    for row in rows:
        visited = {row['id']}
        parent = row['pId']
        while parent:
            if parent not in by_id:
                raise ValueError(f'Missing parent: {parent}')
            if parent in visited:
                raise ValueError(f'Directory cycle: {parent}')
            visited.add(parent)
            parent = by_id[parent]['pId']
    return children


def descendants(row, children):
    for child in children.get(row['id'], []):
        yield child
        yield from descendants(child, children)


def title(row):
    return row['name_cn'] or row['name']


def tags(row):
    return [tag for tag in (row['Node'] or []) if tag]


def chart_type(name):
    text = name.upper()
    if re.search(r'\bSID\b', text):
        return '标准仪表离场图'
    if re.search(r'\bSTAR\b', text):
        return '标准仪表进场图'
    if ('AERODROME GROUND MOVEMENT' in text or
            any(re.search(r'\b' + token + r'\b', text) for token in ('ADC', 'APDC', 'GMC', 'DGS'))):
        return '机场图_停机位置图'
    if 'WAYPOINT' in text or 'WAY POINT' in text:
        return '航路点表'
    if 'DATABASE CODING' in text:
        return '数据库编码表'
    if re.search(r'\b(AOC|PATC)\b', text):
        return '机场障碍物图_精密进近地形图'
    if re.search(r'\b(ATCSMAC|FDA)\b', text):
        return '最低监视引导高度图_放油区图'
    # Mixed RNAV/RNP ILS procedures appear once, in the ILS group.
    for token, group in [('ILS', '仪表进近图_ILS'), ('LOC', '仪表进近图_LOC'), ('VOR', '仪表进近图_VOR'),
                         ('NDB', '仪表进近图_NDB')]:
        if re.search(r'\b' + token + r'\b', text):
            return group
    if re.search(r'\b(RNP|RNAV|GPS|GNSS)\b', text):
        return '进近图_RNAV_RNP_RADAR_GPS_GNSS'
    if re.search(r'\bVAC\b', text):
        return '目视进近图'
    return '其他'


def airport_detail(source, airport):
    query = parse_qs(urlsplit(airport['htmlPath']).query)
    if 'jsId' not in query:
        return None  # Some published airports have PDFs only; no structured summary.
    path = source / Path(airport['pdfPath']).parent / (query['jsId'][0] + '.js')
    data = read_assignment(path, 'AD_AIP')
    return {
        'elev': data['AD_2_2']['fieldElevation'],
        'magvar': data['AD_2_2']['magneticVariation'],
        'rwys': [{'desig': row['designator'], 'dimensions': row['nominalLenWid']}
                 for row in data['AD_2_12']['runwayDirectionCharacter']['list']],
        'iata': data['AD_2_1']['designatorIata'],
    }


def build(source):
    trees = {}
    for key, variable in [('GEN', 'genTreeData'), ('ENR', 'enrTreeData'),
                          ('AD', 'adTreeData'), ('AMDT', 'amdtTreeData')]:
        rows = read_assignment(source / 'JsonPath' / f'{key}.js', variable)
        trees[key] = (rows, directory(rows, source))

    airports, charts_by_airport, details, missing_details = [], {}, {}, []
    rows, children = trees['AD']
    for airport in rows:
        icao = airport.get('airporticao')
        if not icao:
            continue
        if icao in charts_by_airport:
            raise ValueError(f'Duplicate ICAO: {icao}')
        detail = airport_detail(source, airport)
        if detail is None:
            missing_details.append(icao)
        else:
            details[icao] = detail
        airports.append({'icao': icao, 'name': title(airport).removeprefix(icao + '-'),
                         'nameEn': airport['name'].removeprefix(icao + '-'),
                         'iata': detail['iata'] if detail else ''})
        charts, seen = [], set()
        if airport['pdfPath']:
            charts.append({'id': airport['id'], 'n': '机场细则' if detail else '机场资料（整份 PDF）',
                           'p': '', 't': '机场细则', 's': False,
                           'm': airport['Is_Modified'] == 'Y', 'f': airport['pdfPath'], 'tags': tags(airport)})
            seen.add(airport['pdfPath'])
        for row in descendants(airport, children):
            path = row['pdfPath']
            if not path or path in seen:
                continue
            seen.add(path)
            match = re.fullmatch(re.escape(icao) + r'-([^:]+):(.+)', row['name'])
            name = match[2].strip() if match else title(row)
            charts.append({'id': row['id'], 'n': name, 'p': match[1] if match else '',
                           't': chart_type(name), 's': False,
                           'm': row['Is_Modified'] == 'Y', 'f': path, 'tags': tags(row)})
        charts_by_airport[icao] = charts

    def node(row, child_map, prefix):
        return {'id': prefix + '/' + row['id'], 't': title(row), 'en': row['name'],
                'p': row['pdfPath'], 'm': row['Is_Modified'] == 'Y', 'tags': tags(row),
                'c': [node(c, child_map, prefix) for c in child_map.get(row['id'], [])]}

    docs = []
    for key, (rows, child_map) in trees.items():
        # AD remains complete, including its airport chapters. AIP.js is a combined duplicate.
        roots = [node(row, child_map, key) for row in rows if not row['pId']]
        docs.extend(roots if key != 'AMDT' else
                    [{'id': key, 't': '修订单 AMDT', 'en': 'AMDT', 'p': '', 'm': False, 'c': roots}])
    for key, variable, label in [('SUP', 'supTreeData', '补充资料 SUP'),
                                  ('AIC', 'aicTreeData', '航空资料通报 AIC'),
                                  ('NOTAM', 'notamTreeData', 'NOTAM 汇总资料')]:
        records = read_assignment(source / 'JsonPath' / f'{key}.js', variable)
        nodes = []
        for row in records:
            validate_pdf(source, row['Document'])
            if key == 'NOTAM':
                identity = row['SeriesName']
                text = f'{identity} 系列 · {row["GenerateTime"]}'
                english = f'{identity} {row["GenerateTime_En"]}'
            else:
                identity = row['Id']
                text = f'{row["Serial"]} {row["Local_Subject"] or row["Subject"]}'
                english = f'{row["Serial"]} {row["Subject"]}'
            nodes.append({'id': key + '/' + identity, 't': text, 'en': english,
                          'p': row['Document'], 'm': row.get('IS_MODIFIED') == 'Y', 'c': []})
        docs.append({'id': key, 't': label, 'en': key, 'p': '', 'm': False, 'c': nodes})

    customers = read_assignment(source / 'Customers.js', 'Customers', unquoted_keys=True)
    if len(customers) != 1:
        raise ValueError('Expected exactly one offline EAIP edition')
    customer = customers[0]
    version_dirs = {Path(row['pdfPath']).parts[0] for row in trees['AD'][0] if row['pdfPath']}
    if len(version_dirs) != 1:
        raise ValueError('Expected exactly one EAIP data directory')
    effective = customer['EffectiveDate']
    if not re.fullmatch(r'\d{10}', effective):
        raise ValueError(f'Invalid EffectiveDate: {effective}')
    meta = {'DataVersion': next(iter(version_dirs)), 'DeclaredVersion': customer['DataVersion'],
            'EffectiveDate': f'20{effective[:2]}-{effective[2:4]}-{effective[4:6]} {effective[6:8]}:{effective[8:]} UTC',
            'EffectiveDateRaw': effective, 'EffectiveShow': customer['EffectiveShow'],
            'Deadline': customer['Deadline'], 'PublishDate': customer['PublishDate'],
            'missingAirportDetails': missing_details}
    return airports, charts_by_airport, details, docs, meta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE, help='EAIP data directory (Customers.js, JsonPath and edition directory)')
    parser.add_argument('--output', type=Path, default=BASE / 'public/data/index')
    args = parser.parse_args()
    # Validate every input before writing indexes.
    airports, charts, details, docs, meta = build(args.source.resolve())
    outputs = {'airports.json': sorted(airports, key=lambda a: a['icao']),
               'airport_details.json': details, 'docs.json': docs, 'meta.json': meta}
    outputs.update({f'charts/{icao}.json': rows for icao, rows in charts.items()})
    for name, value in outputs.items():
        target = args.output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(airports)} airports, {sum(map(len, charts.values()))} airport PDFs, {len(docs)} document roots')
    if meta['missingAirportDetails']:
        print('Published without structured airport summary: ' + ', '.join(meta['missingAirportDetails']))
    print(f'Indexes: {args.output.resolve()}')


if __name__ == '__main__':
    main()
