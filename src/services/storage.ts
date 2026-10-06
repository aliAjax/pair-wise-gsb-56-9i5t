import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'
import { SCHEMA_VERSION, backfillCredentialsForLegacyState } from './credentials'

const STORAGE_KEY = 'export-control-review-v1'
const LOCK_NAME = 'export-control-workspace-write'

type NavigatorWithLocks = Navigator & {
  locks?: { request?: <T>(name: string, callback: () => T | Promise<T>) => Promise<T> }
}

/** 跨窗口/标签串行化写操作；不支持 Web Locks 时退化为进程内互斥，保证单窗口并发安全 */
let writeChain: Promise<unknown> = Promise.resolve()

function withWriteLock<T>(task: () => T | Promise<T>): Promise<T> {
  const locks = (navigator as NavigatorWithLocks).locks
  if (locks && typeof locks.request === 'function') {
    return locks.request(LOCK_NAME, task)
  }
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}

function migrate(raw: Partial<WorkspaceState> | null): WorkspaceState {
  // 旧数据（缺少凭证集合）：按审批引用版本回填，范围无法确认的列待人工核对
  if (raw && !Array.isArray(raw.credentials)) {
    const migrated = raw as WorkspaceState
    migrated.credentials = []
    migrated.accessRecords = Array.isArray(migrated.accessRecords) ? migrated.accessRecords : []
    migrated.scopeManualChecks = Array.isArray(migrated.scopeManualChecks)
      ? migrated.scopeManualChecks
      : []
    migrated.schemaVersion = SCHEMA_VERSION
    backfillCredentialsForLegacyState(migrated)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    return migrated
  }
  return raw as WorkspaceState
}

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceState
    if (!Array.isArray(parsed.credentials)) return migrate(parsed)
    if (!Array.isArray(parsed.accessRecords)) parsed.accessRecords = []
    if (!Array.isArray(parsed.scopeManualChecks)) parsed.scopeManualChecks = []
    if (typeof parsed.schemaVersion !== 'number') parsed.schemaVersion = SCHEMA_VERSION
    return parsed
  } catch {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

/** 所有写接口的统一入口：读最新状态、加锁执行、落盘，防止两个窗口同时提交互相覆盖 */
export async function mutateWorkspace<T>(
  task: (state: WorkspaceState) => T,
): Promise<T> {
  return withWriteLock(async () => {
    const state = loadWorkspace()
    const result = await task(state)
    saveWorkspace(state)
    return result
  })
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  saveWorkspace(initial)
  return initial
}
