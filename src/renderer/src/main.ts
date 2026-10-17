import { createApp } from 'vue'
import App from './App.vue'
import AiFloatWindow from './AiFloatWindow.vue'
// 精致排版：MiSans 可变字体（UI）+ 霞鹜文楷（法条/阅读正文），均为免费商用字体
import 'misans/lib/Normal/MiSansVF.min.css'
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css'
import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css'
import './styles/base.css'

// 同一份渲染包两个形态：?aiWindow=1 是 AI 独立窗口（主进程 aiWindow.ts 负责创建），其余为主应用
const isAiWindow = new URLSearchParams(window.location.search).has('aiWindow')
createApp(isAiWindow ? AiFloatWindow : App).mount('#app')
