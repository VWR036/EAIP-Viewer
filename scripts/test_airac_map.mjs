import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildMapData, position, searchMap } from '../src/airac-map.js'

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
  assert.equal(data.diagnostics.invalid.length, 0)
  assert.equal(data.diagnostics.segments.length, 0)
  for (const type of ['AirportHeliport','DesignatedPoint']) assert.equal(data.collections[type].features.length, manifest.counts[type])
  assert.equal(data.collections.Navaid.features.length + data.diagnostics.counts.Navaid.missing, manifest.counts.Navaid)
  assert.equal(data.collections.RouteSegment.features.length, manifest.counts.RouteSegment)
  for (const f of data.collections.RouteSegment.features) {
    for (const [index,role] of ['start','end'].entries()) {
      const r = relations.references.find(r => r.active && r.sourceId === f.properties.id && r.role === role && ['pointChoice_fixDesignatedPoint','pointChoice_navaidSystem'].includes(r.field))
      assert.equal(f.properties[`${role}Id`], r.targetId)
      assert.deepEqual(f.geometry.coordinates[index], position(objects[r.targetId]).coordinates)
    }
  }
  console.log('Snapshot', manifest.generation, JSON.stringify(data.diagnostics.counts), 'routes with geometry', [...data.routes.values()].filter(v=>v.length).length)
})
