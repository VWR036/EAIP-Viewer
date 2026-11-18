import { label } from './airac.js'

const A = 'http://www.aixm.aero/schema/5.1.1'
const G = 'http://www.opengis.net/gml/3.2'
const NIL = '{http://www.w3.org/2001/XMLSchema-instance}nil'
export const mapTypes = ['AirportHeliport', 'DesignatedPoint', 'Navaid', 'Route', 'Airspace']
export const airspaceTypes = { FIR: '飞行情报区 FIR', CTA: '管制区 CTA', TMA: '终端管制区 TMA', AR: '区域扇区 AR', AP: '进近扇区 AP', SECTOR: '其他扇区', R: '限制区 R', D: '危险区 D', P: '禁区 P', ADIZ: 'ADIZ' }
export function airspaceType(object) {
  if (object.fields.type === 'SECTOR') {
    const match = object.fields.designator?.match(/(?:AR|AP)\d+[A-Z]*$/)
    if (match) return match[0].slice(0, 2)
  }
  return object.fields.type
}
const paths = {
  AirportHeliport: ['ARP', 'ElevatedPoint'],
  DesignatedPoint: ['location', 'Point'],
  Navaid: ['location', 'ElevatedPoint'],
}
const nil = node => ['true', '1'].includes(node.attributes[NIL])
const children = (node, name, namespace = A) => node.children.filter(n => n.name === name && n.namespace === namespace)
function one(node, name, namespace = A) {
  const nodes = children(node, name, namespace)
  if (nodes.length !== 1) throw new Error(`${name} 节点数量 ${nodes.length}，预期 1`)
  if (nil(nodes[0])) throw new Error(`${name} 为 nil · ${nodes[0].attributes.nilReason}`)
  return nodes[0]
}
export function airspaceVolumes(object) {
  return children(object.properties, 'geometryComponent').map(n => one(one(one(n, 'AirspaceGeometryComponent'), 'theAirspaceVolume'), 'AirspaceVolume'))
}
export function airspaceGeometry(object) {
  if (object.properties.namespace !== A || object.properties.name !== 'AirspaceTimeSlice') return { status: 'invalid', reason: '不支持的空域时间片结构' }
  if (!children(object.properties, 'geometryComponent').length) return { status: 'missing', reason: '缺少 geometryComponent' }
  try {
    const polygons = airspaceVolumes(object).map(volume => {
      const surface = one(one(volume, 'horizontalProjection'), 'ElevatedSurface')
      if (surface.attributes.srsName !== 'urn:ogc:def:crs:EPSG::4326' || (surface.attributes.srsDimension && surface.attributes.srsDimension !== '2')) throw new Error('空域边界 CRS 或维度不支持')
      const patch = one(one(surface, 'patches', G), 'PolygonPatch', G)
      if (patch.children.some(n => !['exterior', 'interior'].includes(n.name) || n.namespace !== G)) throw new Error('不支持的 PolygonPatch 结构')
      return [one(patch, 'exterior', G), ...children(patch, 'interior', G)].map(boundary => {
        const ring = one(boundary, 'Ring', G), coordinates = []
        if (!ring.children.length || ring.children.some(n => n.name !== 'curveMember' || n.namespace !== G)) throw new Error('不支持的空域 Ring 结构')
        for (const member of ring.children) {
          const segments = one(one(member, 'Curve'), 'segments', G)
          if (!segments.children.length) throw new Error('空域边界 segments 为空')
          for (const segment of segments.children) {
            if (segment.name !== 'GeodesicString' || segment.namespace !== G) throw new Error(`尚不支持空域曲线 ${segment.name}，未绘制此空域`)
            const list = one(segment, 'posList', G)
            for (const n of [segments, segment, list]) {
              if ((n.attributes.srsName && n.attributes.srsName !== surface.attributes.srsName) || (n.attributes.srsDimension && n.attributes.srsDimension !== '2')) throw new Error('空域坐标 CRS 或维度不一致')
            }
            const parts = list.text.trim().split(/\s+/)
            if (list.children.length || parts.length < 4 || parts.length % 2 || !parts.every(v => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v))) throw new Error('空域 posList 格式错误')
            const points = []
            for (let i = 0; i < parts.length; i += 2) {
              const lat = Number(parts[i]), lon = Number(parts[i + 1])
              if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('空域坐标越界或不是有限数值')
              points.push([lon, lat])
            }
            if (coordinates.length && coordinates.at(-1).some((v, i) => v !== points[0][i])) throw new Error('空域边界曲线不连续')
            coordinates.push(...(coordinates.length ? points.slice(1) : points))
          }
        }
        if (coordinates.length < 4 || coordinates[0].some((v, i) => v !== coordinates.at(-1)[i])) throw new Error('空域边界未闭合或顶点不足')
        return coordinates
      })
    })
    return { status: 'valid', geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons } }
  } catch (error) { return { status: 'invalid', reason: error.message } }
}
export function containsAirspace(geometry, point) {
  const inRing = ring => {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, y] = ring[i], [xj, yj] = ring[j]
      if ((y > point[1]) !== (yj > point[1]) && point[0] < (xj - x) * (point[1] - y) / (yj - y) + x) inside = !inside
    }
    return inside
  }
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  return polygons.some(rings => inRing(rings[0]) && !rings.slice(1).some(inRing))
}

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

export function buildAirspaceServices(objects, relations) {
  const services = new Map(), airspaces = new Map()
  for (const o of Object.values(objects)) {
    if (!o.active) continue
    if (o.type === 'Airspace') airspaces.set(o.id, new Set())
    if (o.type === 'AirTrafficControlService') services.set(o.id, { units: new Set(), channels: new Set() })
  }
  const targetTypes = { clientAirspace: 'Airspace', serviceProvider: 'Unit', radioCommunication: 'RadioCommunicationChannel' }
  for (const r of relations.references) {
    if (!r.active || !services.has(r.sourceId) || !targetTypes[r.field]) continue
    const target = objects[r.targetId]
    if (target?.active !== true || target.type !== targetTypes[r.field]) throw new Error(`空管服务引用错误：${r.sourceId} · ${r.field} → ${r.targetId}`)
    if (r.field === 'clientAirspace') airspaces.get(target.id).add(r.sourceId)
    else services.get(r.sourceId)[r.field === 'serviceProvider' ? 'units' : 'channels'].add(target.id)
  }
  const summaries = new Map([...services].map(([id, refs]) => {
    const service = objects[id]
    const callsigns = children(service.properties, 'call-sign').flatMap(n => children(n, 'CallsignDetail')).map(n => ({
      callSign: propertyText({ properties: n }, 'callSign'), language: propertyText({ properties: n }, 'language'),
    }))
    const channels = [...refs.channels].map(channelId => {
      const channel = objects[channelId]
      return { id: channelId, rank: propertyText(channel, 'rank'), transmission: propertyText(channel, 'frequencyTransmission'), reception: propertyText(channel, 'frequencyReception') }
    }).sort((a, b) => (a.rank === 'PRIMARY' ? 0 : a.rank === 'ALTERNATE' ? 1 : 2) - (b.rank === 'PRIMARY' ? 0 : b.rank === 'ALTERNATE' ? 1 : 2))
    return [id, { id, unitIds: [...refs.units], callsigns, callsignStatus: callsigns.length ? '' : propertyText(service, 'call-sign'), channels }]
  }))
  return new Map([...airspaces].map(([id, ids]) => [id, [...ids].map(serviceId => summaries.get(serviceId))]))
}

export function buildMapData(objects, relations) {
  const collections = Object.fromEntries([...mapTypes.slice(0, 3), 'RouteSegment', 'Airspace'].map(type => [type, { type: 'FeatureCollection', features: [] }]))
  const positions = new Map(), features = new Map(), segments = new Map(), routes = new Map(), equipment = new Map()
  const diagnostics = { missing: [], invalid: [], segments: [], counts: {} }
  const active = Object.values(objects).filter(o => o.active === true)
  for (const o of active) {
    if (o.type === 'Route') routes.set(o.id, [])
    if (o.type === 'RouteSegment') segments.set(o.id, { start: [], end: [], route: [], errors: [] })
    if (o.type === 'Navaid') equipment.set(o.id, [])
    if (o.type === 'Airspace') {
      const result = airspaceGeometry(o)
      if (result.status !== 'valid') diagnostics[result.status].push({ id: o.id, type: o.type, reason: result.reason })
      else {
        const feature = { type: 'Feature', geometry: result.geometry, properties: { id: o.id, type: o.type, airspaceType: airspaceType(o), label: label(o) } }
        collections.Airspace.features.push(feature)
        features.set(o.id, feature)
      }
    }
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
  for (const type of [...mapTypes.slice(0, 3), 'RouteSegment', 'Airspace']) {
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
  return { collections, positions, features, routes, equipment, diagnostics, search, reasons, airspaceServices: buildAirspaceServices(objects, relations) }
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
