import { BlockList, isIP } from 'node:net';
import { logger } from './logger.js';

// Supervisor contract: set TRUE before spawning the tunnel daemon. Clear only after the final
// child exit with no restart pending. An uncertain child state stays exposed (fail closed).
// MEASURED 2026-11-03: userspace tailscaled delivers every tailnet peer to the app as a
// connection from 127.0.0.1, so loopback alone cannot prove a local proxy sent a header.
let loopbackExposed = false;
const loopback4 = new BlockList();
loopback4.addSubnet('127.0.0.0', 8, 'ipv4');
const loopback6 = new BlockList();
loopback6.addAddress('::1', 'ipv6');

export function setLoopbackExposed(exposed) {
  const next = Boolean(exposed);
  if (loopbackExposed === next) return;
  loopbackExposed = next;
  logger.info(`[http] loopback exposed = ${next}`);
}

export function isLoopbackExposed() {
  return loopbackExposed;
}

export function isLoopbackAddress(addr) {
  const family = typeof addr === 'string' ? isIP(addr) : 0;
  if (family === 4) return loopback4.check(addr, 'ipv4');
  // BlockList recognises both dotted and hex IPv4-mapped IPv6 spellings of 127/8.
  // BlockList parses the address, so `0:0:0:0:0:0:0:1` matches too (Codex review of #960: a string
  // compare against '::1' missed that spelling, which proxy-addr still reads as loopback).
  if (family === 6) return loopback6.check(addr, 'ipv6') || loopback4.check(addr, 'ipv6');
  return false;
}
