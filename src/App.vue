<template>
  <HomePage v-if="atHome" :theme="theme" @enter="enterApp" @toggleTheme="toggleTheme"/>

  <ConfigProvider v-else :theme="antConfig"><div class="shell" :class="{ 'airac-shell': store.tab === 'airac' }">
    <nav class="rail">
      <button :class="{ on: store.tab === 'charts' }" @click="store.tab = 'charts'">
        <span class="lbl">机场航图</span>
      </button>
      <button :class="{ on: store.tab === 'docs' }" @click="store.tab = 'docs'">
        <span class="lbl">EAIP 资料</span>
      </button>
      <button :class="{ on: store.tab === 'airac' }" @click="store.tab = 'airac'" title="AIRAC 数据"><span class="lbl">AIRAC 数据</span></button>
      <div class="spring"/>
      <button @click="goHome">
        <span class="lbl">回到主页</span>
      </button>
      <button @click="toggleTheme">
        <span class="lbl">{{ theme === 'dark' ? '浅色模式' : '深色模式' }}</span>
      </button>
    </nav>

    <aside class="sidebar" v-show="sidebarOpen && !(store.tab === 'airac' && airacUI.view === 'map')">
      <div class="search-wrap" v-if="['charts', 'docs'].includes(store.tab)">
        <input v-model="store.search"
               :placeholder="store.tab === 'charts' ? '搜索机场 — ICAO / IATA / 名称' : '搜索资料文件'"
               @keydown.esc="store.search = ''">
      </div>
      <AirportPanel v-if="store.tab === 'charts'"/>
      <DocsPanel v-else-if="store.tab === 'docs'"/>
      <AiracTree v-else-if="store.tab === 'airac'"/>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="wordmark">EAIP<span>-Viewer</span></div>
        <span class="ver" v-if="store.tab === 'airac'">AIRAC {{ airac.manifest?.pubNo }} {{ airac.manifest?.version }} · EFF {{ airac.manifest?.effectiveTime || '尚未加载' }}</span>
        <span class="ver" v-else>{{ store.meta.DataVersion }} · EFF {{ store.meta.EffectiveDate }}</span>
        <div class="vtitle">{{ store.tab === 'airac' ? 'AIRAC 数据' : store.viewer?.title }}</div>
        <RadioGroup v-if="store.tab === 'airac'" v-model:value="airacUI.view" size="small" aria-label="AIRAC 视图">
          <RadioButton value="data">数据浏览</RadioButton><RadioButton value="map">地图</RadioButton>
        </RadioGroup>
      </header>
      <AiracDetail v-if="store.tab === 'airac'" v-show="airacUI.view === 'data'"/>
      <AiracMap v-if="store.tab === 'airac' && mapVisited" v-show="airacUI.view === 'map'" :visible="airacUI.view === 'map'" :theme="theme" @detail="airacUI.view = 'data'"/>
      <template v-if="store.tab !== 'airac'"><div v-if="indexError" class="airac-legacy-error" role="alert">EAIP 索引加载失败：{{ indexError }}</div><PdfViewer v-if="['charts','docs'].includes(store.tab)" style="flex:1"/></template>
    </div>
  </div></ConfigProvider>
</template>

<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import HomePage from './components/HomePage.vue'
import AirportPanel from './components/AirportPanel.vue'
import DocsPanel from './components/DocsPanel.vue'
import PdfViewer from './components/PdfViewer.vue'
import { store, loadJSON, dataURL } from './store.js'

import { ConfigProvider, RadioGroup, RadioButton, theme as antTheme } from 'ant-design-vue'
import AiracTree from './components/AiracTree.vue'
import AiracDetail from './components/AiracDetail.vue'
import AiracMap from './components/AiracMap.vue'
import { airac, airacUI, loadAirac } from './airac.js'
const mapVisited = ref(false)
watch(() => airacUI.view, view => { if (view === 'map') mapVisited.value = true }, { immediate: true })
const indexError = ref('')
const theme = ref(document.documentElement.dataset.theme || 'dark')
const antConfig = computed(() => {
  const dark = theme.value === 'dark'
  const css = getComputedStyle(document.documentElement)
  return { algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm, token: { colorPrimary: css.getPropertyValue('--accent').trim(), colorBgContainer: css.getPropertyValue('--panel').trim(), colorText: css.getPropertyValue('--text').trim(), colorBorder: css.getPropertyValue('--line').trim(), fontFamily: "'Segoe UI', 'Microsoft YaHei', sans-serif", fontSize: 13, borderRadius: 7 } }
})
watch(() => store.tab, t => { if (t === 'airac') loadAirac() }, { immediate: true })

const atHome = ref(!sessionStorage.getItem('eaip-entered'))
function enterApp() {
  sessionStorage.setItem('eaip-entered', '1')
  atHome.value = false
}
function goHome() {
  atHome.value = true
  sessionStorage.removeItem('eaip-entered')
}

const sidebarOpen = ref(true)

watch(() => store.tab, () => {
  store.search = ''
  store.viewer = null
  store.curChart = -1
})

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('naip-theme', theme.value)
}

function onKey(e) {
  if (e.target.tagName === 'INPUT') return
  if (store.tab !== 'charts' || store.curChart < 0) return
  if (e.key === 'PageUp') { e.preventDefault(); pdfNav(-1) }
  if (e.key === 'PageDown') { e.preventDefault(); pdfNav(1) }
}
function pdfNav(delta) {
  const idx = store.curChart + delta
  const c = store.flatCharts[idx]
  if (!c || !c.f) return
  store.curChart = idx
  store.viewer = {
    url: dataURL(c.f),
    title: `${store.airport.icao} ${store.airport.name} — ${c.n.trim()}${c.p ? '  ·  ' + c.p : ''}`,
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  try {
    store.meta = await loadJSON('/data/index/meta.json')
  } catch (error) { indexError.value = error.message }
  try {
    store.airports = await loadJSON('/data/index/airports.json')
    store.details = await loadJSON('/data/index/airport_details.json')
  } catch (error) { indexError.value = error.message }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>
