// Which loop of the operator made an RPC request, for the proxy's per-component counters (/metrics `rpc.components`).
//
// The operator's one client is shared by every loop. A request is sent to the proxy path of the component its caller
// runs under (`scoped`), read when the request is made, in the caller's own async context: each component has its own
// HTTP transport, so a JSON-RPC batch never mixes two of them. Outside any scope a request goes to the fallback path.
// Counting only: the proxy serves every path the same way.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createTransport, http, type EIP1193RequestFn, type HttpTransportConfig, type Transport } from 'viem'
import type { Component } from './metrics.ts'

const scope = new AsyncLocalStorage<Component>()

/** Runs `fn` with every RPC request it makes, in any continuation, counted as `component`'s (an inner scope wins). */
export function scoped<T>(component: Component, fn: () => T): T {
  return scope.run(component, fn)
}

/** The component the current code runs under, or undefined outside any scope. */
export function currentScope(): Component | undefined {
  return scope.getStore()
}

/**
 * An HTTP transport that sends each request to `urlOf(component)` of the scope it was made in (`fallback` outside any).
 * Retries, timeout and batching are the plain http transport's, once: each path's raw request is wrapped here alone.
 */
export function scopedHttp(urlOf: (component: Component) => string, fallback: Component, opts: HttpTransportConfig = {}): Transport {
  return (params) => {
    const made = new Map<Component, ReturnType<Transport>>()
    const one = (c: Component) => {
      let t = made.get(c)
      if (!t) made.set(c, (t = http(urlOf(c), opts)(params)))
      return t
    }
    const base = one(fallback)
    return createTransport(
      {
        key: 'scoped-http',
        name: 'Scoped HTTP JSON-RPC',
        type: 'http',
        methods: base.config.methods,
        retryCount: base.config.retryCount,
        retryDelay: base.config.retryDelay,
        timeout: base.config.timeout,
        request: ((args: Parameters<EIP1193RequestFn>[0]) => one(scope.getStore() ?? fallback).config.request(args)) as EIP1193RequestFn,
      },
      base.value,
    )
  }
}
