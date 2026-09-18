import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    lexbench: LexBenchApi
  }
}

type LexBenchApi = import('./index').LexBenchApi
