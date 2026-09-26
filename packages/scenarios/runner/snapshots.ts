import { ReasonError, type Hex } from '@mamoru/domain'
import type { Lab } from '../fixtures/lab.ts'

export type SnapshotRef = { id: Hex; runId: string; name: string; timestamp: number }

/**
 * FR-LAB-005: every snapshot belongs to the run that took it. Restoring a
 * snapshot from another run is refused and nothing is reverted.
 */
export class SnapshotBook {
  private readonly refs = new Map<string, SnapshotRef>()

  constructor(
    private readonly lab: Lab,
    readonly runId: string,
  ) {}

  async take(name: string): Promise<SnapshotRef> {
    const id = await this.lab.snapshot()
    const ref = { id, runId: this.runId, name, timestamp: Number(await this.lab.timestamp()) }
    this.refs.set(name, ref)
    return ref
  }

  get(name: string): SnapshotRef {
    const r = this.refs.get(name)
    if (!r) throw new Error(`no snapshot ${name}`)
    return r
  }

  /** Reverts to the snapshot and pins the clock back to its time. The snapshot is consumed. */
  async restore(ref: SnapshotRef, requestingRunId: string = this.runId): Promise<void> {
    if (ref.runId !== requestingRunId || ref.runId !== this.runId) {
      throw new ReasonError('LAB_SNAPSHOT_FOREIGN', `snapshot ${ref.name} belongs to run ${ref.runId}`)
    }
    const ok = await this.lab.revert(ref.id)
    if (!ok) throw new Error(`anvil refused to revert ${ref.name}`)
    await this.lab.rpc('anvil_setTime', [ref.timestamp])
    this.refs.delete(ref.name)
  }
}
