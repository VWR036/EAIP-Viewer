"""Validate the complete dataset, then publish an AIXM BASELINE snapshot."""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import xml.etree.ElementTree as ET

A = "http://www.aixm.aero/schema/5.1.1"
G = "http://www.opengis.net/gml/3.2"
M = "http://www.aixm.aero/schema/5.1.1/message"
X = "http://www.w3.org/1999/xlink"
C = "https://www.eaipchina.cn/schema/dataset/checksum"
D = "https://www.eaipchina.cn/schema/dataset/meta"
TYPES = "AirportHeliport Airspace Runway RunwayDirection RunwayCentrelinePoint DesignatedPoint Navaid VOR DME NDB Localizer Glidepath MarkerBeacon Route RouteSegment AirTrafficControlService RadioCommunicationChannel Unit".split()
AIRSPACES = "FIR CTA TMA SECTOR P R D ADIZ".split()
for prefix, uri in [("aixm", A), ("gml", G), ("xlink", X)]:
    ET.register_namespace(prefix, uri)

def local(tag):
    return tag.rsplit("}", 1)[-1]

def instant(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))

def tree(node):
    return {"name": local(node.tag), "namespace": node.tag[1:].split("}")[0] if node.tag.startswith("{") else "", "attributes": dict(node.attrib), "text": node.text.strip() if node.text else "", "children": [tree(c) for c in node]}

def text(node, name):
    return node.findtext("{" + A + "}" + name)

def select_slice(obj, effective, context):
    slices = [s for wrapper in obj.findall("{" + A + "}timeSlice") for s in wrapper]
    candidates = []
    for s in slices:
        if text(s, "interpretation") != "BASELINE":
            raise ValueError(f"{context}: unsupported interpretation {text(s, 'interpretation')}")
        begin = s.find(".//{" + G + "}beginPosition")
        end = s.find(".//{" + G + "}endPosition")
        if begin is None or not begin.text or end is None:
            raise ValueError(f"{context}: unsupported validTime")
        if not end.text and end.get("indeterminatePosition") != "unknown":
            raise ValueError(f"{context}: unsupported endPosition {end.attrib}")
        try:
            sequence, correction = int(text(s, "sequenceNumber")), int(text(s, "correctionNumber"))
        except (TypeError, ValueError) as error:
            raise ValueError(f"{context}: invalid sequenceNumber/correctionNumber") from error
        if instant(begin.text) <= effective and (not end.text or effective < instant(end.text)):
            candidates.append((s, {"id": s.get("{" + G + "}id"), "interpretation": "BASELINE", "sequenceNumber": sequence, "correctionNumber": correction, "begin": begin.text, "end": end.text, "endAttributes": dict(end.attrib)}))
    if not slices:
        raise ValueError(f"{context}: missing timeSlice")
    if len(candidates) > 1:
        # Overlapping BASELINE histories need delta reconstruction, outside phase one.
        raise ValueError(f"{context}: unsupported overlapping BASELINE time slices; refusing to guess")
    return candidates[0] if candidates else (None, None)

def build(source):
    source = Path(source).resolve()
    checksum = ET.parse(source / "checksum.xml").getroot()
    meta_node = checksum.find("{" + D + "}datasetMeta")
    if meta_node is None:
        raise ValueError("checksum.xml: missing datasetMeta")
    meta = {local(n.tag): n.text for n in meta_node}
    effective = instant(meta["effectiveTime"])
    files = []
    for entry in checksum.findall(".//{" + C + "}file"):
        name = entry.findtext("{" + C + "}filename")
        path = (source / name).resolve()
        if not path.is_relative_to(source):
            raise ValueError(f"checksum.xml: path escapes dataset: {name}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != entry.findtext("{" + C + "}sha256sum"):
            raise ValueError(f"{name}: SHA-256 mismatch")
        # Difference is validated as XML too, but never merged.
        ET.parse(path)
        files.append(name)
    if not files:
        raise ValueError("checksum.xml: empty file list")
    baseline = sorted(p.relative_to(source).as_posix() for p in (source / "Baseline").glob("*.xml"))
    if not baseline or any(p not in files for p in baseline):
        raise ValueError("Baseline files missing from checksum manifest")
    objects, refs, inactive, slice_counts = {}, [], [], collections.Counter()
    publisher = None
    for name in baseline:
        root = ET.parse(source / name).getroot()
        if root.tag != "{" + M + "}AIXMBasicMessage":
            raise ValueError(f"{name}: expected AIXMBasicMessage")
        organisation = root.find(".//{http://www.isotc211.org/2005/gmd}organisationName/{http://www.isotc211.org/2005/gco}CharacterString")
        if organisation is not None:
            publisher = organisation.text
        for member in root.findall("{" + M + "}hasMember"):
            if len(member) != 1:
                raise ValueError(f"{name}: invalid hasMember")
            obj = member[0]
            kind, oid = local(obj.tag), obj.findtext("{" + G + "}identifier")
            context = f"{name}: {kind} {oid}"
            if kind not in TYPES or obj.tag != "{" + A + "}" + kind:
                raise ValueError(f"{context}: unsupported object type")
            if not oid or oid in objects:
                raise ValueError(f"{context}: missing or duplicate identifier")
            slice_counts[len(obj.findall("{" + A + "}timeSlice"))] += 1
            selected, selection = select_slice(obj, effective, context)
            fields = {local(c.tag): c.text.strip() if c.text else "" for c in selected if not len(c)} if selected is not None else {}
            record = {"id": oid, "type": kind, "name": fields.get("name"), "fields": fields, "sourceFile": name, "active": selected is not None, "selectedTimeSlice": selection, "properties": tree(selected if selected is not None else obj), "xml": ET.tostring(obj, encoding="unicode")}
            objects[oid] = record
            if selected is None:
                inactive.append({"id": oid, "sourceFile": name, "reason": "No BASELINE valid at effectiveTime"})
            def walk(node, path, active):
                path = path + [local(node.tag)]
                href = node.get("{" + X + "}href")
                if href:
                    if not href.startswith("urn:uuid:"):
                        raise ValueError(f"{context}: {'/'.join(path)}: unsupported href {href}")
                    refs.append({"sourceId": oid, "targetId": href[9:], "field": local(node.tag), "path": "/".join(path), "role": "start" if "start" in path else "end" if "end" in path else None, "active": active})
                for child in node:
                    walk(child, path, active)
            for wrapper in obj.findall("{" + A + "}timeSlice"):
                for s in wrapper:
                    walk(s, [], s is selected)
    targets = {"associatedAirportHeliport": {"AirportHeliport"}, "usedRunway": {"Runway"}, "onRunway": {"RunwayDirection"}, "servedAirport": {"AirportHeliport"}, "airportHeliport": {"AirportHeliport"}, "theNavaidEquipment": {"VOR", "DME", "NDB", "Localizer", "Glidepath", "MarkerBeacon"}, "pointChoice_fixDesignatedPoint": {"DesignatedPoint"}, "pointChoice_navaidSystem": {"Navaid"}, "routeFormed": {"Route"}, "serviceProvider": {"Unit"}, "radioCommunication": {"RadioCommunicationChannel"}, "clientAirspace": {"Airspace"}}
    for r in refs:
        src, target = objects[r["sourceId"]], objects.get(r["targetId"])
        if target is None or (r["active"] and not target["active"]):
            raise ValueError(f"{src['sourceFile']}: {src['id']}: {r['path']}: missing/inactive target {r['targetId']}")
        if r["field"] in targets and target["type"] not in targets[r["field"]]:
            raise ValueError(f"{src['sourceFile']}: {src['id']}: {r['path']}: unexpected target type {target['type']}")
    active_refs = [r for r in refs if r["active"]]
    reverse, outgoing = collections.defaultdict(list), collections.defaultdict(list)
    for r in active_refs:
        reverse[r["targetId"]].append(r)
        outgoing[r["sourceId"]].append(r)
    def incoming(oid, field):
        return sorted({r["sourceId"] for r in reverse[oid] if r["field"] == field})
    airports = {}
    for oid, obj in objects.items():
        if obj["type"] != "AirportHeliport" or not obj["active"]:
            continue
        runways = incoming(oid, "associatedAirportHeliport")
        navaids = incoming(oid, "servedAirport")
        points = incoming(oid, "airportHeliport")
        evidence = collections.defaultdict(list)
        for endpoint in navaids + points:
            for r in reverse[endpoint]:
                if objects[r["sourceId"]]["type"] == "RouteSegment" and r["role"]:
                    evidence[r["sourceId"]].append({"via": endpoint, "role": r["role"], "path": r["path"]})
        segments = sorted(evidence)
        routes = collections.defaultdict(list)
        for sid in segments:
            for r in outgoing[sid]:
                if r["field"] == "routeFormed":
                    routes[r["targetId"]].append({"via": sid, "endpoints": evidence[sid]})
        airports[oid] = {"runways": runways, "directions": {r: incoming(r, "usedRunway") for r in runways}, "centrelinePoints": {r: sorted({point for direction in incoming(r, "usedRunway") for point in incoming(direction, "onRunway")}) for r in runways}, "navaids": navaids, "equipment": {n: sorted({r["targetId"] for r in outgoing[n] if r["field"] == "theNavaidEquipment"}) for n in navaids}, "points": points, "segments": segments, "routes": sorted(routes), "segmentEvidence": dict(evidence), "routeEvidence": dict(routes)}
    counts = {t: sum(o["type"] == t and o["active"] for o in objects.values()) for t in TYPES}
    raw_counts = {t: sum(o["type"] == t for o in objects.values()) for t in TYPES}
    spaces = collections.Counter(o["fields"].get("type") for o in objects.values() if o["type"] == "Airspace" and o["active"])
    if set(spaces) - set(AIRSPACES):
        raise ValueError(f"Unknown Airspace types: {dict(spaces)}")
    manifest = {"formatVersion": 1, **meta, "publisher": publisher, "validation": {"status": "passed", "files": len(files), "sha256": True, "references": len(refs)}, "counts": counts, "rawCounts": raw_counts, "airspaceCounts": dict(spaces), "diagnostics": {"inactive": inactive, "timeSliceDistribution": dict(slice_counts), "referenceFields": dict(collections.Counter(r["field"] for r in refs)), "notes": ["Difference validated, not merged", "XML is reserialized object fragment", "EPSG::4326 coordinates: latitude, longitude; other CRS shown raw"]}}
    return {"manifest": manifest, "objects": objects, "relations": {"references": refs, "airports": airports}}

def publish(payload, output):
    # Immutable generation directory + atomic manifest pointer prevents mixed snapshots.
    encoded = {name: json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8") for name, data in payload.items()}
    generation = hashlib.sha256(b"".join(encoded.values())).hexdigest()[:20]
    output.mkdir(parents=True, exist_ok=True)
    folder = output / generation
    folder.mkdir(exist_ok=True)
    for name in ("objects", "relations"):
        (folder / (name + ".json")).write_bytes(encoded[name])
    manifest = dict(payload["manifest"], generation=generation, objectsFile=f"{generation}/objects.json", relationsFile=f"{generation}/relations.json")
    with tempfile.NamedTemporaryFile(dir=output, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    os.replace(temporary, output / "manifest.json")

def main():
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=project.parent / "Dataset")
    args = parser.parse_args()
    try:
        payload = build(args.source)
        publish(payload, project / "public/data/airac-index")
        print(json.dumps(payload["manifest"], ensure_ascii=False, indent=2))
    except (OSError, ValueError, ET.ParseError, KeyError, TypeError) as error:
        print(f"AIRAC index failed: {error}. Existing index NOT updated.", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
