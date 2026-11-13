<template>
  <div class="airport-panel">
    <!-- 一级：机场列表 -->
    <template v-if="!store.airport">
      <div class="list" ref="listEl">
        <div v-for="a in filtered" :key="a.icao" class="row" @click="select(a)">
          <span class="code">{{ a.icao }}</span>
          <span class="name">{{ a.name }}</span>
          <span class="meta">{{ a.iata }}</span>
        </div>
        <div class="count" v-if="filtered.length">{{ filtered.length }} 个机场</div>
        <div class="count" v-else>无匹配机场</div>
      </div>
    </template>

    <!-- 二级：航图分组 -->
    <template v-else>
      <div class="back" @click="back">
        <VIcon name="left" :size="14"/>
        <span class="code">{{ store.airport.icao }}</span>
        <span class="name">{{ store.airport.name }}</span>
      </div>
      <div class="detail" v-if="detail">
        <span v-if="detail.elev">标高 {{ detail.elev }}</span>
        <span v-if="detail.magvar">磁差 {{ detail.magvar }}</span>
        <div class="rwys" v-if="detail.rwys?.length">
          <span v-for="r in detail.rwys" :key="r.desig">
            {{ r.desig }} · {{ r.dimensions }}m
          </span>
        </div>
      </div>
      <div class="count" v-if="chartError" role="alert">航图索引加载失败：{{ chartError }}</div>
      <div class="count" v-else-if="loading">加载中…</div>
      <div class="list">
        <div v-for="(g, gi) in groups" :key="g.label" class="group">
          <div class="group-h" @click="toggle(gi)">
            <span>{{ g.label }}</span>
            <span class="n">{{ g.items.length }}</span>
          </div>
          <div class="group-b" v-show="!closedSet.has(gi)">
            <div v-for="c in g.items" :key="c.id"
                 class="chart" :class="{ active: isActive(g, c) }"
                 @click="openChart(c, g)">
              <span class="pg">{{ c.p || '—' }}</span>
              <div class="chart-content">
                <span class="cn" :title="c.n.trim()">{{ c.n.trim() }}</span>
                <span v-for="tag in c.tags" :key="tag" class="tag note">{{ tag }}</span>
                <span v-if="c.s" class="tag sup">SUP</span>
                <span v-if="c.m" class="tag mod">修订</span>
                <span v-if="!c.f" class="tag nopdf">无文件</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import VIcon from './VIcon.vue'
import { store, loadJSON, dataURL, CHART_GROUPS } from '../store.js'

const closedSet = ref(null)
const loading = ref(false)
const chartError = ref('')
let selectSeq = 0
onBeforeUnmount(() => { selectSeq++ })

const filtered = computed(() => {
  const q = store.search.trim().toUpperCase()
  if (!q) return store.airports
  return store.airports.filter(a => [a.icao, a.iata, a.name, a.nameEn].some(v => v.toUpperCase().includes(q)))
})

const detail = computed(() => store.details[store.airport?.icao])
const groups = computed(() => {
  const byType = {}
  for (const c of store.charts) (byType[c.t] ??= []).push(c)
  const out = []
  for (const [label, types] of CHART_GROUPS) {
    const items = types.flatMap(t => byType[t] || [])
    if (items.length) out.push({ label, items })
  }
  return out
})

function toggle(gi) {
  const s = new Set(closedSet.value)
  s.has(gi) ? s.delete(gi) : s.add(gi)
  closedSet.value = s
}

watch([() => store.airport, groups], () => {
  closedSet.value = new Set(groups.value.map((_, i) => i).filter(i => i > 0))
}, { immediate: true, deep: false })

async function select(a) {
  const seq = ++selectSeq
  store.airport = a
  store.charts = []
  store.flatCharts = []
  store.curChart = -1
  store.viewer = null
  chartError.value = ''
  loading.value = true
  try {
    const charts = await loadJSON(`/data/index/charts/${encodeURIComponent(a.icao)}.json`)
    if (seq === selectSeq) store.charts = charts
  } catch (error) {
    if (seq === selectSeq) chartError.value = error.message
  } finally {
    if (seq === selectSeq) loading.value = false
  }
}

function back() {
  selectSeq++
  loading.value = false
  chartError.value = ''
  store.airport = null
  store.viewer = null
  store.curChart = -1
}

function flatIndex(groups, g, c) {
  let i = 0
  for (const gg of groups) {
    for (const cc of gg.items) {
      if (gg === g && cc === c) return i
      i++
    }
  }
  return -1
}

function isActive(g, c) {
  return flatIndex(groups.value, g, c) === store.curChart
}

function openChart(c, g) {
  if (!c.f) return
  store.flatCharts = groups.value.flatMap(gg => gg.items)
  store.curChart = flatIndex(groups.value, g, c)
  store.viewer = {
    url: dataURL(c.f),
    title: `${store.airport.icao} ${store.airport.name} — ${c.n.trim()}${c.p ? '  ·  ' + c.p : ''}`,
  }
}
</script>
