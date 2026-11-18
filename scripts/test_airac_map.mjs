import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildMapData, position, searchMap, airspaceGeometry, containsAirspace, airspaceVolumes, propertyText, buildAirspaceServices } from '../src/airac-map.js'

const A = 'http://www.aixm.aero/schema/5.1.1', G = 'http://www.opengis.net/gml/3.2'
const NIL = '{http://www.w3.org/2001/XMLSchema-instance}nil'
const node = (name, children = [], text = '', attributes = {}, namespace = A) => ({ name, children, text, attributes, namespace })
function object(id, type, coords = '29.0855555555 119.6202777778', fields = {}) {
  const geometry = node(type === 'DesignatedPoint' ? 'Point' : 'ElevatedPoint', [node('pos', [], coords, {}, G)], '', { srsName: 'urn:ogc:def:crs:EPSG::4326' })
  const children = ['AirportHeliport', 'DesignatedPoint', 'Navaid'].includes(type) ? [node(type === 'AirportHeliport' ? 'ARP' : 'location', [geometry])] : []
  return { id, type, active: true, name: fields.name || 'SAME', fields, properties: node(`${type}TimeSlice`, children) }
}
const relation = (sourceId, targetId, field, role = null, active = true) => ({ sourceId, targetId, field, role, active })
function segmentRefs(id, start, end, route, startType = 'DesignatedPoint', endType = 'DesignatedPoint') {
  const field = type => type === 'Navaid' ? 'pointChoice_navaidSystem' : 'pointChoice_fixDesignatedPoint'
  return [relation(id, start, field(startType), 'start'), relation(id, end, field(endType), 'end'), relation(id, route, 'routeFormed')]
}

test('semantic ARP / point / Navaid paths preserve GeoJSON longitude, latitude', () => {
  for (const type of ['AirportHeliport', 'DesignatedPoint', 'Navaid']) assert.deepEqual(position(object('x', type)).coordinates, [119.6202777778, 29.0855555555])
  const airport = object('a', 'AirportHeliport')
  airport.properties.children.unshift(node('unrelated', [node('pos', [], '0 0', {}, G)]))
  assert.deepEqual(position(airport).coordinates, [119.6202777778, 29.0855555555])
})

test('nil, empty and absent positions are missing; malformed data never invents a point', () => {
  const nil = object('nil', 'Navaid')
  nil.properties.children[0] = node('location', [], '', { [NIL]: 'true', nilReason: 'unknown' })
  assert.equal(position(nil).status, 'missing')
  assert.match(position(nil).reason, /unknown/)
  assert.equal(position(object('empty', 'DesignatedPoint', ' ')).status, 'missing')
  const absent = object('absent', 'AirportHeliport')
  absent.properties.children = []
  assert.equal(position(absent).status, 'missing')
  for (const coords of ['no 20', 'NaN 20', 'Infinity 20', '1e999 20', '91 20', '20 181', '20 30 40', '0x10 20']) {
    const result = position(object('bad', 'DesignatedPoint', coords))
    assert.equal(result.status, 'invalid', coords)
    assert.equal(result.coordinates, undefined)
  }
})

test('unknown CRS, namespace, ambiguous and unsupported geometry are explicit errors', () => {
  const point = object('p', 'DesignatedPoint')
  const geometry = point.properties.children[0].children[0]
  geometry.attributes.srsName = 'EPSG:3857'
  assert.match(position(point).reason, /CRS/)
  delete geometry.attributes.srsName
  assert.equal(position(point).status, 'invalid')
  geometry.attributes.srsName = 'urn:ogc:def:crs:EPSG::4326'
  geometry.children[0].namespace = A
  assert.match(position(point).reason, /命名空间/)
  geometry.children[0].namespace = G
  geometry.children.push(structuredClone(geometry.children[0]))
  assert.match(position(point).reason, /歧义/)
  geometry.children = [node('posList', [], '20 30', {}, G)]
  assert.match(position(point).reason, /几何结构/)
})

test('effective objects and references only; facilities use their own point and link equipment', () => {
  const n = object('n', 'Navaid'), inactive = object('old', 'DesignatedPoint'), device = object('d', 'DME')
  inactive.active = false
  const data = buildMapData({ n, old: inactive, d: device }, { references: [relation('n', 'd', 'theNavaidEquipment'), relation('n', 'old', 'theNavaidEquipment', null, false)] })
  assert.equal(data.features.size, 1)
  assert.deepEqual(data.equipment.get('n'), ['d'])
  assert.equal(data.search.length, 1)
})

test('mixed endpoints, disconnected and branching routes retain independent real segments', () => {
  const objects = {}
  for (const [id, type, coords] of [['a','DesignatedPoint','20 100'],['b','Navaid','21 101'],['c','DesignatedPoint','22 102'],['d','DesignatedPoint','30 110'],['e','DesignatedPoint','31 111'],['r','Route'],['r2','Route'],['s1','RouteSegment'],['s2','RouteSegment'],['s3','RouteSegment'],['s4','RouteSegment']]) objects[id] = object(id, type, coords)
  const references = [...segmentRefs('s1','a','b','r','DesignatedPoint','Navaid'), ...segmentRefs('s2','b','c','r','Navaid'), ...segmentRefs('s3','d','e','r'), ...segmentRefs('s4','a','b','r2','DesignatedPoint','Navaid')]
  references.push(relation('s1', 'c', 'pointChoice_fixDesignatedPoint', 'start', false))
  const data = buildMapData(objects, { references })
  assert.equal(data.collections.RouteSegment.features.length, 4)
  assert.equal(data.routes.get('r').length, 3)
  assert.deepEqual(data.features.get('s1').geometry.coordinates, [[100,20],[101,21]])
  assert.deepEqual(data.features.get('s3').geometry.coordinates, [[110,30],[111,31]])
  assert.equal(data.features.get('s4').properties.routeId, 'r2')
  // Add a branch sharing the same start, without sorting or joining route geometry.
  objects.s5 = object('s5', 'RouteSegment')
  const branch = buildMapData(objects, { references: [...references, ...segmentRefs('s5','b','d','r','Navaid')] })
  assert.equal(branch.routes.get('r').length, 4)
  assert.deepEqual(branch.features.get('s5').geometry.coordinates, [[101,21],[110,30]])
})

test('missing, inactive, wrong type and ambiguous endpoint relations never create lines', () => {
  const objects = { a: object('a','DesignatedPoint'), b: object('b','Navaid',''), r: object('r','Route'), s: object('s','RouteSegment') }
  let references = segmentRefs('s','a','b','r','DesignatedPoint','Navaid')
  let data = buildMapData(objects, { references })
  assert.equal(data.features.has('s'), false)
  assert.match(data.diagnostics.segments[0].reason, /终点 b/)
  objects.b = object('b','Navaid')
  references.push(relation('s','a','pointChoice_fixDesignatedPoint','start'))
  data = buildMapData(objects, { references })
  assert.match(data.diagnostics.segments[0].reason, /起点引用数量 2/)
  references = segmentRefs('s','a','b','r')
  assert.match(buildMapData(objects,{references}).diagnostics.segments[0].reason, /类型错误/)
  references = segmentRefs('s','absent','b','r','DesignatedPoint','Navaid')
  assert.equal(buildMapData(objects,{references}).features.has('s'), false)
  objects.a.active = false
  references = segmentRefs('s','a','b','r','DesignatedPoint','Navaid')
  assert.match(buildMapData(objects,{references}).diagnostics.segments[0].reason, /引用目标/)
})

test('search preserves duplicate names, identifiers, case trimming, IATA and unavailable results', () => {
  const a = object('a','AirportHeliport',undefined,{ locationIndicatorICAO:'ZABC', designatorIATA:'ABC', name:'Same' })
  const b = object('b','Navaid','',{ designator:'ABC', name:'Same' })
  const r = object('r','Route',undefined,{ designatorPrefix:'A', designatorNumber:'123', name:'Route' })
  const data = buildMapData({a,b,r},{ references: [] })
  assert.equal(searchMap(data,'  sAmE ').total, 2)
  assert.deepEqual(searchMap(data,'abc').results.map(r=>r.id), ['a','b'])
  assert.match(searchMap(data,'abc').results[1].reason, /为空/)
  assert.equal(searchMap(data,'a123').results[0].id, 'r')
  assert.equal(searchMap(data,'same',1).total, 2)
  assert.equal(searchMap(data,'same',1).results.length, 1)
  assert.equal(searchMap(data,' ').total, 0)
})

test('local snapshot geometry and every effective segment match their real endpoint coordinates', t => {
  const base = new URL('../public/data/airac-index/', import.meta.url)
  const manifestPath = new URL('manifest.json', base)
  if (!fs.existsSync(manifestPath)) { t.skip('本地 AIRAC 索引未提供'); return }
  const manifest = JSON.parse(fs.readFileSync(manifestPath))
  const objects = JSON.parse(fs.readFileSync(new URL(manifest.objectsFile, base)))
  const relations = JSON.parse(fs.readFileSync(new URL(manifest.relationsFile, base)))
  const data = buildMapData(objects, relations)
  assert.equal(data.diagnostics.invalid.filter(d => d.type !== 'Airspace').length, 0)
  assert.equal(data.diagnostics.segments.length, 0)
  for (const type of ['AirportHeliport','DesignatedPoint']) assert.equal(data.collections[type].features.length, manifest.counts[type])
  assert.equal(data.collections.Navaid.features.length + data.diagnostics.counts.Navaid.missing, manifest.counts.Navaid)
  assert.equal(data.collections.RouteSegment.features.length, manifest.counts.RouteSegment)
  const spaces = data.diagnostics.counts.Airspace
  assert.equal(spaces.drawn + spaces.missing + spaces.invalid, manifest.counts.Airspace)
  for (const prefix of ['ZSSSAR', 'ZSSSAP']) {
    const sectors = Object.values(objects).filter(o => o.type === 'Airspace' && new RegExp(`^${prefix}\\d+[A-Z]*$`).test(o.fields.designator))
    assert.equal(sectors.length, prefix === 'ZSSSAR' ? 44 : 17)
    for (const sector of sectors) assert.equal(data.features.has(sector.id), true, sector.fields.designator)
  }
  for (const code of ['ZSHA', 'ZSSSCTA', 'ZSSSAPP', 'ZSSSLTA', 'ZSSSAR33']) {
    const entry = searchMap(data, code).results.find(e => e.code === code)
    assert.ok(entry, code)
    assert.equal(entry.reason, '')
    assert.equal(data.features.get(entry.id).geometry.type, 'Polygon')
  }
  const ar33 = Object.values(objects).find(o => o.fields.designator === 'ZSSSAR33')
  const volume = airspaceVolumes(ar33)[0]
  assert.equal(propertyText({ properties: volume }, 'lowerLimit'), 'GND')
  assert.equal(propertyText({ properties: volume }, 'upperLimit'), '12500 M')
  for (const f of data.collections.RouteSegment.features) {
    for (const [index,role] of ['start','end'].entries()) {
      const r = relations.references.find(r => r.active && r.sourceId === f.properties.id && r.role === role && ['pointChoice_fixDesignatedPoint','pointChoice_navaidSystem'].includes(r.field))
      assert.equal(f.properties[`${role}Id`], r.targetId)
      assert.deepEqual(f.geometry.coordinates[index], position(objects[r.targetId]).coordinates)
    }
  }
  console.log('Snapshot', manifest.generation, JSON.stringify(data.diagnostics.counts), 'routes with geometry', [...data.routes.values()].filter(v=>v.length).length)
})

function spaceObject() {
  const list = node('posList', [], '20 100 20 102 22 102 22 100 20 100', {}, G)
  const curve = node('Curve', [node('segments', [node('GeodesicString', [list], '', {}, G)], '', {}, G)])
  const ring = node('Ring', [node('curveMember', [curve], '', {}, G)], '', {}, G)
  const patch = node('PolygonPatch', [node('exterior', [ring], '', {}, G)], '', {}, G)
  const surface = node('ElevatedSurface', [node('patches', [patch], '', {}, G)], '', { srsName: 'urn:ogc:def:crs:EPSG::4326' })
  const volume = node('AirspaceVolume', [node('horizontalProjection', [surface])])
  return { ...object('space', 'Airspace', undefined, { designator: 'TESTAR01', type: 'SECTOR' }), properties: node('AirspaceTimeSlice', [node('geometryComponent', [node('AirspaceGeometryComponent', [node('theAirspaceVolume', [volume])])])]) }
}

test('airspace polygons preserve axis order, containment, holes and multiple volumes', () => {
  const space = spaceObject()
  const geometry = airspaceGeometry(space).geometry
  assert.deepEqual(geometry.coordinates[0][0], [100, 20])
  assert.equal(containsAirspace(geometry, [101, 21]), true)
  assert.equal(containsAirspace(geometry, [103, 21]), false)
  const hole = [[100.5,20.5],[101.5,20.5],[101.5,21.5],[100.5,21.5],[100.5,20.5]]
  assert.equal(containsAirspace({ type: 'Polygon', coordinates: [...geometry.coordinates, hole] }, [101,21]), false)
  space.properties.children.push(structuredClone(space.properties.children[0]))
  const multi = airspaceGeometry(space).geometry
  assert.equal(multi.type, 'MultiPolygon')
  assert.equal(multi.coordinates.length, 2)
  assert.equal(containsAirspace(multi, [101,21]), true)
  const data = buildMapData({ space }, { references: [] })
  assert.equal(data.features.get('space').properties.airspaceType, 'AR')
  assert.equal(searchMap(data, 'testar01').total, 1)
})

test('unsupported, malformed and unclosed airspace boundaries are diagnosed without drawing', () => {
  for (const change of [
    surface => { surface.attributes.srsName = 'EPSG:3857' },
    surface => { surface.children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].name = 'ArcByCenterPoint' },
    surface => { surface.children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].text = '20 100 20 102 22 102 22 100' },
    surface => { surface.attributes.srsDimension = '3' },
  ]) {
    const space = spaceObject()
    const surface = airspaceVolumes(space)[0].children[0].children[0]
    change(surface)
    assert.equal(airspaceGeometry(space).status, 'invalid')
    const data = buildMapData({ space }, { references: [] })
    assert.equal(data.features.has('space'), false)
    assert.equal(data.diagnostics.invalid.length, 1)
    assert.ok(searchMap(data, 'testar01').results[0].reason)
  }
})


test('airspace services retain per-service units, callsigns and ranked transmit/receive channels', () => {
  const space = object('space', 'Airspace'), other = object('other', 'Airspace')
  const service = object('service', 'AirTrafficControlService'), second = object('second', 'AirTrafficControlService')
  service.properties.children.push(node('call-sign', [node('CallsignDetail', [node('callSign', [], 'TEST CONTROL'), node('language', [], 'eng')])]))
  second.properties.children.push(node('call-sign', [], '', { [NIL]: 'true', nilReason: 'unknown' }))
  const unit = object('unit', 'Unit', undefined, { name: 'TEST ACC' }), otherUnit = object('otherUnit', 'Unit')
  const primary = object('primary', 'RadioCommunicationChannel'), alternate = object('alternate', 'RadioCommunicationChannel')
  primary.properties.children.push(node('rank', [], 'PRIMARY'), node('frequencyTransmission', [], '120.75', { uom: 'MHZ' }), node('frequencyReception', [], '121.0', { uom: 'MHZ' }))
  alternate.properties.children.push(node('rank', [], 'ALTERNATE'), node('frequencyTransmission', [], '', { [NIL]: 'true', nilReason: 'unknown' }))
  const inactive = object('inactive', 'AirTrafficControlService'); inactive.active = false
  const objects = { space, other, service, second, unit, otherUnit, primary, alternate, inactive }
  const references = [
    relation('service', 'space', 'clientAirspace'), relation('service', 'space', 'clientAirspace'),
    relation('service', 'unit', 'serviceProvider'), relation('service', 'unit', 'serviceProvider'),
    relation('service', 'alternate', 'radioCommunication'), relation('service', 'primary', 'radioCommunication'), relation('service', 'primary', 'radioCommunication'),
    relation('second', 'space', 'clientAirspace'), relation('second', 'otherUnit', 'serviceProvider'),
    relation('second', 'primary', 'radioCommunication', null, false), relation('inactive', 'space', 'clientAirspace', null, false),
  ]
  const data = buildAirspaceServices(objects, { references })
  assert.deepEqual(data.get('other'), [])
  assert.equal(data.get('space').length, 2)
  const [first, next] = data.get('space')
  assert.deepEqual(first.unitIds, ['unit'])
  assert.deepEqual(first.callsigns, [{ callSign: 'TEST CONTROL', language: 'eng' }])
  assert.deepEqual(first.channels.map(c => c.id), ['primary', 'alternate'])
  assert.equal(first.channels[0].transmission, '120.75 MHZ')
  assert.equal(first.channels[0].reception, '121.0 MHZ')
  assert.equal(first.channels[1].transmission, 'nil · unknown')
  assert.equal(first.channels[1].reception, '字段未提供')
  assert.deepEqual(next.unitIds, ['otherUnit'])
  assert.deepEqual(next.channels, [])
  assert.equal(next.callsignStatus, 'nil · unknown')
  assert.throws(() => buildAirspaceServices(objects, { references: [relation('service', 'missing', 'radioCommunication')] }), /空管服务引用错误/)
})

test('snapshot airspace communications match effective XML references and Shanghai AR33 values', t => {
  const base = new URL('../public/data/airac-index/', import.meta.url)
  if (!fs.existsSync(new URL('manifest.json', base))) { t.skip('本地 AIRAC 索引未提供'); return }
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', base)))
  const objects = JSON.parse(fs.readFileSync(new URL(manifest.objectsFile, base)))
  const relations = JSON.parse(fs.readFileSync(new URL(manifest.relationsFile, base)))
  const data = buildAirspaceServices(objects, relations)
  const refs = relations.references.filter(r => r.active)
  for (const [id, services] of data) {
    assert.deepEqual(services.map(s => s.id), [...new Set(refs.filter(r => r.field === 'clientAirspace' && r.targetId === id).map(r => r.sourceId))])
    for (const service of services) {
      for (const [field, ids] of [['serviceProvider', service.unitIds], ['radioCommunication', service.channels.map(c => c.id)]]) {
        assert.deepEqual([...ids].sort(), [...new Set(refs.filter(r => r.sourceId === service.id && r.field === field).map(r => r.targetId))].sort())
      }
    }
  }
  const ar33 = Object.values(objects).find(o => o.fields.designator === 'ZSSSAR33')
  const [service] = data.get(ar33.id)
  assert.equal(objects[service.unitIds[0]].name, 'SHANGHAI ACC')
  assert.equal(service.callsigns[0].callSign, 'SHANGHAI CONTROL')
  assert.deepEqual(service.channels.map(c => [c.rank, c.transmission, c.reception]), [['PRIMARY', '120.75 MHZ', '120.75 MHZ'], ['ALTERNATE', '134.0 MHZ', '134.0 MHZ']])
})
