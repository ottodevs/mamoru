import { PRODUCTION_BANNER, type AppConfig, type OwnerResponse, type SessionView } from '@mamoru/domain'
import type { ApiClient } from '../api/client.ts'
import { emptyAccount, FIXTURE_ACCOUNT_KEY, FIXTURE_ADDRESS } from './empty-account.ts'
import { poolsResponse } from './pools.ts'

// Dev (VITE_FIXTURES=1) and tests only. Never imported by the production build.
export const fixtureConfig: AppConfig = {
  mode: 'production',
  chainId: 8453,
  banner: { kind: 'simulation', text: PRODUCTION_BANNER },
  fundsGate: 'closed',
  dryRun: true,
}

export const fixtureSession: SessionView = { userId: 'user_fixture_01', accountKey: FIXTURE_ACCOUNT_KEY }

export const fixtureOwner: OwnerResponse = {
  accountKey: FIXTURE_ACCOUNT_KEY,
  chainId: 8453,
  address: FIXTURE_ADDRESS,
  owners: ['0x0000000000000000000000000000000000000100'],
  deployed: false,
}

const delay = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), 150))

export const fixtureClient: ApiClient = {
  config: () => delay(fixtureConfig),
  session: () => delay(fixtureSession),
  dashboard: () => delay(emptyAccount),
  pools: () => delay(poolsResponse),
  createOwner: () => delay(fixtureOwner),
  recoveryKit: () => delay({ chainId: 8453, address: FIXTURE_ADDRESS, fixture: true }),
  ackRecovery: () => delay({ ok: true as const }),
}
