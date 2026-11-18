<template>
  <section class="airac-map">
    <Spin v-if="airac.status === 'loading'" class="airac-map-state" tip="正在读取并校验 AIRAC 索引…" />
    <Result v-else-if="airac.status === 'error'" status="error" title="AIRAC 索引加载失败" :sub-title="airac.error">
      <template #extra><Button @click="loadAirac">重试加载</Button></template>
    </Result>
    <Empty v-else-if="airac.status === 'idle'" description="尚未加载 AIRAC 数据" />
    <template v-else>
      <div class="airac-map-tools">
        <Input v-model:value="query" allow-clear placeholder="地图搜索 — 机场 / 指定点 / 导航设施 / 航路 / 空域及扇区" aria-label="地图搜索" />
        <Checkbox v-for="type in mapTypes" :key="type" v-model:checked="enabled[type]">
          <span class="airac-map-key" :style="{ background: colors[type] }" />{{ typeNames[type] }}
        </Checkbox>
        <Button @click="showDiagnostics = !showDiagnostics">地图诊断</Button>
      </div>
      <div v-if="enabled.Route && data" class="airac-map-tools">
        <span>航段导航要求：</span>
        <Select v-model:value="navigationFilter" class="airac-map-navigation-filter" :options="navigationOptions" aria-label="航段导航要求筛选" />
        <span class="airac-hint">显示 {{ filteredRouteCount }} / {{ data.collections.RouteSegment.features.length }} 个航段</span>
      </div>
      <div v-if="enabled.Airspace && data" class="airac-map-tools">
        <Checkbox v-for="(name,type) in airspaceTypes" :key="type" v-model:checked="spaceEnabled[type]">{{ name }}（{{ data.collections.Airspace.features.filter(f => f.properties.airspaceType === type).length }}）</Checkbox>
      </div>
      <Alert v-if="tileError" type="warning" show-icon message="底图瓦片加载失败；AIRAC 覆盖层仍可使用。" :description="`无法加载 ${tileHost} 的部分瓦片，请检查网络或配置可访问的底图服务。`">
        <template #action><Button size="small" @click="retryTiles">重试底图</Button></template>
      </Alert>
      <Alert v-if="mapError" type="error" show-icon :message="mapError" />
      <div class="airac-map-content">
        <div ref="container" class="airac-map-canvas" aria-label="AIRAC 地图" />
        <aside v-if="query.trim() || selected || showDiagnostics || !hasFeatures" class="airac-map-inspector">
          <template v-if="query.trim()">
            <h2>搜索结果（{{ matches.total }}）</h2>
            <Empty v-if="!matches.total" description="无匹配地图对象" />
            <Button v-for="entry in matches.results" :key="entry.id" class="airac-map-result" @click="locate(entry.id)">
              <strong>{{ typeNames[entry.type] }} · {{ entry.code || '无代码' }} · {{ entry.name || '无名称' }}</strong>
              <small>{{ entry.id }}</small><small v-if="entry.reason">不可定位：{{ entry.reason }}</small>
            </Button>
            <p v-if="matches.total > matches.results.length" class="airac-hint">仅显示前 {{ matches.results.length }} 项，另有 {{ matches.total - matches.results.length }} 项；请缩小搜索范围。</p>
          </template>
          <Empty v-if="!hasFeatures" description="没有可绘制的有效要素，请查看地图诊断" />
          <template v-if="selected">
            <h2>{{ label(selected) }}</h2>
            <p class="airac-hint">{{ typeNames[selected.type] }} · {{ selected.id }}</p>
            <Alert v-if="selectionReason" type="warning" :message="`不可定位：${selectionReason}`" />
            <p v-for="key in summaryKeys" :key="key">{{ fieldNames[key] || key }}：{{ propertyText(selected, key) }}</p>
            <template v-if="selected.type === 'Airspace'">
              <div v-for="(volume,i) in airspaceVolumes(selected)" :key="i">
                <h3>空域高度范围{{ airspaceVolumes(selected).length > 1 ? `（${i + 1}）` : '' }}</h3>
                <p v-for="key in altitudeKeys" :key="key">{{ fieldNames[key] }}：{{ propertyText({ properties: volume }, key) }}</p>
              </div>
              <h3>管制单位与通信（{{ selectedServices.length }} 项服务）</h3>
              <p v-if="!selectedServices.length" class="airac-hint">数据集未提供此空域的关联空管服务。</p>
              <div v-for="(service,i) in selectedServices" :key="service.id">
                <h3>空管服务 {{ i + 1 }} <Button type="link" @click="detail(service.id)">查看服务详情</Button></h3>
                <p>管制单位：<span v-if="!service.unitIds.length">字段未提供</span><Button v-for="id in service.unitIds" :key="id" type="link" @click="detail(id)">{{ label(airac.objects[id]) }}</Button></p>
                <p v-if="!service.callsigns.length">呼号：{{ service.callsignStatus }}</p>
                <p v-for="(callsign,j) in service.callsigns" :key="j">呼号：{{ callsign.callSign }}（语言：{{ callsign.language }}）</p>
                <p v-if="!service.channels.length" class="airac-hint">数据集未提供此服务的关联通信频道。</p>
                <div v-for="channel in service.channels" :key="channel.id">
                  <p>{{ channelRanks[channel.rank] || channel.rank }} <Button type="link" @click="detail(channel.id)">查看频道详情</Button></p>
                  <p>发射频率：{{ channel.transmission }}；接收频率：{{ channel.reception }}</p>
                </div>
              </div>
            </template>
            <template v-if="selected.type === 'RouteSegment' && selectedFeature">
              <p>可用方向：{{ directionText(selectedFeature) }}</p>
              <p>导航类型：{{ propertyText(selected, 'navigationType') }}</p>
              <p>所需导航性能：{{ propertyText(selected, 'requiredNavigationPerformance') }}</p>
              <p>所属航路：<Button type="link" @click="locate(selectedFeature.properties.routeId)">{{ label(airac.objects[selectedFeature.properties.routeId]) }}</Button></p>
              <p class="airac-hint">已高亮所属航路符合筛选的 {{ featureSet(selectedFeature.properties.routeId).length }} 个可绘制航段。</p>
              <p v-for="key in ['startId','endId']" :key="key">{{ key === 'startId' ? '起点' : '终点' }}：
                <Button type="link" @click="locate(selectedFeature.properties[key])">{{ label(airac.objects[selectedFeature.properties[key]]) }}</Button>
              </p>
            </template>
            <p v-if="selected.type === 'Route'">可绘制航段：{{ featureSet(selected.id).length }}（高亮实际航段集合）</p>
            <template v-if="selected.type === 'Navaid'">
              <p class="airac-hint">位置代表 Navaid 整体；设备参数和独立位置以设备原始数据为准。</p>
              <h3>关联设备（{{ data.equipment.get(selected.id).length }}）</h3>
              <Button v-for="id in data.equipment.get(selected.id)" :key="id" type="link" @click="detail(id)">{{ typeNames[airac.objects[id].type] }} · {{ label(airac.objects[id]) }} · 查看设备详情</Button>
            </template>
            <Button type="primary" @click="detail(selected.id)">查看数据详情</Button>
          </template>
          <template v-if="candidates.length > 1">
            <h3>点击位置的其他对象（{{ candidates.length }}）</h3>
            <Button v-for="id in candidates" :key="id" class="airac-map-result" @click="choose(id, clickLocation)">
              {{ typeNames[airac.objects[id].type] }} · {{ data.features.get(id).properties.label }}<small>{{ id }}</small>
            </Button>
          </template>
          <template v-if="showDiagnostics">
            <h2>地图诊断</h2>
            <p v-for="(count,type) in data.diagnostics.counts" :key="type">{{ typeNames[type] }}：绘制 {{ count.drawn }} · 缺失 {{ count.missing }} · 无效 {{ count.invalid }}<template v-if="type === 'RouteSegment'"> · 不可绘制 {{ count.excluded }}</template></p>
            <details v-for="[title,entries] in diagnosticGroups" :key="title">
              <summary>{{ title }}（{{ entries.length }}）</summary>
              <p v-for="(entry,i) in entries" :key="i"><Button type="link" @click="detail(entry.id)">{{ typeNames[entry.type] }} · {{ entry.id }}</Button><br>{{ entry.reason }}</p>
            </details>
          </template>
        </aside>
      </div>
      <p class="airac-map-note">航路线表示端点关系，箭头表示 XML 声明的可用方向（单向 / 双向），不代表实际飞行轨迹。航段过短时隐藏箭头，放大后显示。空域按 XML 水平边界绘制，高度与参考面见对象详情；未支持的曲线见地图诊断。RNAV / RNP 要求随航段标注显示。标签随放大显示；视野内最多显示 80 个标签。</p>
    </template>
  </section>
</template>

<script setup>
import { computed, ref, shallowRef, reactive, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Alert, Button, Checkbox, Empty, Input, Result, Select, Spin } from 'ant-design-vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { airac, label, typeNames, fieldNames, openObject, loadAirac } from '../airac.js'
import { buildMapData, searchMap, mapTypes, propertyText, airspaceTypes, airspaceType, airspaceVolumes, containsAirspace, routeArrowHeads, matchesRouteNavigation } from '../airac-map.js'

const props = defineProps({ visible: Boolean, theme: String })
const emit = defineEmits(['detail'])
const container = ref(null), data = shallowRef(null)
const query = ref(''), selectedId = ref(''), candidates = ref([]), showDiagnostics = ref(false)
const navigationFilter = ref('ALL')
const navigationOptions = computed(() => data.value ? [
  { value: 'ALL', label: '全部航段' }, { value: 'RNAV', label: '全部 RNAV' }, { value: 'RNP', label: '全部 RNP' },
  ...[...new Set(data.value.collections.RouteSegment.features.map(f => f.properties.navigationLabel).filter(Boolean))].sort().map(value => ({ value, label: value })),
] : [])
const filteredRouteCount = computed(() => data.value?.collections.RouteSegment.features.filter(matchesNavigation).length || 0)
const enabled = reactive(Object.fromEntries(mapTypes.map(type => [type, true])))
const spaceEnabled = reactive(Object.fromEntries(Object.keys(airspaceTypes).map(type => [type, true])))
const altitudeKeys = ['lowerLimit', 'lowerLimitReference', 'upperLimit', 'upperLimitReference']
const channelRanks = { PRIMARY: '主用', ALTERNATE: '备用' }
const tileError = ref(false), mapError = ref('')
const tileUrl = import.meta.env.VITE_AIRAC_TILE_URL
const tileAttribution = import.meta.env.VITE_AIRAC_TILE_ATTRIBUTION
const tileHost = ref('tile.openstreetmap.org')
const failedTiles = new Set()
const colors = computed(() => props.theme === 'dark'
  ? { AirportHeliport: '#d89139', DesignatedPoint: '#4a96c9', Navaid: '#279f86', Route: '#596ca4', Airspace: '#279f86' }
  : { AirportHeliport: '#986014', DesignatedPoint: '#166598', Navaid: '#087962', Route: '#526797', Airspace: '#087962' })
const matches = computed(() => data.value ? searchMap(data.value, query.value) : { results: [], total: 0 })
const selected = computed(() => airac.objects[selectedId.value])
const selectedFeature = computed(() => data.value?.features.get(selectedId.value))
const selectedServices = computed(() => selected.value?.type === 'Airspace' ? data.value.airspaceServices.get(selectedId.value) : [])
const selectionReason = computed(() => {
  if (selected.value?.type === 'RouteSegment' && selectedFeature.value && !matchesNavigation(selectedFeature.value)) return '此航段不符合当前导航要求筛选条件'
  if (selected.value?.type === 'Route' && !featureSet(selectedId.value).length && navigationFilter.value !== 'ALL') return '当前导航要求筛选下无可绘制航段'
  return data.value?.search.find(entry => entry.id === selectedId.value)?.reason || ''
})
const hasFeatures = computed(() => data.value?.features.size > 0)
const summaryKeys = computed(() => ({
  AirportHeliport: ['locationIndicatorICAO', 'designatorIATA', 'name', 'fieldElevation'],
  DesignatedPoint: ['designator', 'name', 'type'],
  Navaid: ['designator', 'name', 'type'],
  Route: ['designatorPrefix', 'designatorSecondLetter', 'designatorNumber', 'name'],
  Airspace: ['designator', 'name', 'type'],
  RouteSegment: ['length', 'magneticTrack', 'reverseMagneticTrack'],
}[selected.value?.type] || []))
const diagnosticGroups = computed(() => [
  ['合法缺失位置', data.value.diagnostics.missing],
  ['无效位置 / 关系错误', data.value.diagnostics.invalid],
  ['不可绘制航段', data.value.diagnostics.segments],
  ['未绘制方向箭头', data.value.diagnostics.directions],
])
let map, tiles, renderer, highlight, routeArrows, observer, mounted = false, clickLocation
const groups = new Map(), pointLayers = new Map(), spaceLayers = new Map(), navigationLayers = new Map(), routeLayers = new Map()
const layerType = type => type === 'RouteSegment' ? 'Route' : type
const matchesNavigation = feature => matchesRouteNavigation(feature, navigationFilter.value)
const isEnabled = feature => enabled[layerType(feature.properties.type)] && (feature.properties.type !== 'RouteSegment' || matchesNavigation(feature)) && (feature.properties.type !== 'Airspace' || spaceEnabled[feature.properties.airspaceType])
const latlng = coordinates => L.latLng(coordinates[1], coordinates[0])
const textNode = text => { const node = document.createElement('span'); node.textContent = text; return node }

function navaidEquipment(id) {
  const content = document.createElement('div')
  const ids = data.value.equipment.get(id)
  if (!ids.length) content.append(textNode('数据集未提供关联导航设备。'))
  for (const deviceId of ids) {
    const device = airac.objects[deviceId]
    const row = document.createElement('div')
    const key = device.type === 'DME' ? 'channel' : 'frequency'
    row.textContent = `${typeNames[device.type]} · ${label(device)} · ${key === 'channel' ? '频道' : '频率'}：${propertyText(device, key)}`
    content.append(row)
  }
  return content
}
function navaidTooltip(id) {
  const content = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = label(airac.objects[id])
  content.append(title, navaidEquipment(id))
  return content
}
function directionText(feature) {
  return { FORWARD: '起点 → 终点（正向）', BACKWARD: '终点 → 起点（反向）', BOTH: '起点 ↔ 终点（双向）' }[feature.properties.direction] || feature.properties.directionReason
}
function updateRouteArrows() {
  if (!map || !routeArrows) return
  routeArrows.clearLayers()
  if (!props.visible || !enabled.Route) return
  const bounds = L.bounds(map.containerPointToLayerPoint([0, 0]), map.containerPointToLayerPoint(map.getSize()))
  const routeId = selected.value?.type === 'Route' ? selectedId.value : selected.value?.type === 'RouteSegment' ? selectedFeature.value?.properties.routeId : null
  for (const feature of data.value.collections.RouteSegment.features) {
    if (!feature.properties.direction || !matchesNavigation(feature)) continue
    const [start, end] = feature.geometry.coordinates.map(c => map.latLngToLayerPoint(latlng(c)))
    const clipped = L.LineUtil.clipSegment(start, end, bounds)
    if (!clipped) continue
    const heads = routeArrowHeads([clipped[0].x, clipped[0].y], [clipped[1].x, clipped[1].y], feature.properties.direction)
    const selectedRoute = routeId === feature.properties.routeId
    const color = selectedRoute ? (props.theme === 'dark' ? '#c43b16' : '#ad2809') : colors.value.Route
    for (const head of heads) L.polyline(head.map(p => map.layerPointToLatLng(L.point(p))), {
      renderer, interactive: false, color, weight: selectedRoute ? 2.5 : 1.5, opacity: 0.9,
    }).addTo(routeArrows)
  }
}
function detail(id) { openObject(id); emit('detail') }
function featureSet(id) {
  return airac.objects[id].type === 'Route' ? data.value.routes.get(id).filter(matchesNavigation) : [data.value.features.get(id)].filter(f => f && (f.properties.type !== 'RouteSegment' || matchesNavigation(f)))
}
function highlightSelection() {
  if (!map) return
  highlight.clearLayers()
  if (!selected.value || !enabled[layerType(selected.value.type)] || (selectedFeature.value && !isEnabled(selectedFeature.value))) { updateRouteArrows(); return }
  const features = selected.value.type === 'RouteSegment'
    ? (data.value.routes.get(data.value.features.get(selectedId.value)?.properties.routeId) || []).filter(matchesNavigation)
    : featureSet(selectedId.value)
  L.geoJSON(features, {
    renderer, interactive: false,
    style: { color: props.theme === 'dark' ? '#c43b16' : '#ad2809', weight: 5, opacity: 1 },
    pointToLayer: (feature, location) => L.circleMarker(location, { renderer, interactive: false, radius: 10, color: '#c43b16', weight: 3, fillOpacity: 0.25 }),
  }).addTo(highlight)
  updateRouteArrows()
}
function choose(id, location) {
  const previous = airac.objects[selectedId.value]
  if (previous?.type === 'Navaid') pointLayers.get(previous.id)?.setTooltipContent(textNode(label(previous)))
  selectedId.value = id
  highlightSelection()
  updateLabels()
  const object = airac.objects[id]
  const features = featureSet(id)
  if (!features.length) { map?.closePopup(); return }
  const content = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = label(object)
  content.append(title)
  const addLine = text => { const p = document.createElement('p'); p.textContent = text; content.append(p) }
  addLine(`${typeNames[object.type]} · ${id}`)
  const keys = { AirportHeliport: ['locationIndicatorICAO', 'designatorIATA', 'fieldElevation'], DesignatedPoint: ['designator', 'type'], Navaid: ['designator', 'type'], RouteSegment: ['length', 'magneticTrack', 'reverseMagneticTrack'] }[object.type] || []
  for (const key of keys) addLine(`${fieldNames[key] || key}：${propertyText(object, key)}`)
  if (object.type === 'Navaid') {
    content.append(navaidEquipment(id))
    pointLayers.get(id)?.setTooltipContent(navaidTooltip(id)).openTooltip()
  }
  if (object.type === 'Airspace') {
    addLine(`类型：${object.fields.type}`)
    addLine(`关联空管服务：${selectedServices.value.length} 项；管制单位、呼号和收发频率见右侧面板。`)
    for (const [i, volume] of airspaceVolumes(object).entries()) {
      addLine(`高度范围 ${i + 1}`)
      for (const key of altitudeKeys) addLine(`${fieldNames[key]}：${propertyText({ properties: volume }, key)}`)
    }
  }
  if (object.type === 'RouteSegment') {
    const p = features[0].properties
    addLine(`可用方向：${directionText(features[0])}`)
    addLine(`导航类型：${propertyText(object, 'navigationType')}`)
    addLine(`所需导航性能：${propertyText(object, 'requiredNavigationPerformance')}`)
    addLine(`航路：${label(airac.objects[p.routeId])}`)
    addLine(`起点：${label(airac.objects[p.startId])}；终点：${label(airac.objects[p.endId])}`)
    addLine(`已高亮所属航路的 ${featureSet(p.routeId).length} 个符合筛选的航段。`)
  }
  if (object.type === 'Route') addLine(`高亮 ${features.length} 个实际航段`)
  if (candidates.value.length > 1) addLine(`此位置命中 ${candidates.value.length} 个对象，可在右侧选择其他对象。`)
  const button = document.createElement('button')
  button.className = 'tb'; button.textContent = '查看数据详情'
  button.addEventListener('click', () => detail(id))
  content.append(button)
  const anchor = location || (features[0].geometry.type === 'Point' ? latlng(features[0].geometry.coordinates) : L.geoJSON(features).getBounds().getCenter())
  L.popup({ maxWidth: 330 }).setLatLng(anchor).setContent(content).openOn(map)
}
function locate(id) {
  candidates.value = []; clickLocation = null
  enabled[layerType(airac.objects[id].type)] = true
  if (airac.objects[id].type === 'Airspace') spaceEnabled[airspaceType(airac.objects[id])] = true
  syncLayers()
  const features = featureSet(id)
  if (features.length) {
    if (features[0].geometry.type === 'Point') map.setView(latlng(features[0].geometry.coordinates), Math.max(map.getZoom(), 10))
    else map.fitBounds(L.geoJSON(features).getBounds(), { padding: [40, 40], maxZoom: 12 })
  }
  choose(id)
}
function onClick(event) {
  const location = event.latlng, p = map.latLngToLayerPoint(location), hits = []
  for (const feature of data.value.features.values()) {
    if (!isEnabled(feature)) continue
    const coordinates = feature.geometry.coordinates
    if (feature.geometry.type === 'Point') {
      if (p.distanceTo(map.latLngToLayerPoint(latlng(coordinates))) <= 9) hits.unshift(feature.properties.id)
    } else if (['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
      const polygons = feature.geometry.type === 'Polygon' ? [coordinates] : coordinates
      const nearBoundary = polygons.some(rings => rings.some(ring => ring.some((c, i) => i > 0 && L.LineUtil.pointToSegmentDistance(p, map.latLngToLayerPoint(latlng(ring[i - 1])), map.latLngToLayerPoint(latlng(c))) <= 8)))
      if (nearBoundary || containsAirspace(feature.geometry, [location.lng, location.lat])) hits.push(feature.properties.id)
    } else {
      const a = map.latLngToLayerPoint(latlng(coordinates[0])), b = map.latLngToLayerPoint(latlng(coordinates[1]))
      if (L.LineUtil.pointToSegmentDistance(p, a, b) <= 8) hits.push(feature.properties.id)
    }
  }
  hits.sort((a, b) => (airac.objects[a].type === 'Airspace') - (airac.objects[b].type === 'Airspace'))
  candidates.value = hits; clickLocation = location
  if (hits.length) choose(hits[0], location)
}
function updateLabels() {
  if (!map || !props.visible) return
  const bounds = map.getBounds(), zoom = map.getZoom()
  let count = 0
  const routeId = selected.value?.type === 'Route' ? selectedId.value : selectedFeature.value?.properties.routeId
  for (const [id, layer] of navigationLayers) {
    const feature = data.value.features.get(id)
    if (enabled.Route && matchesNavigation(feature) && (zoom >= 7 || routeId === feature.properties.routeId) && bounds.contains(layer.getCenter()) && count < 80) { layer.openTooltip(); count++ }
    else layer.closeTooltip()
  }
  for (const [id, layer] of pointLayers) {
    const type = airac.objects[id].type
    if (enabled[type] && bounds.contains(layer.getLatLng()) && ((type === 'Navaid' && selectedId.value === id) || (zoom >= (type === 'AirportHeliport' ? 7 : 10) && count < 80))) { layer.openTooltip(); count++ }
    else layer.closeTooltip()
  }
  for (const [id, layer] of spaceLayers) {
    const feature = data.value.features.get(id)
    if (isEnabled(feature) && zoom >= (feature.properties.airspaceType === 'FIR' ? 5 : 8) && bounds.contains(layer.getBounds().getCenter()) && count < 80) { layer.openTooltip(); count++ }
    else layer.closeTooltip()
  }
}
function syncLayers() {
  if (!map) return
  for (const [type, group] of groups) {
    if (Object.hasOwn(airspaceTypes, type) ? enabled.Airspace && spaceEnabled[type] : enabled[type]) group.addTo(map)
    else map.removeLayer(group)
  }
  for (const [id, layer] of routeLayers) {
    if (matchesNavigation(data.value.features.get(id))) groups.get('Route').addLayer(layer)
    else groups.get('Route').removeLayer(layer)
  }
  candidates.value = candidates.value.filter(id => isEnabled(data.value.features.get(id)))
  if (selected.value && (!enabled[layerType(selected.value.type)] || (selectedFeature.value && !isEnabled(selectedFeature.value)))) { highlight.clearLayers(); map.closePopup(); updateRouteArrows() }
  else highlightSelection()
  updateLabels()
}
function restyle() {
  for (const [type, group] of groups) group.setStyle({ color: colors.value[Object.hasOwn(airspaceTypes, type) ? 'Airspace' : type], fillColor: colors.value[Object.hasOwn(airspaceTypes, type) ? 'Airspace' : type] })
  for (const layer of routeLayers.values()) layer.setStyle({ color: colors.value.Route })
  highlightSelection()
}
function updateTileError(event) {
  if (event.type === 'tileerror') failedTiles.add(event.tile)
  else failedTiles.delete(event.tile)
  tileError.value = failedTiles.size > 0
}
function retryTiles() { failedTiles.clear(); tileError.value = false; tiles.redraw() }
async function initialize() {
  if (!mounted || airac.status !== 'ready' || map || !props.visible) return
  try {
    if (!data.value) data.value = buildMapData(airac.objects, airac.relations)
    await nextTick()
    if (!mounted || !props.visible || !container.value || map) return
    if (Boolean(tileUrl) !== Boolean(tileAttribution)) throw new Error('自定义底图必须同时配置 VITE_AIRAC_TILE_URL 和 VITE_AIRAC_TILE_ATTRIBUTION。')
    tileHost.value = new URL(tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', window.location.href).host
    if (!data.value.features.size) { mapError.value = '没有可用几何，无法计算初始地图范围。'; return }
    map = L.map(container.value, { preferCanvas: true })
    renderer = L.canvas({ padding: 0.5 })
    tiles = L.tileLayer(tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: tileAttribution || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).on('tileerror tileload tileunload', updateTileError).addTo(map)
    for (const [type, name] of Object.entries(airspaceTypes)) {
      const features = data.value.collections.Airspace.features.filter(f => f.properties.airspaceType === type)
      const group = L.geoJSON(features, {
        renderer, interactive: false,
        style: { color: colors.value.Airspace, weight: type === 'FIR' ? 2.5 : 1.5, opacity: 0.65, fillOpacity: 0.025, dashArray: ['AR', 'AP', 'SECTOR'].includes(type) ? '5 4' : null },
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(textNode(`${airac.objects[feature.properties.id].fields.designator} · ${name}`), { direction: 'center' })
          spaceLayers.set(feature.properties.id, layer)
        },
      })
      groups.set(type, group)
      if (enabled.Airspace && spaceEnabled[type]) group.addTo(map)
    }
    for (const type of ['Route', ...mapTypes.slice(0, 3)]) {
      const collection = data.value.collections[type === 'Route' ? 'RouteSegment' : type]
      const group = L.geoJSON(collection, {
        renderer, style: { color: colors.value[type], weight: 1.5, opacity: 0.65 },
        pointToLayer: (feature, location) => L.circleMarker(location, { renderer, radius: type === 'AirportHeliport' ? 6 : type === 'Navaid' ? 5 : 3, color: colors.value[type], fillColor: colors.value[type], fillOpacity: 0.8, weight: 1 }),
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(textNode(feature.properties.navigationLabel ? `${feature.properties.label} · ${feature.properties.navigationLabel}` : feature.properties.label), { direction: 'top' })
          if (type === 'Route') routeLayers.set(feature.properties.id, layer)
          if (type === 'Route' && feature.properties.navigationLabel) navigationLayers.set(feature.properties.id, layer)
          if (type === 'Navaid') {
            layer.on('mouseover', () => layer.setTooltipContent(navaidTooltip(feature.properties.id)).openTooltip())
            layer.on('mouseout', () => {
              if (selectedId.value !== feature.properties.id) layer.setTooltipContent(textNode(feature.properties.label))
            })
          }
          if (feature.geometry.type === 'Point') pointLayers.set(feature.properties.id, layer)
        },
      })
      groups.set(type, group)
      if (Object.hasOwn(airspaceTypes, type) ? enabled.Airspace && spaceEnabled[type] : enabled[type]) group.addTo(map)
    }
    routeArrows = L.layerGroup().addTo(map)
    highlight = L.layerGroup().addTo(map)
    const bounds = L.featureGroup([...groups.values()]).getBounds()
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] })
    map.on('click', onClick).on('zoomend moveend', () => { updateLabels(); updateRouteArrows() })
    observer = new ResizeObserver(() => { map.invalidateSize({ pan: false }); updateLabels() })
    observer.observe(container.value)
    updateLabels(); updateRouteArrows()
  } catch (error) {
    mapError.value = `地图初始化失败：${error.message}`
    observer?.disconnect(); map?.remove(); map = null
    groups.clear(); pointLayers.clear(); spaceLayers.clear(); navigationLayers.clear(); routeLayers.clear()
  }
}
watch(() => airac.status, initialize)
watch(() => props.visible, async visible => {
  if (!visible) return
  await initialize(); await nextTick()
  map?.invalidateSize({ pan: false }); updateLabels(); updateRouteArrows()
})
watch(navigationFilter, () => { map?.closePopup(); syncLayers() })
watch(enabled, syncLayers)
watch(spaceEnabled, syncLayers)
watch(colors, restyle)
onMounted(() => { mounted = true; initialize() })
onBeforeUnmount(() => {
  mounted = false; observer?.disconnect(); map?.remove()
  failedTiles.clear()
  groups.clear(); pointLayers.clear(); spaceLayers.clear(); navigationLayers.clear(); routeLayers.clear(); map = null
})
</script>
