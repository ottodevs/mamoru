#!/usr/bin/env bun
// otto/mamoru#62: `bun run monad:deploy-policies [--execute] [--rpc <url>]`. The code lives in @mamoru/scenarios
// (packages/scenarios/monad/deploy-policies-cli.ts), where viem and the registry resolve and the typecheck covers it.
import '../../packages/scenarios/monad/deploy-policies-cli.ts'
