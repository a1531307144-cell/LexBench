import { createApp } from 'vue'
import App from './App.vue'
// 精致排版：MiSans 可变字体（UI）+ 霞鹜文楷（法条/阅读正文），均为免费商用字体
import 'misans/lib/Normal/MiSansVF.min.css'
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css'
import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css'
import './styles/base.css'

createApp(App).mount('#app')
