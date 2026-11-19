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
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
function geometryNumber(node) {
  if (nil(node) || node.children.length || !numeric.test(node.text.trim()) || !Number.isFinite(Number(node.text))) throw new Error(`${node.name} 不是有效数值`)
  return Number(node.text)
}
// Vincenty's direct solution on WGS84; bearings follow EPSG:4326 (north, east).
function geodesicDestination([lon, lat], bearing, distance) {
  const rad = Math.PI / 180, a = 6378137, f = 1 / 298.257223563, b = a * (1 - f)
  const alpha = bearing * rad, u = Math.atan((1 - f) * Math.tan(lat * rad))
  const sinU = Math.sin(u), cosU = Math.cos(u), sinAlpha = cosU * Math.sin(alpha), cosSqAlpha = 1 - sinAlpha ** 2
  const sigma1 = Math.atan2(Math.tan(u), Math.cos(alpha)), uSq = cosSqAlpha * (a * a - b * b) / (b * b)
  const ca = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
  const cb = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
  const base = distance / (b * ca)
  let sigma = base, converged = false
  for (let i = 0; i < 32; i++) {
    const c = Math.cos(2 * sigma1 + sigma), s = Math.sin(sigma)
    const next = base + cb * s * (c + cb / 4 * (Math.cos(sigma) * (-1 + 2 * c * c) - cb / 6 * c * (-3 + 4 * s * s) * (-3 + 4 * c * c)))
    if (Math.abs(next - sigma) < 1e-12) { sigma = next; converged = true; break }
    sigma = next
  }
  if (!converged) throw new Error('圆弧 WGS84 坐标计算未收敛')
  const sinSigma = Math.sin(sigma), cosSigma = Math.cos(sigma), c = Math.cos(2 * sigma1 + sigma)
  const t = sinU * sinSigma - cosU * cosSigma * Math.cos(alpha)
  const phi = Math.atan2(sinU * cosSigma + cosU * sinSigma * Math.cos(alpha), (1 - f) * Math.hypot(sinAlpha, t))
  const lambda = Math.atan2(sinSigma * Math.sin(alpha), cosU * cosSigma - sinU * sinSigma * Math.cos(alpha))
  const cc = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha))
  const delta = lambda - (1 - cc) * f * sinAlpha * (sigma + cc * sinSigma * (c + cc * cosSigma * (-1 + 2 * c * c)))
  return [((lon + delta / rad + 540) % 360) - 180, phi / rad]
}
function geodesicInverse([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180, a = 6378137, f = 1 / 298.257223563, b = a * (1 - f)
  const u1 = Math.atan((1 - f) * Math.tan(lat1 * rad)), u2 = Math.atan((1 - f) * Math.tan(lat2 * rad))
  const s1 = Math.sin(u1), c1 = Math.cos(u1), s2 = Math.sin(u2), c2 = Math.cos(u2), delta = (lon2 - lon1) * rad
  let lambda = delta, sigma, sinSigma, cosSigma, cosSqAlpha, cos2SigmaM, converged = false
  for (let i = 0; i < 32; i++) {
    sinSigma = Math.hypot(c2 * Math.sin(lambda), c1 * s2 - s1 * c2 * Math.cos(lambda))
    if (sinSigma === 0) throw new Error('备注圆弧端点不能与圆心重合')
    cosSigma = s1 * s2 + c1 * c2 * Math.cos(lambda)
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = c1 * c2 * Math.sin(lambda) / sinSigma
    cosSqAlpha = 1 - sinAlpha ** 2
    cos2SigmaM = cosSqAlpha ? cosSigma - 2 * s1 * s2 / cosSqAlpha : 0
    const cc = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha))
    const next = delta + (1 - cc) * f * sinAlpha * (sigma + cc * sinSigma * (cos2SigmaM + cc * cosSigma * (-1 + 2 * cos2SigmaM ** 2)))
    if (Math.abs(next - lambda) < 1e-12) { converged = true; break }
    lambda = next
  }
  if (!converged) throw new Error('备注圆弧端点 WGS84 反算未收敛')
  const uSq = cosSqAlpha * (a * a - b * b) / (b * b)
  const ca = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
  const cb = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
  const correction = cb * sinSigma * (cos2SigmaM + cb / 4 * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - cb / 6 * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)))
  return { distance: b * ca * (sigma - correction), bearing: (Math.atan2(c2 * Math.sin(lambda), c1 * s2 - s1 * c2 * Math.cos(lambda)) / rad + 360) % 360 }
}
function sampleArc(center, radius, start, sweep) {
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('圆弧半径必须为正有限数值')
  if (!Number.isFinite(sweep) || sweep === 0 || Math.abs(sweep) > 360) throw new Error('圆弧角度跨度必须大于 0 且不超过 360 度')
  // At most 2 degrees per chord, tightening to a 5 m sagitta for large radii.
  const step = Math.min(2, 2 * Math.acos(Math.max(-1, 1 - 5 / radius)) * 180 / Math.PI)
  const count = Math.ceil(Math.abs(sweep) / step)
  const points = Array.from({ length: count + 1 }, (_, i) => geodesicDestination(center, start + sweep * i / count, radius))
  if (Math.abs(sweep) === 360) points[points.length - 1] = [...points[0]]
  return points
}
function annotationArc(curve) {
  const notes = children(curve, 'annotation').flatMap(n => children(n, 'Note')).filter(n => children(n, 'propertyName').some(p => p.text === 'arc'))
  if (!notes.length) return null
  if (notes.length !== 1) throw new Error('同一 Curve 的圆弧备注不唯一')
  const texts = children(notes[0], 'translatedNote').flatMap(n => children(n, 'LinguisticNote')).flatMap(n => children(n, 'note')).filter(n => n.attributes.lang === 'eng')
  if (texts.length !== 1 || nil(texts[0])) throw new Error('圆弧英文备注缺失或不唯一')
  const number = numeric.source.slice(1, -1)
  const pattern = new RegExp(`^(?:a|an) ((?:anti)?clockwise(?:d)?) arc with radius of (${number})\\s*(km|m|nm) centered at (${number}) (${number})$`, 'i')
  const match = texts[0].text.trim().replace(/\s+/g, ' ').match(pattern)
  if (!match) throw new Error(`不支持的圆弧备注：${texts[0].text}`)
  const radius = Number(match[2]) * { km: 1000, m: 1, nm: 1852 }[match[3].toLowerCase()]
  const lat = Number(match[4]), lon = Number(match[5])
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('圆弧备注的半径或圆心无效')
  return { radius, center: [lon, lat], clockwise: !match[1].toLowerCase().startsWith('anti') }
}
function annotationBoundary(curve) {
  const notes = children(curve, 'annotation').flatMap(n => children(n, 'Note')).filter(n => children(n, 'propertyName').some(p => p.text === 'boundary'))
  if (!notes.length) return null
  const texts = notes.flatMap(n => children(n, 'translatedNote')).flatMap(n => children(n, 'LinguisticNote')).flatMap(n => children(n, 'note')).filter(n => n.attributes.lang === 'eng')
  if (notes.length !== 1 || texts.length !== 1 || nil(texts[0]) || !['National Boundaries', 'Hong Kong Boundaries'].includes(texts[0].text)) throw new Error('边界英文备注不支持或不唯一')
  return texts[0].text
}
function geodesicPoints(segment, surface, allowSingle) {
  if (segment.name !== 'GeodesicString' || segment.namespace !== G) throw new Error(`尚不支持空域曲线 ${segment.name}，未绘制此空域`)
  const list = one(segment, 'posList', G)
  for (const n of [segment, list]) {
    if ((n.attributes.srsName && n.attributes.srsName !== surface.attributes.srsName) || (n.attributes.srsDimension && n.attributes.srsDimension !== '2')) throw new Error('空域坐标 CRS 或维度不一致')
  }
  const parts = list.text.trim().split(/\s+/)
  if (list.children.length || parts.length < (allowSingle ? 2 : 4) || parts.length % 2 || !parts.every(v => numeric.test(v))) throw new Error('空域 posList 格式错误')
  const points = []
  for (let i = 0; i < parts.length; i += 2) {
    const lat = Number(parts[i]), lon = Number(parts[i + 1])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('空域坐标越界或不是有限数值')
    points.push([lon, lat])
  }
  return points
}
function circularBoundary(segment, surface, objects) {
  if (segment.attributes.numArc !== '1') throw new Error('圆形 / 圆弧 numArc 必须为 1')
  const centers = segment.children.filter(n => n.namespace === G && ['pos', 'pointProperty'].includes(n.name))
  if (centers.length !== 1) throw new Error('圆形 / 圆弧必须有唯一的 pos 或 pointProperty 圆心')
  const centerNode = centers[0]
  for (const n of [segment, centerNode]) {
    if ((n.attributes.srsName && n.attributes.srsName !== surface.attributes.srsName) || (n.attributes.srsDimension && n.attributes.srsDimension !== '2')) throw new Error('圆心 CRS 或维度不一致')
  }
  let center
  if (centerNode.name === 'pos') {
    const parts = centerNode.text.trim().split(/\s+/)
    if (nil(centerNode) || centerNode.children.length || parts.length !== 2 || !parts.every(v => numeric.test(v))) throw new Error('圆心 pos 格式错误')
    const [lat, lon] = parts.map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('圆心坐标越界或不是有限数值')
    center = [lon, lat]
  } else {
    const href = centerNode.attributes['{http://www.w3.org/1999/xlink}href']
    if (nil(centerNode) || !href?.startsWith('urn:uuid:')) throw new Error('圆心 pointProperty 引用无效')
    const target = objects[href.slice(9)]
    if (target?.active !== true || !paths[target.type]) throw new Error(`圆心引用目标缺失、无效或不支持：${href}`)
    const result = position(target)
    if (result.status !== 'valid') throw new Error(`圆心引用目标位置不可用：${href} · ${result.reason}`)
    center = result.coordinates
  }
  const radiusNode = one(segment, 'radius', G), units = { M: 1, KM: 1000, NM: 1852 }
  if (!Object.hasOwn(units, radiusNode.attributes.uom)) throw new Error(`不支持的圆弧半径单位：${radiusNode.attributes.uom}`)
  const radius = geometryNumber(radiusNode) * units[radiusNode.attributes.uom]
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('圆弧半径必须为正有限数值')
  const circle = segment.name === 'CircleByCenterPoint'
  const angle = name => {
    const n = one(segment, name, G)
    if (n.attributes.uom !== 'deg') throw new Error(`不支持的圆弧角度单位：${n.attributes.uom}`)
    return geometryNumber(n)
  }
  const start = circle ? 0 : angle('startAngle'), end = circle ? 360 : angle('endAngle'), sweep = end - start
  return sampleArc(center, radius, start, sweep)
}
export function airspaceGeometry(object, objects = {}, boundaryData = null) {
  if (object.properties.namespace !== A || object.properties.name !== 'AirspaceTimeSlice') return { status: 'invalid', reason: '不支持的空域时间片结构' }
  if (!children(object.properties, 'geometryComponent').length) return { status: 'missing', reason: '缺少 geometryComponent' }
  try {
    const warnings = []
    let incompleteBoundary = false
    const polygons = airspaceVolumes(object).map(volume => {
      const surface = one(one(volume, 'horizontalProjection'), 'ElevatedSurface')
      if (surface.attributes.srsName !== 'urn:ogc:def:crs:EPSG::4326' || (surface.attributes.srsDimension && surface.attributes.srsDimension !== '2')) throw new Error('空域边界 CRS 或维度不支持')
      const patch = one(one(surface, 'patches', G), 'PolygonPatch', G)
      if (patch.children.some(n => !['exterior', 'interior'].includes(n.name) || n.namespace !== G)) throw new Error('不支持的 PolygonPatch 结构')
      return [one(patch, 'exterior', G), ...children(patch, 'interior', G)].map(boundary => {
        const ring = one(boundary, 'Ring', G), coordinates = []
        let curved = false, previousArc = false, firstArc = false
        const connectArc = (start, end) => warnings.push(`圆弧与相邻边界按 XML 顺序直线连接，连接段长度 ${geodesicInverse(start, end).distance.toFixed(1)} M`)
        const appendPoints = (points, arc) => {
          if (!coordinates.length) { firstArc = arc; coordinates.push(...points) }
          else {
            const different = coordinates.at(-1).some((v, i) => curved || arc ? Math.abs(v - points[0][i]) > 1e-8 : v !== points[0][i])
            if (different) {
              if (!arc && !previousArc) throw new Error('空域边界曲线不连续')
              connectArc(coordinates.at(-1), points[0])
              coordinates.push(...points)
            } else coordinates.push(...points.slice(1))
          }
          previousArc = arc
        }
        if (!ring.children.length || ring.children.some(n => n.name !== 'curveMember' || n.namespace !== G)) throw new Error('不支持的空域 Ring 结构')
        const curves = ring.children.map(member => one(member, 'Curve')), arcs = curves.map(annotationArc), boundaries = curves.map(annotationBoundary)
        for (const [index, curve] of curves.entries()) {
          const segments = one(curve, 'segments', G)
          if (!segments.children.length) throw new Error('空域边界 segments 为空')
          if ((segments.attributes.srsName && segments.attributes.srsName !== surface.attributes.srsName) || (segments.attributes.srsDimension && segments.attributes.srsDimension !== '2')) throw new Error('空域坐标 CRS 或维度不一致')
          for (const [segmentIndex, segment] of segments.children.entries()) {
            if (segment.namespace === G && ['CircleByCenterPoint', 'ArcByCenterPoint'].includes(segment.name)) {
              const points = circularBoundary(segment, surface, objects)
              appendPoints(points, segment.name === 'ArcByCenterPoint')
              curved = true
              continue
            }
            const next = segments.children[segmentIndex + 1] || one(curves[(index + 1) % curves.length], 'segments', G).children[0]
            const nextArc = next?.namespace === G && next.name === 'ArcByCenterPoint'
            const previous = (index + curves.length - 1) % curves.length
            const points = geodesicPoints(segment, surface, Boolean(previousArc || nextArc || arcs[index] || arcs[previous] || boundaries[index] || boundaries[previous]))
            appendPoints(points, false)
          }
          const arc = arcs[index]
          if (arc) {
            const next = one(curves[(index + 1) % curves.length], 'segments', G).children[0]
            const start = coordinates.at(-1), end = geodesicPoints(next, surface, true)[0]
            const first = geodesicInverse(arc.center, start), last = geodesicInverse(arc.center, end)
            const error = Math.max(Math.abs(first.distance - arc.radius), Math.abs(last.distance - arc.radius))
            if (error > arc.radius * 0.01) throw new Error(`备注圆弧端点偏离半径超过 1%：${error.toFixed(1)} M`)
            const sweep = arc.clockwise ? (last.bearing - first.bearing + 360) % 360 : -((first.bearing - last.bearing + 360) % 360)
            const points = sampleArc(arc.center, arc.radius, first.bearing, sweep)
            points[0] = [...start]; points[points.length - 1] = [...end]
            coordinates.push(...points.slice(1))
            curved = true
            warnings.push(`按英文备注补全${arc.clockwise ? '顺时针' : '逆时针'}圆弧（半径 ${arc.radius / 1000} KM）；近似连接保留 XML 端点，最大半径偏差 ${error.toFixed(1)} M`)
          }
          const boundary = boundaries[index]
          if (boundary) {
            const curveId = curve.attributes[`{${G}}id`]
            const connection = boundaryData?.connections[curveId]
            const start = coordinates.at(-1), next = one(curves[(index + 1) % curves.length], 'segments', G).children[0]
            const end = geodesicPoints(next, surface, true)[0]
            if (!connection) {
              const record = boundaryData?.unmatched.find(r => r.curveId === curveId)
              coordinates.push([...end])
              incompleteBoundary = true
              warnings.push(`边界不完整：${boundary} 缺段已按 XML 顺序直线连接现有端点。${record ? record.reason : '尚无匹配的外部边界参考。'}`)
              continue
            }
            const points = connection.coordinates
            const same = (p, q) => p.length === 2 && p.every((v, i) => v === q[i])
            if (connection.objectId !== object.id || connection.kind !== boundary || !same(connection.start, start) || !same(connection.end, end)) throw new Error('外部边界连接与当前 XML 对象或端点不一致')
            if (!Array.isArray(points) || points.length < 3 || !points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90) || !same(points[0], start) || !same(points.at(-1), end)) throw new Error('外部边界连接坐标无效')
            const source = boundaryData.sources[boundary]
            if (!source?.name || !Array.isArray(connection.endpointOffsetsM) || connection.endpointOffsetsM.length !== 2 || connection.endpointOffsetsM.some(v => !Number.isFinite(v) || v < 0 || v > boundaryData.maxEndpointOffsetM)) throw new Error('外部边界来源或端点偏移无效')
            coordinates.push(...points.slice(1))
            warnings.push(`外部边界近似补全：${source.name}；XML 两端距参考线 ${connection.endpointOffsetsM.map(v => v.toFixed(0)).join(' / ')} M。仅作地图参考。`)
          }
        }
        if (coordinates.length < 4) throw new Error('空域边界未闭合或顶点不足')
        if (coordinates[0].some((v, i) => curved ? Math.abs(v - coordinates.at(-1)[i]) > 1e-8 : v !== coordinates.at(-1)[i])) {
          if (!firstArc && !previousArc) throw new Error('空域边界未闭合或顶点不足')
          connectArc(coordinates.at(-1), coordinates[0])
          coordinates.push([...coordinates[0]])
        }
        if (curved) coordinates[coordinates.length - 1] = [...coordinates[0]]
        return coordinates
      })
    })
    return { status: 'valid', geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons }, warnings, incompleteBoundary }
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

export function routeDirection(object) {
  if (!children(object.properties, 'availability').length) return { status: 'missing', reason: '缺少航段可用方向 availability' }
  try {
    const direction = one(one(one(object.properties, 'availability'), 'RouteAvailability'), 'direction').text
    if (!['FORWARD', 'BACKWARD', 'BOTH'].includes(direction)) throw new Error(`不支持的航段可用方向：${direction}`)
    return { status: 'valid', direction }
  } catch (error) { return { status: 'invalid', reason: error.message } }
}

export function routeNavigationLabel(object) {
  const types = children(object.properties, 'navigationType').filter(n => !nil(n) && n.text)
  if (!types.length) return ''
  const navigation = types.map(n => n.text === 'OTHER:RNP' ? 'RNP' : n.text).join('；')
  return `${navigation} ${propertyText(object, 'requiredNavigationPerformance')}`
}

export function matchesRouteNavigation(feature, filter) {
  if (filter === 'ALL') return true
  if (filter === 'RNAV' || filter === 'RNP') return feature.properties.navigationLabel.startsWith(`${filter} `)
  return feature.properties.navigationLabel === filter
}

// Arrowheads in screen pixels keep their size when the map zoom changes.
export function routeArrowHeads(start, end, direction) {
  if (!['FORWARD', 'BACKWARD', 'BOTH'].includes(direction)) throw new Error(`不支持的航段可用方向：${direction}`)
  const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy)
  if (length < 30) return []
  const ux = dx / length, uy = dy / length
  const heads = direction === 'BOTH' ? [[0.35, -1], [0.65, 1]] : [[0.5, direction === 'FORWARD' ? 1 : -1]]
  return heads.map(([t, sign]) => {
    const x = start[0] + dx * t, y = start[1] + dy * t
    return [[x - sign * ux * 7 - uy * 4, y - sign * uy * 7 + ux * 4], [x, y], [x - sign * ux * 7 + uy * 4, y - sign * uy * 7 - ux * 4]]
  })
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

export function buildMapData(objects, relations, boundaryData = null) {
  if (boundaryData && (boundaryData.formatVersion !== 1 || !boundaryData.connections || !boundaryData.sources || !Array.isArray(boundaryData.unmatched) || !Number.isFinite(boundaryData.maxEndpointOffsetM))) throw new Error('外部边界数据结构或版本不正确')
  const collections = Object.fromEntries([...mapTypes.slice(0, 3), 'RouteSegment', 'Airspace'].map(type => [type, { type: 'FeatureCollection', features: [] }]))
  const positions = new Map(), features = new Map(), segments = new Map(), routes = new Map(), equipment = new Map()
  const diagnostics = { missing: [], invalid: [], segments: [], directions: [], approximations: [], counts: {} }
  const active = Object.values(objects).filter(o => o.active === true)
  for (const o of active) {
    if (o.type === 'Route') routes.set(o.id, [])
    if (o.type === 'RouteSegment') segments.set(o.id, { start: [], end: [], route: [], errors: [] })
    if (o.type === 'Navaid') equipment.set(o.id, [])
    if (o.type === 'Airspace') {
      const result = airspaceGeometry(o, objects, boundaryData)
      if (result.status !== 'valid') diagnostics[result.status].push({ id: o.id, type: o.type, reason: result.reason })
      else {
        const feature = { type: 'Feature', geometry: result.geometry, properties: { id: o.id, type: o.type, airspaceType: airspaceType(o), label: label(o), geometryWarnings: result.warnings, incompleteBoundary: result.incompleteBoundary } }
        for (const reason of result.warnings) diagnostics.approximations.push({ id: o.id, type: o.type, reason })
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
    const direction = routeDirection(objects[id])
    if (direction.status !== 'valid') diagnostics.directions.push({ id, type: 'RouteSegment', reason: direction.reason })
    const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [positions.get(startId).coordinates, positions.get(endId).coordinates] }, properties: { id, type: 'RouteSegment', routeId, startId, endId, direction: direction.direction, directionReason: direction.reason, navigationLabel: routeNavigationLabel(objects[id]), label: label(objects[routeId]) } }
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
