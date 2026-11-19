import { describe, expect, it } from 'vitest'
import { isPrivateAddress } from './netGuard'

describe('isPrivateAddress', () => {
  it('公网 IPv4 不能被误判（回归：::ffff:0:0/96 会让所有 IPv4 命中）', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '223.5.5.5', '203.0.114.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('常见私网 / 保留 IPv4 段', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255'
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('回环 / 链路本地 / ULA / NAT64 的 IPv6', () => {
    for (const ip of ['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '64:ff9b::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('IPv4-mapped IPv6 一律视为可疑（含十六进制规范化形式）', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:808:808']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('公网 IPv6 放行', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false)
  })

  it('非法输入按不安全处理', () => {
    for (const ip of ['', 'not-an-ip', '999.1.1.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
})
