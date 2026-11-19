import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildMapData, position, searchMap, airspaceGeometry, containsAirspace, airspaceVolumes, propertyText, buildAirspaceServices, routeDirection, routeArrowHeads, routeNavigationLabel, matchesRouteNavigation } from '../src/airac-map.js'

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
  assert.equal(data.diagnostics.directions.length, 0)
  for (const type of ['AirportHeliport','DesignatedPoint']) assert.equal(data.collections[type].features.length, manifest.counts[type])
  assert.equal(data.collections.Navaid.features.length + data.diagnostics.counts.Navaid.missing, manifest.counts.Navaid)
  assert.equal(data.collections.RouteSegment.features.length, manifest.counts.RouteSegment)
  assert.equal(data.collections.RouteSegment.features.filter(f => f.properties.navigationLabel).length, 175)
  for (const [filter, count] of [['ALL',2624],['RNAV',121],['RNP',54],['RNAV 1.0',30],['RNAV 2.0',91],['RNP 1.0',7],['RNP 2.0',1],['RNP 4.0',41],['RNP 10.0',5]]) {
    const features = data.collections.RouteSegment.features.filter(f => matchesRouteNavigation(f, filter))
    assert.equal(features.length, count, filter)
    for (const feature of features) {
      const fields = objects[feature.properties.id].fields
      if (filter !== 'ALL') assert.equal(fields.navigationType, filter.startsWith('RNAV') ? 'RNAV' : 'OTHER:RNP')
      if (filter.includes(' ')) assert.equal(fields.requiredNavigationPerformance, filter.split(' ')[1])
    }
  }
  const spaces = data.diagnostics.counts.Airspace
  assert.equal(spaces.drawn + spaces.missing + spaces.invalid, manifest.counts.Airspace)
  const hasCircle = n => (n.namespace === G && n.name === 'CircleByCenterPoint') || n.children.some(hasCircle)
  const circleSpaces = Object.values(objects).filter(o => o.type === 'Airspace' && hasCircle(o.properties))
  assert.equal(circleSpaces.length, 10)
  for (const space of circleSpaces) {
    const feature = data.features.get(space.id)
    assert.ok(feature, space.fields.designator || space.name)
    const ring = feature.geometry.coordinates[0]
    assert.deepEqual(ring[0], ring.at(-1))
    assert.ok(ring.length > 100)
  }
  const annotatedCodes = ['ZGNNAR09','ZGNNAR08','ZLXNAP01','ZLXNAP02','ZLXNAP03','ZLXNAP04','ZHHHAP03','ZHHHAP05']
  assert.equal(data.diagnostics.approximations.filter(r=>!r.reason.startsWith('边界不完整')).length, 12)
  for (const code of annotatedCodes) {
    const space = Object.values(objects).find(o => o.type === 'Airspace' && o.fields.designator === code)
    const feature = data.features.get(space.id)
    assert.ok(feature, code)
    const ring = feature.geometry.coordinates[0]
    assert.deepEqual(ring[0], ring.at(-1))
    assert.equal(feature.properties.geometryWarnings.length, 1)
    assert.match(feature.properties.geometryWarnings[0], /近似连接保留 XML 端点/)
    const lists = []
    const visit = n => { if (n.namespace === G && n.name === 'posList') lists.push(n); n.children.forEach(visit) }
    visit(space.properties)
    for (const list of lists) {
      const parts = list.text.trim().split(/\s+/).map(Number)
      for (let i = 0; i < parts.length; i += 2) assert.ok(ring.some(p => p[0] === parts[i + 1] && p[1] === parts[i]), `${code} preserves XML vertex`)
    }
  }
  for (const code of ['ZBAACTA','ZGJDTMA','ZPJHAPP']) {
    const space = Object.values(objects).find(o => o.type === 'Airspace' && o.fields.designator === code)
    assert.equal(data.features.get(space.id).properties.incompleteBoundary, true, `${code} uses straight connectors for missing boundary geometry`)
  }
  const xining = Object.values(objects).find(o => o.type === 'Airspace' && o.fields.designator === 'ZLXNAPP')
  const xiningFeature = data.features.get(xining.id)
  assert.ok(xiningFeature)
  const xiningRing = xiningFeature.geometry.coordinates[0]
  assert.deepEqual(xiningRing[0], xiningRing.at(-1))
  assert.equal(xiningFeature.properties.geometryWarnings.length, 2)
  assert.ok(xiningFeature.properties.geometryWarnings.every(w => w.includes('按 XML 顺序直线连接')))
  assert.ok(xiningRing.some(p => p[0] === 101.8336111111 && p[1] === 35.7769444445))
  assert.ok(xiningRing.some(p => p[0] === 101.5833333333 && p[1] === 37.3752777778))
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
    const availability = objects[f.properties.id].properties.children.find(n => n.name === 'availability')
    const direction = availability.children[0].children.find(n => n.name === 'direction').text
    assert.equal(f.properties.direction, direction)
    const navigation = objects[f.properties.id].properties.children.find(n => n.name === 'navigationType')
    const performance = objects[f.properties.id].properties.children.find(n => n.name === 'requiredNavigationPerformance')
    assert.equal(f.properties.navigationLabel, navigation.text ? `${navigation.text === 'OTHER:RNP' ? 'RNP' : navigation.text} ${performance.text}` : '')
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


test('route arrows use availability direction rather than endpoint order or magnetic track', () => {
  const objects = { a: object('a','DesignatedPoint','20 100'), b: object('b','DesignatedPoint','21 101'), r: object('r','Route'), s: object('s','RouteSegment') }
  const references = segmentRefs('s','a','b','r')
  for (const direction of ['FORWARD','BACKWARD','BOTH']) {
    objects.s.properties.children = [node('availability', [node('RouteAvailability', [node('direction', [], direction)])])]
    const data = buildMapData(objects, { references })
    assert.equal(data.features.get('s').properties.direction, direction)
    assert.deepEqual(data.features.get('s').geometry.coordinates, [[100,20],[101,21]])
    assert.equal(data.diagnostics.directions.length, 0)
  }
  objects.s.properties.children = []
  assert.equal(routeDirection(objects.s).status, 'missing')
  for (const field of [node('direction', [], 'UNKNOWN'), node('direction', [], '', { [NIL]: 'true', nilReason: 'unknown' })]) {
    objects.s.properties.children = [node('availability', [node('RouteAvailability', [field])])]
    const data = buildMapData(objects, { references })
    assert.equal(data.features.get('s').properties.direction, undefined)
    assert.ok(data.features.get('s').properties.directionReason)
    assert.equal(data.diagnostics.directions.length, 1)
  }
})

test('screen-space arrowheads point forward, backward and both ways across map orientations', () => {
  for (const [start,end] of [[[0,0],[100,0]],[[0,0],[0,100]],[[100,100],[0,0]]]) {
    const dx=end[0]-start[0], dy=end[1]-start[1]
    for (const direction of ['FORWARD','BACKWARD','BOTH']) {
      const heads=routeArrowHeads(start,end,direction)
      assert.equal(heads.length, direction === 'BOTH' ? 2 : 1)
      for (const [i,head] of heads.entries()) {
        const base=[(head[0][0]+head[2][0])/2,(head[0][1]+head[2][1])/2]
        const dot=(head[1][0]-base[0])*dx+(head[1][1]-base[1])*dy
        assert.equal(dot > 0, direction === 'FORWARD' || (direction === 'BOTH' && i === 1))
        assert.ok(Math.abs(Math.hypot(head[1][0]-base[0],head[1][1]-base[1])-7)<1e-10)
      }
    }
  }
  assert.deepEqual(routeArrowHeads([0,0],[10,0],'BOTH'), [])
  assert.deepEqual(routeArrowHeads([0,0],[0,0],'FORWARD'), [])
  assert.throws(() => routeArrowHeads([0,0],[100,0],'UNKNOWN'), /不支持/)
})


test('navigation labels distinguish RNAV from RNP and preserve explicit missing performance', () => {
  const segment = object('s','RouteSegment')
  segment.properties.children = [node('navigationType', [], 'OTHER:RNP'), node('requiredNavigationPerformance', [], '4.0')]
  assert.equal(routeNavigationLabel(segment), 'RNP 4.0')
  segment.properties.children[0].text = 'RNAV'
  assert.equal(routeNavigationLabel(segment), 'RNAV 4.0')
  segment.properties.children[1] = node('requiredNavigationPerformance', [], '', { [NIL]: 'true', nilReason: 'unknown' })
  assert.equal(routeNavigationLabel(segment), 'RNAV nil · unknown')
  segment.properties.children[0] = node('navigationType', [], '', { [NIL]: 'true', nilReason: 'unknown' })
  assert.equal(routeNavigationLabel(segment), '')
  segment.properties.children = []
  assert.equal(routeNavigationLabel(segment), '')
})


function curvedSpace(kind = 'CircleByCenterPoint', center = '0 0', radius = '100', uom = 'KM', angles = []) {
  const space = spaceObject()
  const surface = airspaceVolumes(space)[0].children[0].children[0]
  const segments = surface.children[0].children[0].children[0].children[0].children[0].children[0].children[0]
  const segment = node(kind, [node('pos', [], center, {}, G), node('radius', [], radius, { uom }, G), ...angles.map((a,i) => node(i ? 'endAngle' : 'startAngle', [], String(a), { uom: 'deg' }, G))], '', { numArc: '1' }, G)
  segments.children = [segment]
  return { space, segment, segments }
}

test('center-point circles use WGS84 distances, unit conversion and exact closure', () => {
  const { space } = curvedSpace()
  const result = airspaceGeometry(space)
  assert.equal(result.status, 'valid')
  const ring = result.geometry.coordinates[0]
  assert.deepEqual(ring[0], ring.at(-1))
  assert.ok(Math.abs(ring[0][0]) < 1e-10)
  assert.ok(Math.abs(ring[0][1] - 0.9043687229127633) < 1e-9)
  const east = airspaceGeometry(curvedSpace('CircleByCenterPoint','0 0','111319.49079327357','M').space).geometry.coordinates[0]
  assert.ok(east.some(([lon,lat]) => Math.abs(lon - 1) < 1e-8 && Math.abs(lat) < 1e-8))
  const nautical = airspaceGeometry(curvedSpace('CircleByCenterPoint','0 0','10','NM').space).geometry.coordinates
  const metres = airspaceGeometry(curvedSpace('CircleByCenterPoint','0 0','18520','M').space).geometry.coordinates
  assert.deepEqual(nautical, metres)
  assert.equal(containsAirspace(result.geometry,[0,0]), true)
})

test('partial arcs respect signed bearings and angles beyond 360 when joined to a straight segment', () => {
  const north = [0,0.9043687229127633], east = [0.8983152841195214,0], west = [-0.8983152841195214,0]
  for (const [angles,start,end] of [[[0,90],north,east],[[90,0],east,north],[[270,450],west,east]]) {
    const { space, segments } = curvedSpace('ArcByCenterPoint','0 0','100','KM',angles)
    segments.children.push(node('GeodesicString',[node('posList',[],`${end[1]} ${end[0]} ${start[1]} ${start[0]}`,{},G)],'',{},G))
    const result = airspaceGeometry(space)
    assert.equal(result.status,'valid',result.reason)
    const ring=result.geometry.coordinates[0]
    assert.deepEqual(ring[0],ring.at(-1))
    assert.ok(Math.abs(ring[0][0]-start[0])<1e-8 && Math.abs(ring[0][1]-start[1])<1e-8)
    if (angles[1] === 450) assert.ok(ring.some(([lon,lat])=>Math.abs(lon)<0.02 && lat>0.9))
  }
  const full = airspaceGeometry(curvedSpace('ArcByCenterPoint','0 0','100','KM',[128,488]).space)
  assert.equal(full.status,'valid')
  assert.equal(containsAirspace(full.geometry,[0,0]),true)
})

test('circle centers resolve effective airport and Navaid references, with explicit failures for missing data', () => {
  for (const type of ['AirportHeliport','Navaid']) {
    const target=object('center',type,'25 110')
    const { space,segment }=curvedSpace()
    segment.children[0]=node('pointProperty',[],'',{'{http://www.w3.org/1999/xlink}href':'urn:uuid:center'},G)
    assert.equal(airspaceGeometry(space,{center:target}).status,'valid')
    assert.match(airspaceGeometry(space,{}).reason,/圆心引用目标/)
    target.active=false
    assert.equal(airspaceGeometry(space,{center:target}).status,'invalid')
    target.active=true; target.properties.children=[]
    assert.match(airspaceGeometry(space,{center:target}).reason,/位置不可用/)
  }
  for (const [radius,uom] of [['-1','KM'],['NaN','KM'],['1','UNKNOWN']]) assert.equal(airspaceGeometry(curvedSpace('CircleByCenterPoint','0 0',radius,uom).space).status,'invalid')
  assert.equal(airspaceGeometry(curvedSpace('CircleByCenterPoint','91 0').space).status,'invalid')
  for (const angles of [[0,0],[0,361]]) assert.equal(airspaceGeometry(curvedSpace('ArcByCenterPoint','0 0','100','KM',angles).space).status,'invalid')
})


function annotatedSpace(text) {
  const space = spaceObject(), surface = airspaceVolumes(space)[0].children[0].children[0]
  const ring = surface.children[0].children[0].children[0].children[0]
  const note = node('Note', [node('propertyName', [], 'arc'), node('translatedNote', [node('LinguisticNote', [node('note', [], text, { lang: 'eng' })])])])
  const line = coords => node('segments', [node('GeodesicString', [node('posList', [], coords, {}, G)], '', {}, G)], '', {}, G)
  ring.children = [
    node('curveMember', [node('Curve', [line('0.9043687229127633 0'), node('annotation', [note])])], '', {}, G),
    node('curveMember', [node('Curve', [line('0 0.8983152841195214 0.9043687229127633 0')])], '', {}, G),
  ]
  return { space, note }
}

test('English arc annotations determine clockwise and anticlockwise geometry, preserving XML joints', () => {
  for (const direction of ['a clockwised','an anticlockwised']) {
    const { space } = annotatedSpace(`${direction} arc with radius of 100km centered at 0 0`)
    const result = airspaceGeometry(space)
    assert.equal(result.status, 'valid', result.reason)
    const ring = result.geometry.coordinates[0]
    assert.deepEqual(ring[0], [0,0.9043687229127633])
    assert.deepEqual(ring[0], ring.at(-1))
    assert.ok(ring.some(p => p[0] === 0.8983152841195214 && p[1] === 0))
    assert.equal(result.warnings.length,1)
    assert.equal(containsAirspace(result.geometry,[0,0]), direction.startsWith('an'))
    assert.equal(containsAirspace(result.geometry,[0.5,0.5]), !direction.startsWith('an'))
  }
})

test('malformed, ambiguous and inconsistent arc annotations fail without inventing a boundary', () => {
  for (const text of [
    'an unknown arc centered somewhere',
    'a clockwised arc with radius of 100km centered at 91 0',
    'a clockwised arc with radius of -100km centered at 0 0',
    'a clockwised arc with radius of 10km centered at 0 0',
  ]) assert.equal(airspaceGeometry(annotatedSpace(text).space).status,'invalid',text)
  const { space,note } = annotatedSpace('a clockwised arc with radius of 100km centered at 0 0')
  const curve = airspaceVolumes(space)[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0]
  curve.children.push(node('annotation',[structuredClone(note)]))
  assert.match(airspaceGeometry(space).reason,/圆弧备注不唯一/)
  note.children[0].text = 'border'
  curve.children.pop()
  assert.equal(airspaceGeometry(space).status,'invalid')
})


test('structured arc gaps retain both endpoints and close the ring with explicit straight connectors', () => {
  const { space,segments }=curvedSpace('ArcByCenterPoint','0 0','100','KM',[0,90])
  const end=[0.8993152841195214,0], start=[0,0.9053687229127633]
  segments.children.push(node('GeodesicString',[node('posList',[],`${end[1]} ${end[0]} ${start[1]} ${start[0]}`,{},G)],'',{},G))
  const result=airspaceGeometry(space)
  assert.equal(result.status,'valid',result.reason)
  const ring=result.geometry.coordinates[0]
  assert.deepEqual(ring[0],ring.at(-1))
  const endpoint=ring.findIndex(p=>p[0]===end[0] && p[1]===end[1])
  assert.ok(endpoint>0)
  assert.ok(Math.abs(ring[endpoint-1][0]-0.8983152841195214)<1e-8)
  assert.deepEqual(ring.at(-2),start)
  assert.equal(result.warnings.length,2)
  assert.ok(result.warnings.every(w=>w.includes('按 XML 顺序直线连接')))
})


test('external border references complete 45 airspaces and leave 17 explicitly simplified outlines', () => {
  const base = new URL('../public/data/airac-index/', import.meta.url)
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', base)))
  const objects = JSON.parse(fs.readFileSync(new URL(manifest.objectsFile, base)))
  const relations = JSON.parse(fs.readFileSync(new URL(manifest.relationsFile, base)))
  const borders = JSON.parse(fs.readFileSync(new URL('../public/data/airac-boundaries.json', import.meta.url)))
  const original = buildMapData(objects,relations)
  const data = buildMapData(objects,relations,borders)
  const restored = data.collections.Airspace.features.filter(f=>original.features.get(f.properties.id).properties.incompleteBoundary && !f.properties.incompleteBoundary)
  assert.equal(restored.length,45)
  assert.equal(data.diagnostics.counts.Airspace.drawn,734)
  assert.equal(data.diagnostics.counts.Airspace.invalid,0)
  assert.equal(data.diagnostics.counts.Airspace.missing,2)
  for (const feature of restored) {
    assert.ok(feature.properties.geometryWarnings.some(w=>w.includes('外部边界近似补全')))
    const ring=feature.geometry.coordinates[0]
    assert.deepEqual(ring[0],ring.at(-1))
    const lists=[]
    const visit=n=>{if(n.namespace===G && n.name==='posList')lists.push(n);n.children.forEach(visit)}
    visit(objects[feature.properties.id].properties)
    for(const list of lists){
      const nums=list.text.trim().split(/\s+/).map(Number)
      for(let i=0;i<nums.length;i+=2)assert.ok(ring.some(p=>p[0]===nums[i+1] && p[1]===nums[i]),'original XML vertices remain')
    }
  }
  for(const r of Object.values(borders.connections)){
    assert.deepEqual(r.coordinates[0],r.start)
    assert.deepEqual(r.coordinates.at(-1),r.end)
    assert.ok(r.endpointOffsetsM.every(value=>value<=10000))
    if(r.kind==='Hong Kong Boundaries')assert.ok(Math.max(...r.coordinates.map(p=>p[1]))>22.56,'reference follows the northern exterior, not internal district edges')
  }
  const beijing=Object.values(objects).find(o=>o.fields.designator==='ZBAACTA')
  const altered=structuredClone(borders)
  const entry=Object.values(altered.connections).find(r=>r.objectId===beijing.id)
  entry.start=[0,0]
  assert.match(airspaceGeometry(beijing,objects,altered).reason,/与当前 XML 对象或端点不一致/)
  const guangzhou=Object.values(objects).find(o=>o.fields.designator==='ZGZU')
  const simplified=data.collections.Airspace.features.filter(f=>f.properties.incompleteBoundary)
  assert.equal(simplified.length,17)
  for(const feature of simplified){
    const ring=feature.geometry.coordinates[0]
    assert.deepEqual(ring[0],ring.at(-1))
    assert.ok(feature.properties.geometryWarnings.some(w=>w.startsWith('边界不完整')))
    for(const record of borders.unmatched.filter(r=>r.objectId===feature.properties.id)){
      const i=ring.findIndex(p=>p[0]===record.start[0] && p[1]===record.start[1])
      assert.ok(i>=0)
      assert.deepEqual(ring[i+1],record.end,'unmatched gap is one direct edge')
    }
  }
  assert.equal(data.features.get(guangzhou.id).properties.incompleteBoundary,true)
  assert.ok(data.features.get(guangzhou.id).properties.geometryWarnings.some(w=>w.includes('端点距参考边界过远')))
})
