"""Isolated failures and independent real-data relationship checks."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
from build_airac_index import A, G, M, X, C, D, build, publish

class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "Baseline").mkdir()
        self.path = self.root / "Baseline/test.xml"
        self.output = self.root / "out"
        self.output.mkdir()
        (self.output / "manifest.json").write_text("OLD")
        self.airport = self.object("AirportHeliport", "airport")
        self.point = self.object("DesignatedPoint", "point")
        self.slice(self.point).append(ET.Element("{" + A + "}airportHeliport", {"{" + X + "}href": "urn:uuid:airport"}))
        self.save([self.airport, self.point])

    def object(self, kind, oid):
        return ET.fromstring(f'''<a:{kind} xmlns:a="{A}" xmlns:g="{G}"><g:identifier>{oid}</g:identifier><a:timeSlice><a:{kind}TimeSlice g:id="slice-{oid}"><g:validTime><g:TimePeriod><g:beginPosition>2025-01-01T00:00:00Z</g:beginPosition><g:endPosition indeterminatePosition="unknown"/></g:TimePeriod></g:validTime><a:interpretation>BASELINE</a:interpretation><a:sequenceNumber>1</a:sequenceNumber><a:correctionNumber>0</a:correctionNumber><a:name>TEST</a:name></a:{kind}TimeSlice></a:timeSlice></a:{kind}>''')

    def slice(self, obj):
        return obj.find("{" + A + "}timeSlice")[0]

    def checksum(self):
        root = ET.Element("{" + C + "}datasetChecksum")
        meta = ET.SubElement(root, "{" + D + "}datasetMeta")
        for k, v in {"uid":"test", "effectiveTime":"2026-10-28T16:00:00Z"}.items():
            ET.SubElement(meta, "{" + D + "}" + k).text = v
        entry = ET.SubElement(ET.SubElement(root, "{" + C + "}files"), "{" + C + "}file")
        ET.SubElement(entry, "{" + C + "}filename").text = "Baseline/test.xml"
        ET.SubElement(entry, "{" + C + "}sha256sum").text = hashlib.sha256(self.path.read_bytes()).hexdigest()
        ET.ElementTree(root).write(self.root / "checksum.xml", encoding="utf-8")

    def save(self, objects):
        root = ET.Element("{" + M + "}AIXMBasicMessage")
        for obj in objects:
            ET.SubElement(root, "{" + M + "}hasMember").append(obj)
        ET.ElementTree(root).write(self.path, encoding="utf-8")
        self.checksum()

    def failure(self, message):
        with self.assertRaisesRegex((ValueError, ET.ParseError, OSError), message):
            publish(build(self.root), self.output)
        self.assertEqual((self.output / "manifest.json").read_text(), "OLD")

    def test_broken_xml(self):
        self.path.write_text("<broken>")
        self.checksum()
        self.failure("no element found")

    def test_missing_target(self):
        self.save([self.point])
        self.failure("test.xml.*point.*airportHeliport.*airport")

    def test_duplicate_identifier(self):
        self.save([self.airport, self.airport])
        self.failure("duplicate identifier")

    def test_hash_mismatch(self):
        self.path.write_bytes(self.path.read_bytes() + b" ")
        self.failure("SHA-256 mismatch")

    def test_missing_file(self):
        self.path.unlink()
        self.failure("test.xml")

    def test_nil_and_repeated_links(self):
        s = self.slice(self.point)
        s.append(ET.Element("{" + A + "}name", {"{http://www.w3.org/2001/XMLSchema-instance}nil":"true", "nilReason":"unknown"}))
        s.append(copy.deepcopy(s[-2]))
        self.save([self.airport,self.point])
        result = build(self.root)
        self.assertEqual(result["relations"]["airports"]["airport"]["points"], ["point"])
        self.assertEqual(len(result["relations"]["references"]), 2)
        props = result["objects"]["point"]["properties"]["children"]
        self.assertEqual(sum(n["name"] == "name" for n in props), 2)
        self.assertTrue(any(n["attributes"].get("nilReason") == "unknown" for n in props))
        publish(result, self.output)
        first = (self.output / "manifest.json").read_bytes()
        publish(result, self.output)
        self.assertEqual(first, (self.output / "manifest.json").read_bytes())

    def test_unsupported_overlapping_timeslices(self):
        self.airport.append(copy.deepcopy(self.airport.find("{" + A + "}timeSlice")))
        self.save([self.airport,self.point])
        self.failure("overlapping BASELINE")

    def test_unsupported_interpretation(self):
        self.slice(self.airport).find("{" + A + "}interpretation").text = "TEMPDELTA"
        self.save([self.airport,self.point])
        self.failure("unsupported interpretation")

    def test_end_exclusive_and_inactive_target(self):
        self.slice(self.airport).find(".//{" + G + "}endPosition").text = "2026-10-28T16:00:00Z"
        self.save([self.airport,self.point])
        self.failure("inactive target")
        self.save([self.airport])
        result = build(self.root)
        self.assertFalse(result["objects"]["airport"]["active"])
        self.assertEqual(len(result["manifest"]["diagnostics"]["inactive"]), 1)

    def test_path_escape(self):
        path = self.root / "checksum.xml"
        root = ET.parse(path)
        root.find(".//{" + C + "}filename").text = "../escape.xml"
        root.write(path, encoding="utf-8")
        self.failure("path escapes")

class RealDatasetTests(unittest.TestCase):
    def test_airports_against_xml(self):
        project = Path(__file__).resolve().parents[1]
        source = project.parent / "Dataset"
        result = build(source)
        raw, refs = {}, []
        def scan(node, oid, path):
            path = path + [node.tag.rsplit("}",1)[-1]]
            href = node.get("{" + X + "}href")
            if href:
                refs.append((oid, path[-1], href[9:], "start" if "start" in path else "end" if "end" in path else None))
            for child in node:
                scan(child, oid, path)
        for file in (source / "Baseline").glob("*.xml"):
            for member in ET.parse(file).getroot().findall("{" + M + "}hasMember"):
                o = member[0]; oid = o.findtext("{" + G + "}identifier")
                raw[oid] = o
                scan(o, oid, [])
        self.assertEqual(len(raw), 10242)
        self.assertEqual(len(refs), 13080)
        self.assertEqual(sum(f == "airportHeliport" for _, f, _, _ in refs), 85)
        for icao in ["ZBAA", "ZSPD"]:
            oid = next(i for i,o in raw.items() if o.findtext(".//{" + A + "}locationIndicatorICAO") == icao)
            actual = result["relations"]["airports"][oid]
            expected = {}
            for key, field in [("runways","associatedAirportHeliport"),("navaids","servedAirport"),("points","airportHeliport")]:
                expected[key] = {s for s,f,t,_ in refs if f == field and t == oid}
                self.assertEqual(set(actual[key]), expected[key])
            for r in expected["runways"]:
                directions = {s for s,f,t,_ in refs if f == "usedRunway" and t == r}
                self.assertEqual(set(actual["directions"][r]), directions)
                points = {s for s,f,t,_ in refs if f == "onRunway" and t in directions}
                self.assertEqual(set(actual["centrelinePoints"][r]), points)
                self.assertTrue(points)
            for n in expected["navaids"]:
                self.assertEqual(set(actual["equipment"][n]), {t for s,f,t,_ in refs if s == n and f == "theNavaidEquipment"})
            endpoints = expected["points"] | expected["navaids"]
            segments = {s for s,f,t,role in refs if t in endpoints and role in ("start","end")}
            routes = {t for s,f,t,_ in refs if s in segments and f == "routeFormed"}
            self.assertEqual(set(actual["segments"]), segments)
            self.assertEqual(set(actual["routes"]), routes)
            self.assertEqual(len(actual["segments"]), len(segments))
            self.assertTrue(segments)
            print(icao, {k: len(actual[k]) for k in ["runways","navaids","points","segments","routes"]}, "directions", sum(map(len,actual["directions"].values())), "centrelinePoints", sum(map(len,actual["centrelinePoints"].values())))

if __name__ == "__main__":
    unittest.main()
