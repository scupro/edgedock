<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
const props = defineProps<{ title?: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && emit('close');
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
void props;
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal" :class="{ wide }" role="dialog" aria-modal="true">
      <header>
        <h2>{{ title }}</h2>
        <span class="spacer" />
        <slot name="actions" />
        <button class="ghost" aria-label="close" @click="emit('close')">✕</button>
      </header>
      <div class="body"><slot /></div>
    </div>
  </div>
</template>
