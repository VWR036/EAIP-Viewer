import { label } from './airac.js'

const A = 'http://www.aixm.aero/schema/5.1.1'
const G = 'http://www.opengis.net/gml/3.2'
const NIL = '{http://www.w3.org/2001/XMLSchema-instance}nil'
export const mapTypes = ['AirportHeliport', 'DesignatedPoint', 'Navaid', 'Route']
const paths = {
  AirportHeliport: ['ARP', 'ElevatedPoint'],
  DesignatedPoint: ['location', 'Point'],
  Navaid: ['location', 'ElevatedPoint'],
}
const nil = node => ['true', '1'].includes(node.attributes[NIL])

// Only these semantic paths and this CRS have been confirmed in the dataset.
export function position(object) {
  const missing = reason => ({ status: 'missing', reason })
  const invalid = reason => ({ status: 'invalid', reason })
  let node = object.properties
  if (node.namespace !== A || node.name !== `${object.type}TimeSlice`) return invalid('不支持的时间片结构或命名空间')
  for (const name of [...paths[object.type], 'pos']) {
    if (nil(node)) return missing(`nil · ${node.attributes.nilReason || '未提供 nilReason'}`)
    const children = node.children.filter(child => child.name === name)
    if (!children.length) {
      if (node.children.some(child => ['Point', 'ElevatedPoint', 'pos', 'posList', 'coordinates'].includes(child.name)) || (name !== 'pos' && node.children.length && node !== object.properties)) return invalid(`不支持的几何结构，预期 ${name}`)
      return missing(`缺少 ${name}`)
    }
    if (children.length !== 1) return invalid(`${name} 存在多个节点，位置有歧义`)
    const child = children[0]
    if (child.namespace !== (name === 'pos' ? G : A)) return invalid(`${name} 命名空间不支持：${child.namespace}`)
    if (name === 'pos') {
      if (nil(child) || !child.text.trim()) return missing(nil(child) ? `pos 为 nil · ${child.attributes.nilReason || '未提供 nilReason'}` : 'pos 为空')
      if (node.attributes.srsName !== 'urn:ogc:def:crs:EPSG::4326') return invalid(`未知或缺少 CRS：${node.attributes.srsName || '未提供 srsName'}`)
      if ((node.attributes.srsDimension && node.attributes.srsDimension !== '2') || (child.attributes.srsDimension && child.attributes.srsDimension !== '2') || (child.attributes.srsName && child.attributes.srsName !== node.attributes.srsName)) return invalid('坐标维度或 CRS 声明不一致')
      const parts = child.text.trim().split(/\s+/)
      const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
      if (child.children.length || parts.length !== 2 || !parts.every(value => number.test(value))) return invalid(`pos 格式错误：${child.text}`)
      const [lat, lon] = parts.map(Number)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return invalid('坐标不是有限数值')
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return invalid(`坐标越界：${lat}, ${lon}`)
      return { status: 'valid', coordinates: [lon, lat] }
    }
    node = child
  }
}

export function propertyText(object, key) {
  const nodes = object.properties.children.filter(n => n.name === key && n.namespace === A)
  if (!nodes.length) return '字段未提供'
  return nodes.map(n => nil(n) ? `nil · ${n.attributes.nilReason || '未提供 nilReason'}` : `${n.text || '空字符串'}${n.attributes.uom ? ` ${n.attributes.uom}` : ''}`).join('；')
}

export function buildMapData(objects, relations) {
  const collections = Object.fromEntries([...mapTypes.slice(0, 3), 'RouteSegment'].map(type => [type, { type: 'FeatureCollection', features: [] }]))
  const positions = new Map(), features = new Map(), segments = new Map(), routes = new Map(), equipment = new Map()
  const diagnostics = { missing: [], invalid: [], segments: [], counts: {} }
  const active = Object.values(objects).filter(o => o.active === true)
  for (const o of active) {
    if (o.type === 'Route') routes.set(o.id, [])
    if (o.type === 'RouteSegment') segments.set(o.id, { start: [], end: [], route: [], errors: [] })
    if (o.type === 'Navaid') equipment.set(o.id, [])
    if (!paths[o.type]) continue
    const result = position(o)
    positions.set(o.id, result)
    if (result.status !== 'valid') {
      diagnostics[result.status].push({ id: o.id, type: o.type, reason: result.reason })
      continue
    }
    const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: result.coordinates }, properties: { id: o.id, type: o.type, label: label(o) } }
    collections[o.type].features.push(feature)
    features.set(o.id, feature)
  }
  const endpointTypes = { pointChoice_fixDesignatedPoint: 'DesignatedPoint', pointChoice_navaidSystem: 'Navaid' }
  const deviceTypes = ['VOR', 'DME', 'NDB', 'Localizer', 'Glidepath', 'MarkerBeacon']
  // One pass over effective references; never use the airport aggregation as a network.
  for (const r of relations.references) {
    if (r.active !== true) continue
    const source = objects[r.sourceId], target = objects[r.targetId]
    if (source?.active !== true) continue
    const segment = segments.get(source.id)
    if (segment && (endpointTypes[r.field] || r.field === 'routeFormed')) {
      const expected = endpointTypes[r.field] || 'Route'
      if (target?.active !== true || target.type !== expected) {
        segment.errors.push(`引用目标缺失、无效或类型错误：${r.field} → ${r.targetId}`)
      } else if (r.field === 'routeFormed') {
        segment.route.push(target.id)
      } else if (r.role === 'start' || r.role === 'end') {
        segment[r.role].push(target.id)
      } else {
        segment.errors.push(`端点角色不明确：${r.field} → ${r.targetId}`)
      }
    }
    if (source.type === 'Navaid' && r.field === 'theNavaidEquipment') {
      if (target?.active === true && deviceTypes.includes(target.type)) equipment.get(source.id).push(target.id)
      else diagnostics.invalid.push({ id: source.id, type: source.type, reason: `导航设备引用错误：${r.targetId}` })
    }
  }
  for (const [id, refs] of segments) {
    const errors = [...refs.errors]
    for (const key of ['start', 'end', 'route']) if (refs[key].length !== 1) errors.push(`${{ start: '起点', end: '终点', route: '所属航路' }[key]}引用数量 ${refs[key].length}，预期 1`)
    for (const key of ['start', 'end']) {
      if (refs[key].length !== 1) continue
      const result = positions.get(refs[key][0])
      if (result?.status !== 'valid') errors.push(`${key === 'start' ? '起点' : '终点'} ${refs[key][0]}：${result?.reason || '无可用位置'}`)
    }
    if (errors.length) {
      diagnostics.segments.push({ id, type: 'RouteSegment', reason: errors.join('；') })
      continue
    }
    const [startId] = refs.start, [endId] = refs.end, [routeId] = refs.route
    const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [positions.get(startId).coordinates, positions.get(endId).coordinates] }, properties: { id, type: 'RouteSegment', routeId, startId, endId, label: label(objects[routeId]) } }
    collections.RouteSegment.features.push(feature)
    features.set(id, feature)
    routes.get(routeId).push(feature)
  }
  for (const [id, ids] of equipment) equipment.set(id, [...new Set(ids)])
  for (const type of [...mapTypes.slice(0, 3), 'RouteSegment']) {
    diagnostics.counts[type] = { drawn: collections[type].features.length, missing: diagnostics.missing.filter(d => d.type === type).length, invalid: diagnostics.invalid.filter(d => d.type === type).length, excluded: type === 'RouteSegment' ? diagnostics.segments.length : 0 }
  }
  const reasons = new Map([...diagnostics.missing, ...diagnostics.invalid, ...diagnostics.segments].map(d => [d.id, d.reason]))
  const search = active.filter(o => mapTypes.includes(o.type)).map(o => ({
    id: o.id, type: o.type, label: label(o),
    code: o.type === 'Route' ? [o.fields.designatorPrefix, o.fields.designatorSecondLetter, o.fields.designatorNumber, o.fields.designatorSuffix].filter(Boolean).join('') : o.fields.locationIndicatorICAO || o.fields.designator || '',
    name: o.name || o.fields.name || '',
    text: [label(o), o.fields.designatorIATA, o.fields.name].filter(Boolean).join(' ').toLowerCase(),
    reason: o.type === 'Route' ? (routes.get(o.id).length ? '' : '此航路没有可绘制航段，请查看航段诊断') : reasons.get(o.id) || '',
  }))
  return { collections, positions, features, routes, equipment, diagnostics, search, reasons }
}

export function searchMap(data, query, limit = 50) {
  const q = query.trim().toLowerCase()
  if (!q) return { results: [], total: 0 }
  const results = []
  let total = 0
  for (const entry of data.search) {
    if (!entry.text.includes(q)) continue
    total++
    if (results.length < limit) results.push(entry)
  }
  return { results, total }
}
