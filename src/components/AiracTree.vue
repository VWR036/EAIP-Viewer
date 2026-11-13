<template>
  <div class="airac-tree">
    <div class="search-wrap"><Input v-model:value="airacUI.search" allow-clear placeholder="搜索机场 — 名称 / ICAO / IATA" /></div>
    <div class="airac-tree-body">
      <Button type="link" @click="selectNode(null)">数据集概览 / 数据检查</Button>
      <Spin v-if="airac.status === 'loading'" tip="正在加载 AIRAC 索引" />
      <Alert v-else-if="airac.status === 'error'" type="error" message="索引加载失败，详见右侧" />
      <template v-else-if="airac.status === 'ready'">
        <p v-if="!airportNodes.length && airacUI.search" class="airac-hint">无匹配机场</p>
        <Tree v-model:expandedKeys="airacUI.expanded" :selected-keys="airacUI.selectedKeys" :tree-data="nodes" block-node @select="onSelect" />
      </template>
    </div>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { Input, Tree, Spin, Alert, Button } from 'ant-design-vue'
import { airac, airacUI, idsOf, label, typeNames, selectNode, airportGroups } from '../airac.js'
const objectNode = (id, path, breadcrumb, children) => ({ key: `${path}/${id}`, title: label(airac.objects[id]), objectId: id, breadcrumb: [...breadcrumb, label(airac.objects[id])], children })
function category(title, ids, path, breadcrumb, children) { return { key: path, title: `${title} (${ids.length})`, ids, breadcrumb: [...breadcrumb, title], children } }
const airportNodes = computed(() => {
  if (airac.status !== 'ready') return []
  const q = airacUI.search.trim().toLowerCase()
  return idsOf('AirportHeliport').filter(id => { const o = airac.objects[id]; return [o.name, o.fields.locationIndicatorICAO, o.fields.designatorIATA].some(v => v?.toLowerCase().includes(q)) }).sort((a,b) => (airac.objects[a].fields.locationIndicatorICAO || '').localeCompare(airac.objects[b].fields.locationIndicatorICAO || '')).map(id => {
    const o = airac.objects[id], a = { ...airac.relations.airports[id], id }, path = `airports/${id}`, crumb = ['机场', label(o)]
    const groups = airportGroups(a).map(([title, ids], i) => {
      const key = `${path}/${i}`
      if (i === 0) return { ...objectNode(id, key, crumb), title: '基本信息' }
      let children
      if (i === 1) children = ids.map(r => objectNode(r, key, [...crumb, title], [category('方向', a.directions[r], `${key}/${r}/directions`, [...crumb, title, label(airac.objects[r])], a.directions[r].map(d => objectNode(d, `${key}/${r}/directions`, [...crumb, title, label(airac.objects[r]), '方向']))), category('中线点', a.centrelinePoints[r], `${key}/${r}/points`, [...crumb, title, label(airac.objects[r])], a.centrelinePoints[r].map(d => objectNode(d, `${key}/${r}/points`, [...crumb, title, label(airac.objects[r]), '中线点']))) ]))
      if (i === 2) children = ids.map(n => objectNode(n, key, [...crumb, title], a.equipment[n].map(e => objectNode(e, `${key}/${n}`, [...crumb, title, label(airac.objects[n])]))))
      return { ...category(title, ids, key, crumb, children), airportId: id, evidenceKind: i === 4 ? 'segmentEvidence' : i === 5 ? 'routeEvidence' : null }
    })
    return { ...objectNode(id, 'airports', ['机场'], groups), airportId: id, overview: true }
  })
})
const nodes = computed(() => airac.status !== 'ready' ? [] : [
  category('机场', idsOf('AirportHeliport'), 'airports', [], airportNodes.value),
  category('空域', idsOf('Airspace'), 'airspaces', [], ['FIR','CTA','TMA','SECTOR','P','R','D','ADIZ'].map((t,i) => category(['飞行情报区 FIR','管制区 CTA','终端管制区 TMA','扇区 SECTOR','禁区 P','限制区 R','危险区 D','防空识别区 ADIZ'][i], idsOf('Airspace').filter(id => airac.objects[id].fields.type === t), `airspaces/${t}`, ['空域']))),
  { key: 'public', title: '公共数据', breadcrumb: ['公共数据'], ids: [...idsOf('Route'), ...idsOf('RouteSegment'), ...idsOf('DesignatedPoint'), ...otherTypes.flatMap(idsOf)], children: [
    category('航路／航段', [...idsOf('Route'), ...idsOf('RouteSegment')], 'public/routes', ['公共数据'], ['Route','RouteSegment'].map(t => category(typeNames[t], idsOf(t), `public/${t}`, ['公共数据','航路／航段']))),
    category('指定点', idsOf('DesignatedPoint'), 'public/points', ['公共数据']),
    category('其他对象', otherTypes.flatMap(idsOf), 'public/other', ['公共数据'], otherTypes.map(t => category(typeNames[t], idsOf(t), `public/${t}`, ['公共数据','其他对象'])))
  ] }
])
const otherTypes = ['Navaid','VOR','DME','NDB','Localizer','Glidepath','MarkerBeacon','AirTrafficControlService','RadioCommunicationChannel','Unit']
function onSelect(keys, info) { if (keys.length) selectNode(info.node.dataRef) }
</script>
