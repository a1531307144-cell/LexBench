// 地址分类：判断一个 IP 是否属于内网 / 保留段（图片下载的 SSRF 防线）。
//
// 关键教训（2026-11-18 实测）：**不能**把 `::ffff:0:0/96` 作为网段加进 BlockList——
// Node 24 会把 IPv6 规则也用于 IPv4 查询，导致 8.8.8.8 被判成内网、所有外网图片都下不了。
// IPv4-mapped 地址改为显式前缀判定。

import { BlockList, isIP } from 'node:net'

const PRIVATE_NETS = new BlockList()

for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  PRIVATE_NETS.addSubnet(addr, prefix, 'ipv4')
}

for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64]
] as const) {
  PRIVATE_NETS.addSubnet(addr, prefix, 'ipv6')
}

/**
 * 是否属于内网 / 保留段。
 * - 不是合法 IP 时按「不安全」处理；
 * - 任何 IPv4-mapped IPv6（::ffff:…）一律视为可疑（URL 会把它规范化成十六进制）。
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 0) return true
  if (kind === 6 && /^::ffff:/i.test(ip)) return true
  return PRIVATE_NETS.check(ip, kind === 6 ? 'ipv6' : 'ipv4')
}
