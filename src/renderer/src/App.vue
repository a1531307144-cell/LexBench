<script setup lang="ts">
import { ref } from 'vue'
import UpdateToast from './updaterUI/UpdateToast.vue'

// 外壳骨架：阶段1 起逐步替换为真实界面（检索 / 专题 / 文档库）
const nav = ref<'search' | 'topics' | 'library'>('search')
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">法</span>
        <span class="brand-name">法研台</span>
        <span class="brand-en">LexBench</span>
      </div>
      <div class="topbar-actions">
        <button class="btn">导入文档</button>
      </div>
    </header>
    <nav class="sidenav">
      <button class="nav-item" :class="{ active: nav === 'search' }" @click="nav = 'search'">
        检索
      </button>
      <button class="nav-item" :class="{ active: nav === 'topics' }" @click="nav = 'topics'">
        专题
      </button>
      <button class="nav-item" :class="{ active: nav === 'library' }" @click="nav = 'library'">
        文档库
      </button>
    </nav>
    <main class="content">
      <div class="placeholder-card">
        <h2>法研台 · LexBench</h2>
        <p>新骨架已就绪，核心功能将在 v0.3.0 逐步就位。</p>
      </div>
    </main>
    <UpdateToast />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 16px;
  background: #ffffff;
  border-bottom: 1px solid #e6e6ef;
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: linear-gradient(135deg, #9c3428, #c0483a);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}
.brand-name {
  font-size: 16px;
  font-weight: 600;
  color: #24242e;
}
.brand-en {
  font-size: 12px;
  color: #9a9aa8;
}
.sidenav {
  display: flex;
  gap: 4px;
  padding: 8px 16px 0;
  background: #ffffff;
  border-bottom: 1px solid #e6e6ef;
  flex-shrink: 0;
}
.nav-item {
  border: none;
  background: transparent;
  padding: 8px 14px;
  font-size: 14px;
  color: #6a6a78;
  border-radius: 8px 8px 0 0;
}
.nav-item.active {
  color: #24242e;
  font-weight: 600;
  box-shadow: inset 0 -2px 0 #9c3428;
}
.content {
  flex: 1;
  overflow: auto;
  padding: 24px;
}
.placeholder-card {
  max-width: 480px;
  margin: 80px auto;
  background: #ffffff;
  border: 1px solid #e6e6ef;
  border-radius: 12px;
  padding: 32px;
  text-align: center;
  color: #6a6a78;
}
.placeholder-card h2 {
  color: #24242e;
  margin-bottom: 12px;
}
.btn {
  border: 1px solid #e6e6ef;
  background: #ffffff;
  color: #24242e;
  border-radius: 7px;
  padding: 6px 14px;
  font-size: 13px;
}
.btn:hover {
  background: #f2f3f8;
}
</style>
