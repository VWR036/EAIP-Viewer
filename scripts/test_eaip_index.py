import json
from pathlib import Path
import tempfile
import unittest

from build_eaip_index import (DEFAULT_SOURCE, build, chart_type, directory,
                              read_assignment, validate_pdf)


class EaipIndexTests(unittest.TestCase):
    def test_mixed_procedures_and_supar(self):
        self.assertEqual(chart_type('IAC RNP ILS/DME z RWY09'), '仪表进近图_ILS')
        self.assertEqual(chart_type('STAR RNAV RWY06/07(OKTUG/SUPAR)'), '标准仪表进场图')
        self.assertEqual(chart_type('IAC LOC/DME y RWY36'), '仪表进近图_LOC')
        self.assertEqual(chart_type('DATABASE CODING TABLE'), '数据库编码表')

    def test_assignment_without_executing_javascript(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'data.js'
            path.write_text('var Customers=[{DataVersion:"v1",EffectiveDate:"2610281600"}]', encoding='utf-8')
            self.assertEqual(read_assignment(path, 'Customers', True)[0]['DataVersion'], 'v1')
            path.write_text('var Customers=[]; alert("unexpected")', encoding='utf-8')
            with self.assertRaises(json.JSONDecodeError):
                read_assignment(path, 'Customers', True)

    def test_missing_pdf_and_escape_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(FileNotFoundError):
                validate_pdf(Path(folder), 'missing.pdf')
            with self.assertRaises(ValueError):
                validate_pdf(Path(folder), '../outside.pdf')

    def test_invalid_directory_relationships_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            def row(identity, parent):
                return {'id': identity, 'pId': parent, 'pdfPath': ''}
            for rows in [[row('a', ''), row('a', '')], [row('a', 'missing')],
                         [row('a', 'b'), row('b', 'a')]]:
                with self.subTest(rows=rows), self.assertRaises(ValueError):
                    directory(rows, Path(folder))

    @unittest.skipUnless(DEFAULT_SOURCE.is_dir(), 'Local EAIP edition is required')
    def test_published_edition_coverage(self):
        airports, charts, details, docs, meta = build(DEFAULT_SOURCE)
        self.assertEqual({a['icao'] for a in airports}, set(charts))
        referenced = set()
        for icao, entries in charts.items():
            paths = [c['f'] for c in entries]
            self.assertEqual(len(paths), len(set(paths)), icao)
            self.assertTrue(all('/Terminal/' + icao + '/' in p for p in paths))
            referenced.update(paths)
        identities = set()
        def walk(nodes):
            for n in nodes:
                self.assertNotIn(n['id'], identities)
                identities.add(n['id'])
                if n['p']:
                    referenced.add(n['p'])
                walk(n['c'])
        walk(docs)
        published = {p.relative_to(DEFAULT_SOURCE).as_posix() for p in DEFAULT_SOURCE.rglob('*.pdf')}
        self.assertEqual(referenced, published)
        self.assertEqual(set(details) | set(meta['missingAirportDetails']), set(charts))
        self.assertTrue(all(not c['s'] for entries in charts.values() for c in entries))


if __name__ == '__main__':
    unittest.main()
