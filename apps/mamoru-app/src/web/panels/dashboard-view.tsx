import type { DashboardPayload } from '@mamoru/domain'
import { ScopeContext } from '../components/scope.tsx'
import { ActionsPanel } from './actions.tsx'
import { CurrentActionPanel } from './current-action.tsx'
import { HeaderPanel } from './header.tsx'
import { LeavePanel } from './leave.tsx'
import { PoolsPanel, type PlanPools } from './pools.tsx'
import { PortfolioPanel } from './portfolio.tsx'
import { SavingsLogPanel, SavingsPanel } from './savings.tsx'
import { TreasuryPanel } from './treasury.tsx'

type Props = {
  data: DashboardPayload
  plan: PlanPools
  onDownloadKit: () => void
  kitState: 'idle' | 'pending' | 'error'
}

// Panel order is dashboard.md §3. The view paints the payload and derives nothing.
export function DashboardView({ data, plan, onDownloadKit, kitState }: Props) {
  return (
    <ScopeContext.Provider value={{ mode: data.mode, chains: data.chains }}>
      <HeaderPanel data={data} />
      <ActionsPanel data={data} />
      <CurrentActionPanel data={data} />
      <PortfolioPanel data={data} />
      <TreasuryPanel data={data} />
      <PoolsPanel data={data} plan={plan} />
      <SavingsPanel data={data} />
      <SavingsLogPanel data={data} />
      <LeavePanel onDownload={onDownloadKit} downloadState={kitState} />
    </ScopeContext.Provider>
  )
}
