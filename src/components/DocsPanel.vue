<template>
  <div class="docs-panel">
    <div class="count" v-if="error" role="alert">资料索引加载失败：{{ error }}</div>
    <div class="count" v-else-if="loading">加载中…</div>
    <div class="list" v-else>
      <div v-for="{ node, depth } in visible" :key="node.id" class="row"
           :class="{ active: selected === node.id && store.viewer?.url === dataURL(node.p) }"
           :style="{ paddingLeft: 14 + depth * 16 + 'px' }" :title="node.en"
           @click="open(node)">
        <button v-if="node.c.length" class="tb icon" :aria-label="expanded.has(node.id) ? '收起 ' + node.t : '展开 ' + node.t"
                :aria-expanded="expanded.has(node.id)" @click.stop="toggle(node)">
          <VIcon :name="expanded.has(node.id) ? 'left' : 'right'" :size="12"/>
        </button>
        <VIcon v-else name="doc" :size="13" class="ico"/>
        <span class="name">{{ node.t }}</span>
        <span v-for="tag in node.tags" :key="tag" class="tag note">{{ tag }}</span>
        <span v-if="node.m" class="tag mod">修订</span>
      </div>
      <div class="count" v-if="!visible.length">无匹配文件</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import VIcon from './VIcon.vue'
import { store, loadJSON, dataURL } from '../store.js'

const tree = ref([])
const expanded = ref(new Set())
const selected = ref('')
const loading = ref(true)
const error = ref('')
onMounted(async () => {
  try {
    tree.value = await loadJSON('/data/index/docs.json')
    expanded.value = new Set(tree.value.map(n => n.id))
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
})

const visible = computed(() => {
  const q = store.search.trim().toLowerCase()
  const out = []
  function walk(nodes, depth) {
    for (const node of nodes) {
      if (q) {
        if (node.p && (node.t + ' ' + node.en).toLowerCase().includes(q)) out.push({ node, depth: 0 })
        walk(node.c, depth + 1)
      } else {
        out.push({ node, depth })
        if (expanded.value.has(node.id)) walk(node.c, depth + 1)
      }
    }
  }
  walk(tree.value, 0)
  return out
})

function toggle(node) {
  expanded.value.has(node.id) ? expanded.value.delete(node.id) : expanded.value.add(node.id)
}
function open(node) {
  if (!node.p) { toggle(node); return }
  selected.value = node.id
  store.curChart = -1
  store.viewer = { url: dataURL(node.p), title: 'EAIP 资料 — ' + node.t }
}
</script>
