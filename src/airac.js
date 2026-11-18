import { shallowReactive, reactive } from 'vue'
import { loadJSON } from './store.js'

export const airac = shallowReactive({ status: 'idle', error: '', manifest: null, objects: {}, relations: null, selected: null })
export const airacUI = reactive({ search: '', expanded: ['airports'], selectedKeys: [], view: 'map' })
export const typeNames = { AirportHeliport: '机场', Airspace: '空域', Runway: '跑道', RunwayDirection: '跑道方向', RunwayCentrelinePoint: '跑道中线点', DesignatedPoint: '指定点', Navaid: '导航设施', VOR: 'VOR', DME: 'DME', NDB: 'NDB', Localizer: '航向台', Glidepath: '下滑台', MarkerBeacon: '指点标', Route: '航路', RouteSegment: '航段', AirTrafficControlService: '空中交通服务', RadioCommunicationChannel: '无线电通信频道', Unit: '单位' }
export const fieldNames = { length: '长度', magneticTrack: '磁航迹', reverseMagneticTrack: '反向磁航迹', designatorPrefix: '航路前缀', designatorSecondLetter: '航路字母', designatorNumber: '航路编号', name: '名称', designator: '标识', locationIndicatorICAO: 'ICAO', designatorIATA: 'IATA', type: '类型', fieldElevation: '机场标高', nominalLength: '标称长度', nominalWidth: '标称宽度', bearing: '方位', trueBearing: '真方位', magneticBearing: '磁方位', frequency: '频率', elevation: '标高', upperLimit: '上限', lowerLimit: '下限', upperLimitReference: '上限参考', lowerLimitReference: '下限参考', horizontalProjection: '水平边界', geometryComponent: '几何组成', annotation: '备注', note: '备注', linguisticNote: '语言备注', associatedAirportHeliport: '关联机场', servedAirport: '服务机场', airportHeliport: '关联机场', usedRunway: '使用跑道', onRunway: '所在跑道', theNavaidEquipment: '导航设备', routeFormed: '所属航路', pointChoice_fixDesignatedPoint: '指定点', pointChoice_navaidSystem: '导航设施端点', serviceProvider: '服务提供单位', radioCommunication: '通信频道', clientAirspace: '服务空域', pointProperty: '边界参考点', ARP: '机场基准点', pos: '坐标', interpretation: '时间片解释', sequenceNumber: '序号', correctionNumber: '修正号', validTime: '有效期' }
export function label(o) {
  const designator = o.type === 'Route' ? [o.fields.designatorPrefix, o.fields.designatorSecondLetter, o.fields.designatorNumber, o.fields.designatorSuffix].filter(Boolean).join('') : o.fields.locationIndicatorICAO || o.fields.designator
  return [designator, o.name].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ') || o.id
}
export const idsOf = type => Object.values(airac.objects).filter(o => o.active && o.type === type).map(o => o.id)
export const airportGroups = a => [['基本信息', [a.id]], ['跑道', a.runways], ['导航设施', a.navaids], ['关联指定点', a.points], ['关联航段', a.segments], ['关联航路', a.routes]]
export function selectNode(node) { airac.selected = node; airacUI.selectedKeys = node ? [node.key] : [] }
export function openObject(id) {
  const o = airac.objects[id]
  selectNode({ key: `public/${o.type}/${id}`, title: label(o), objectId: id, breadcrumb: ['公共总目录', typeNames[o.type], label(o)] })
}
function validate(manifest, objects, relations) {
  if (manifest.formatVersion !== 1 || !manifest.effectiveTime || manifest.validation?.status !== 'passed' || !manifest.counts || !manifest.diagnostics || !objects || Array.isArray(objects) || !Array.isArray(relations?.references) || !relations.airports) throw new Error('AIRAC 索引结构或版本不正确')
  function property(node) {
    if (!node || typeof node.name !== 'string' || typeof node.namespace !== 'string' || typeof node.text !== 'string' || !node.attributes || typeof node.attributes !== 'object' || !Array.isArray(node.children)) throw new Error('属性树结构错误')
    node.children.forEach(property)
  }
  if (Object.keys(manifest.counts).length !== Object.keys(typeNames).length) throw new Error('索引必须包含 18 类对象计数')
  const counts = {}
  for (const [id, o] of Object.entries(objects)) {
    if (o.id !== id || !typeNames[o.type] || typeof o.active !== 'boolean' || !o.fields || !o.properties?.children || typeof o.xml !== 'string' || !o.sourceFile) throw new Error(`对象结构错误：${id}`)
    property(o.properties)
    if (o.active) counts[o.type] = (counts[o.type] || 0) + 1
  }
  for (const [type, count] of Object.entries(manifest.counts)) if ((counts[type] || 0) !== count) throw new Error(`对象数量不一致：${type}`)
  for (const r of relations.references) if (!objects[r.sourceId] || !objects[r.targetId] || typeof r.path !== 'string' || typeof r.active !== 'boolean' || (r.active && (!objects[r.sourceId].active || !objects[r.targetId].active))) throw new Error(`关联结构错误：${r.sourceId} → ${r.targetId}`)
  for (const [id, a] of Object.entries(relations.airports)) {
    if (objects[id]?.type !== 'AirportHeliport' || !['runways', 'navaids', 'points', 'segments', 'routes'].every(k => Array.isArray(a[k]) && a[k].every(target => objects[target]?.active)) || !a.equipment || !a.directions || !a.centrelinePoints) throw new Error(`机场聚合结构错误：${id}`)
  }
}
export async function loadAirac() {
  if (airac.status === 'ready' || airac.status === 'loading') return
  airac.status = 'loading'; airac.error = ''
  try {
    const base = '/data/airac-index/'
    const manifest = await loadJSON(base + 'manifest.json')
    for (const f of [manifest.objectsFile, manifest.relationsFile]) if (typeof f !== 'string' || !/^[a-f0-9]{20}\/(objects|relations)\.json$/.test(f)) throw new Error('索引文件路径格式错误')
    const [objects, relations] = await Promise.all([loadJSON(base + manifest.objectsFile), loadJSON(base + manifest.relationsFile)])
    validate(manifest, objects, relations)
    airac.manifest = manifest; airac.objects = objects; airac.relations = relations; airac.status = 'ready'
  } catch (error) { airac.status = 'error'; airac.error = error.message }
}
