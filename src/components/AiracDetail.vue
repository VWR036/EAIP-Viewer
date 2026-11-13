<template>
  <section class="airac-detail">
    <Spin v-if="airac.status === 'loading'" tip="正在读取并校验索引结构…" />
    <Result v-else-if="airac.status === 'error'" status="error" title="AIRAC 索引加载失败" :sub-title="airac.error">
      <template #extra><p>在 NAIP-Viewer 目录生成本地索引：</p><pre>npm run index:airac
npm run index:airac -- --source "C:/path/to/Dataset"</pre><Button @click="loadAirac">重试加载</Button></template>
    </Result>
    <Empty v-else-if="airac.status === 'idle'" description="尚未加载 AIRAC 数据" />
    <template v-else>
      <Breadcrumb><BreadcrumbItem v-for="(crumb,i) in crumbs" :key="i">{{ crumb.title }}</BreadcrumbItem></Breadcrumb>
      <template v-if="!selected">
        <h1>AIRAC 数据集概览</h1><p class="airac-hint">AIXM 5.1.1 · BASELINE · {{ Object.keys(airac.objects).length.toLocaleString() }} 个原始对象</p>
        <Descriptions bordered :column="{ xs: 1, md: 2 }" size="small">
          <DescriptionsItem v-for="key in ['product','pubNo','version','effectiveTime','uid','publisher']" :key="key" :label="metaNames[key]">{{ airac.manifest[key] ?? '字段未提供' }}</DescriptionsItem>
        </Descriptions>
        <h2>有效对象</h2><div class="airac-stats"><button v-for="(count,type) in airac.manifest.counts" :key="type" @click="selectNode({key: `overview/${type}`, ids: idsOf(type), breadcrumb: ['数据集概览', typeNames[type]]})"><span>{{ typeNames[type] }} <small>{{ type }}</small></span><strong>{{ count.toLocaleString() }}</strong></button></div>
        <h2>数据检查</h2><Alert type="success" show-icon :message="`${airac.manifest.validation.files} 个文件 SHA-256 通过；${airac.manifest.validation.references} 条引用检查通过`" />
        <p>目标时刻无有效状态：{{ airac.manifest.diagnostics.inactive.length }} 个</p><pre>{{ JSON.stringify(airac.manifest.diagnostics, null, 2) }}</pre>
      </template>
      <template v-else-if="selected.overview">
        <h1>{{ label(object) }}</h1><p class="airac-hint">机场概览 · 以下航段及航路仅表示端点关联</p>
        <div class="airac-stats"><button v-for="([title,ids],i) in airportGroups({...airport, id: object.id})" :key="title" @click="i === 0 ? openObject(object.id) : selectNode({key: `${selected.key}/${i}`, ids, airportId: object.id, evidenceKind: i === 4 ? 'segmentEvidence' : i === 5 ? 'routeEvidence' : null, breadcrumb: [...selected.breadcrumb,title]})"><span>{{ title }}</span><strong>{{ ids.length }}</strong></button></div>
      </template>
      <template v-else-if="object">
        <h1>{{ label(object) }}</h1><p class="airac-hint">{{ typeNames[object.type] }} · {{ object.id }}</p>
        <Tabs v-model:activeKey="tab">
          <TabPane key="properties" tab="属性">
            <Descriptions title="关键属性" bordered :column="{ xs: 1, md: 2 }" size="small"><DescriptionsItem v-for="key in summaryKeys" :key="key" :label="`${fieldNames[key] || key} (${key})`">{{ summaryValue(key) }}</DescriptionsItem></Descriptions>
            <p class="airac-hint">EPSG::4326 坐标轴：纬度、经度。其他 CRS 保留原始坐标。数值保留原单位。</p>
            <div v-if="object.type === 'RouteSegment'" class="airac-endpoints"><h2>航段起终点与航路</h2><p v-for="r in endpointRelations" :key="r.key">{{ r.meaning }}：<Button type="link" @click="openObject(r.target)">{{ label(airac.objects[r.target]) }}</Button></p></div>
            <h2>完整属性与命名空间</h2><AiracProperty :node="object.properties" /><h2>所选时间片</h2><pre>{{ JSON.stringify(object.selectedTimeSlice, null, 2) }}</pre>
          </TabPane>
          <TabPane key="relations" tab="关联对象">
            <Empty v-if="!objectRelations.length" description="该对象没有引用或被引用记录" />
            <Table v-else :columns="relationColumns" :data-source="objectRelations" :pagination="{pageSize:100, showSizeChanger:false}" row-key="key" size="small" :scroll="{ x: 700 }">
              <template #bodyCell="{column, record}"><template v-if="column.key === 'target'"><Button type="link" @click="openObject(record.target)">{{ typeNames[airac.objects[record.target].type] }} · {{ label(airac.objects[record.target]) }}</Button></template></template>
            </Table>
          </TabPane>
          <TabPane key="xml" tab="来源 XML"><p>{{ object.sourceFile }}</p><p>对象 ID：{{ object.id }}</p><p class="airac-hint">解析器重新序列化的对象片段，非原文件字节格式。</p><pre class="airac-xml">{{ object.xml }}</pre></TabPane>
        </Tabs>
      </template>
      <template v-else>
        <h1>{{ selected.breadcrumb.at(-1) }}</h1><p class="airac-hint">{{ selected.ids.length }} 个唯一对象</p>
        <Empty v-if="!selected.ids.length" description="此分类没有有效对象（0）" />
        <Table v-else :key="selected.key" :columns="listColumns" :data-source="rows" :pagination="{pageSize:100,showSizeChanger:false}" row-key="id" size="small" :scroll="{ x: 600 }">
          <template #bodyCell="{column,record}">
            <Button v-if="column.key === 'name'" type="link" @click="selectNode({key: `${selected.key}/${record.id}`, objectId: record.id, breadcrumb: [...selected.breadcrumb,label(record)]})">{{ label(record) }}</Button>
            <span v-else-if="column.key === 'type'">{{ typeNames[record.type] }}</span>
            <span v-else-if="column.key === 'evidence'">{{ evidence(record.id) }}</span>
          </template>
        </Table>
      </template>
    </template>
  </section>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { Alert, Breadcrumb, BreadcrumbItem, Button, Descriptions, DescriptionsItem, Empty, Result, Spin, Table, Tabs, TabPane } from 'ant-design-vue'
import AiracProperty from './AiracProperty.vue'
import { airac, label, idsOf, typeNames, fieldNames, selectNode, openObject, loadAirac, airportGroups } from '../airac.js'
const tab = ref('properties')
const selected = computed(() => airac.selected)
const object = computed(() => airac.objects[selected.value?.objectId])
const airport = computed(() => airac.relations.airports[selected.value?.airportId])
watch(() => object.value?.id, () => { tab.value = 'properties' })
const crumbs = computed(() => (selected.value?.breadcrumb || ['AIRAC','数据集概览']).map(title => ({title})))
const rows = computed(() => (selected.value?.ids || []).map(id => airac.objects[id]))
const listColumns = [{title:'对象',key:'name'},{title:'类型',key:'type'},{title:'关联依据',key:'evidence'}]
const relationColumns = [{title:'含义',dataIndex:'meaning'},{title:'关联对象',key:'target'},{title:'原始字段路径',dataIndex:'path'}]
const objectRelations = computed(() => airac.relations.references.filter(r => r.active && (r.sourceId === object.value?.id || r.targetId === object.value?.id)).map((r,i) => ({key:i, target:r.sourceId === object.value.id ? r.targetId : r.sourceId, meaning:`${r.sourceId === object.value.id ? '引用' : '被引用'} · ${r.role === 'start' ? '起点 · ' : r.role === 'end' ? '终点 · ' : ''}${fieldNames[r.field] || r.field}`,path:r.path})))
const endpointRelations = computed(() => objectRelations.value.filter(r => r.meaning.startsWith('引用')))
const summaryKeys = computed(() => ({AirportHeliport:['locationIndicatorICAO','designatorIATA','name','fieldElevation'],Runway:['designator','nominalLength','nominalWidth'],RunwayDirection:['designator','trueBearing','magneticBearing'],Airspace:['type','designator','name','upperLimit','lowerLimit'],Route:['designatorPrefix','designatorSecondLetter','designatorNumber','name'],RouteSegment:['length','magneticTrack','reverseMagneticTrack','upperLimit','lowerLimit']}[object.value?.type] || ['designator','name','type','frequency','channel']))
function summaryValue(key) {
  const n = object.value.properties.children.find(n => n.name === key)
  if (!n) return '字段未提供'
  if (n.attributes['{http://www.w3.org/2001/XMLSchema-instance}nil'] === 'true') return `nil · ${n.attributes.nilReason || '未提供 nilReason'}`
  return (n.text === '' ? '空字符串' : n.text) + (n.attributes.uom ? ` ${n.attributes.uom}` : '')
}
function evidence(id) {
  if (!selected.value.evidenceKind) return '—'
  return airport.value[selected.value.evidenceKind][id].map(e => selected.value.evidenceKind === 'segmentEvidence' ? `通过 ${label(airac.objects[e.via])}，作为${e.role === 'start' ? '起点' : '终点'}` : `通过关联航段 ${label(airac.objects[e.via])}`).join('；')
}
const metaNames = {product:'产品',pubNo:'发布期号',version:'版本',effectiveTime:'生效时刻（UTC）',uid:'数据集 UID',publisher:'发布机构'}
</script>
