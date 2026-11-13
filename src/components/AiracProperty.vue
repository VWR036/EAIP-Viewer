<template>
  <div class="airac-property">
    <details v-if="node.children.length" :open="depth < 2">
      <summary><strong>{{ fieldNames[node.name] || node.name }}</strong> <span v-if="fieldNames[node.name]" class="airac-hint">{{ node.name }}</span> <span class="airac-hint">{{ node.children.length }} 项</span></summary>
      <div class="airac-node-meta">{{ node.namespace }}</div>
      <div v-if="Object.keys(node.attributes).length" class="airac-attributes">{{ node.attributes }}</div>
      <span v-if="node.text">{{ node.text }}</span>
      <AiracProperty v-for="(child, i) in node.children" :key="i" :node="child" :depth="depth + 1" />
    </details>
    <div v-else class="airac-property-leaf">
      <span><strong>{{ fieldNames[node.name] || node.name }}</strong> <span v-if="fieldNames[node.name]" class="airac-hint">{{ node.name }}</span></span>
      <span>{{ value }}</span>
      <small class="airac-node-meta">{{ node.namespace }}</small>
      <small v-if="Object.keys(node.attributes).length" class="airac-attributes">{{ node.attributes }}</small>
    </div>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { fieldNames } from '../airac.js'
const props = defineProps({ node: { type: Object, required: true }, depth: { type: Number, default: 0 } })
const value = computed(() => {
  const a = props.node.attributes
  if (a['{http://www.w3.org/2001/XMLSchema-instance}nil'] === 'true') return `nil · ${a.nilReason || '未提供 nilReason'}`
  return (props.node.text === '' ? '空字符串' : props.node.text) + (a.uom ? ` ${a.uom}` : '')
})
</script>
