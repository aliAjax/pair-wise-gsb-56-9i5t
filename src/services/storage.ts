import type { WorkspaceState } from '@/types/domain'
import { backfillCredentialsForLegacyState, sweepExpiredCredentials } from './credentials'
import { createInitialState } from './mockData'

const STORAGE_KEY = 'export-control-review-v1'

/** 旧数据迁移：补齐凭证/访问记录表；缺少凭证的按引用版本回填，并清扫到期凭证 */
function migrate(state: WorkspaceState): WorkspaceState {
  const migrated: WorkspaceState = {
    ...state,
    credentials: state.credentials ?? [],
    accessRecords: state.accessRecords ?? [],
  }
  const nowIso = new Date().toISOString()
  if (!migrated.backfilledAt) {
    migrated.credentials = backfillCredentialsForLegacyState({
      packages: migrated.packages,
      files: migrated.files,
      at: nowIso,
    })
    migrated.backfilledAt = nowIso
  }
  migrated.credentials = sweepExpiredCredentials(migrated.credentials, nowIso)
  return migrated
}

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = migrate(createInitialState())
    saveWorkspace(initial)
    return initial
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceState
    const migrated = migrate(parsed)
    if (JSON.stringify(migrated) !== raw) saveWorkspace(migrated)
    return migrated
  } catch {
    const initial = migrate(createInitialState())
    saveWorkspace(initial)
    return initial
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = migrate(createInitialState())
  saveWorkspace(initial)
  return initial
}
