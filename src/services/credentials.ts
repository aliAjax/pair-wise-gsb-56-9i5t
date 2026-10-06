import type {
  AccessRecord,
  ApprovalStep,
  CredentialIssueSource,
  MaterialFile,
  MaterialPackage,
  ScopeManualCheck,
  ViewCredential,
  WorkspaceState,
} from '@/types/domain'

/** 受控页短期查看凭证有效期：30 分钟 */
export const CREDENTIAL_TTL_MS = 30 * 60 * 1000
/** 同一目标并发续签的幂等窗口：5 秒，窗口内只保留先写入的一份 */
export const RENEW_DEDUP_MS = 5 * 1000
export const SCHEMA_VERSION = 2

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const shortId = () => crypto.randomUUID().slice(0, 8).toUpperCase()
const currentClock = (atIso?: string) => (atIso ? new Date(atIso).getTime() : Date.now())

export interface AuditSink {
  audit: WorkspaceState['audit']
  unshift: (
    entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> & { createdAt?: string },
  ) => void
}

export function createAuditSink(state: WorkspaceState): AuditSink {
  return {
    audit: state.audit,
    unshift: (entry) => {
      state.audit.unshift({
        ...entry,
        id: uid('audit'),
        createdAt: entry.createdAt ?? new Date().toISOString(),
      })
    },
  }
}

function controlledPageNumbers(file: MaterialFile, versionId: string): number[] {
  return (
    file.versions
      .find((version) => version.id === versionId)
      ?.pages.filter((page) => page.controlled)
      .map((page) => page.page) ?? []
  )
}

function buildCredential(params: {
  packageItem: MaterialPackage
  file: MaterialFile
  versionId: string
  source: CredentialIssueSource
  issuedAtIso: string
  reason: string
  nonce?: string
  ttlMs?: number
}): ViewCredential | undefined {
  const { packageItem, file, versionId, source, issuedAtIso, reason, nonce, ttlMs } = params
  const version = file.versions.find((item) => item.id === versionId)
  const controlledPages = controlledPageNumbers(file, versionId)
  if (!version || controlledPages.length === 0) return undefined
  const issuedAt = new Date(issuedAtIso).getTime()
  return {
    id: uid('credential'),
    code: `VC-${shortId()}`,
    packageId: packageItem.id,
    fileId: file.id,
    versionId,
    versionLabel: version.label,
    controlledPages,
    personnelScopes: [...packageItem.personnelScopes],
    status: 'active',
    issueSource: source,
    issuedAt: issuedAtIso,
    expiresAt: new Date(issuedAt + (ttlMs ?? CREDENTIAL_TTL_MS)).toISOString(),
    reason,
    requestNonce: nonce,
  }
}

/** 同一（文件 + 版本）目标上已有的有效凭证立即替换为 superseded */
function supersedeActive(
  credentials: ViewCredential[],
  fileId: string,
  versionId: string,
  endedAt: string,
  reason: string,
) {
  credentials
    .filter(
      (item) =>
        item.fileId === fileId &&
        item.versionId === versionId &&
        effectiveStatus(item, endedAt) === 'active',
    )
    .forEach((item) => {
      item.status = 'superseded'
      item.endedAt = endedAt
      item.reason = reason
    })
}

/** 到期是时间驱动的，读取时惰性判定，不产生审计 */
export function effectiveStatus(
  credential: ViewCredential,
  atIso?: string,
): ViewCredential['status'] {
  if (credential.status !== 'active') return credential.status
  if (currentClock(atIso) >= new Date(credential.expiresAt).getTime()) return 'expired'
  return 'active'
}

function effectiveCredential(
  credentials: ViewCredential[],
  fileId: string,
  versionId: string,
  atIso?: string,
): ViewCredential | undefined {
  return credentials
    .filter((item) => item.fileId === fileId && item.versionId === versionId)
    .find((item) => effectiveStatus(item, atIso) === 'active')
}

/** 提交审批：按当前审批引用版本和人员范围，为受控页逐个文件签发短期凭证；一般页不签 */
export function issueCredentialsForSubmission(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  sink: AuditSink,
  options: { round: number; atIso?: string } = { round: packageItem.currentRound },
): ViewCredential[] {
  const at = options.atIso ?? new Date().toISOString()
  const issued: ViewCredential[] = []
  state.files
    .filter((file) => file.packageId === packageItem.id)
    .forEach((file) => {
      const version = file.versions.find((item) => item.id === file.referencedVersionId)
      if (!version) return
      const controlledPages = controlledPageNumbers(file, version.id)
      if (controlledPages.length === 0) return
      supersedeActive(
        state.credentials,
        file.id,
        version.id,
        at,
        `第 ${options.round} 轮提交审批，按最新引用版本重新签发。`,
      )
      const credential = buildCredential({
        packageItem,
        file,
        versionId: version.id,
        source: 'submit',
        issuedAtIso: at,
        reason: `提交审批签发（第 ${options.round} 轮），绑定引用版本 ${version.label} 与当前人员范围。`,
      })
      if (credential) {
        state.credentials.unshift(credential)
        issued.push(credential)
      }
    })
  sink.unshift({
    packageId: packageItem.id,
    action: '签发查看凭证',
    target: packageItem.code,
    operator: '当前用户',
    detail: issued.length
      ? `为 ${issued.length} 个含受控页的文件签发短期凭证（30 分钟），一般页不签凭证；受控页 ${issued
          .flatMap((item) => item.controlledPages.map((page) => `${page}页`))
          .join('、')}。`
      : '当前引用版本没有受控页，未签发凭证。',
    createdAt: at,
  })
  return issued
}

/** 把审批路线整体退回待复核：历史意见保留在审计中，步骤全部回到等待，第一步重新活动 */
export function setRouteRecheck(
  packageItem: MaterialPackage,
  _reason: string,
  atIso?: string,
): ApprovalStep[] {
  const at = atIso ?? new Date().toISOString()
  packageItem.status = 'recheck'
  packageItem.updatedAt = at
  packageItem.approvalRoute.forEach((step, index) => {
    if (index === 0) step.status = 'active'
    else step.status = 'waiting'
  })
  return packageItem.approvalRoute
}

/** 作废资料包下的有效凭证，需要时把审批路线退回待复核 */
export function invalidatePackageCredentials(
  state: WorkspaceState,
  packageItem: MaterialPackage,
  params: {
    trigger: 'personnel' | 'version' | 'controlled' | 'approval'
    target: string
    detail: string
    recheck: boolean
    fileIds?: string[]
    versionIds?: string[]
    atIso?: string
    operator?: string
  },
): number {
  const at = params.atIso ?? new Date().toISOString()
  const actionMap = {
    personnel: '人员范围变更失效凭证',
    version: '文件版本变更失效凭证',
    controlled: '受控标记变更失效凭证',
    approval: '审批节点关闭凭证',
  } as const
  const affected = state.credentials.filter(
    (item) =>
      item.packageId === packageItem.id &&
      (!params.fileIds || params.fileIds.includes(item.fileId)) &&
      (!params.versionIds || params.versionIds.includes(item.versionId)) &&
      effectiveStatus(item, at) === 'active',
  )
  affected.forEach((item) => {
    item.status = 'invalidated'
    item.endedAt = at
    item.reason = params.detail
  })
  if (affected.length) {
    state.audit.unshift({
      id: uid('audit'),
      packageId: packageItem.id,
      action: actionMap[params.trigger],
      target: params.target,
      operator: params.operator ?? '当前用户',
      detail: `${params.detail} 旧凭证立即拒绝，共 ${affected.length} 份。`,
      createdAt: at,
    })
  }
  if (params.recheck && packageItem.status === 'reviewing') {
    setRouteRecheck(packageItem, params.detail, at)
    state.audit.unshift({
      id: uid('audit'),
      packageId: packageItem.id,
      action: '审批退回待复核',
      target: params.target,
      operator: params.operator ?? '当前用户',
      detail: `${params.detail} 审批路线退回待复核，须重新提交并按最新版本签发凭证。`,
      createdAt: at,
    })
  }
  return affected.length
}

export interface RenewResult {
  credential?: ViewCredential
  duplicated: boolean
  reason: string
}

/**
 * 续签：两个窗口同时提交续签时，只保留仍有效的一份。
 * 同一（文件+版本）在幂等窗口内已有有效凭证，直接返回先签发的一份。
 */
export function renewCredential(
  state: WorkspaceState,
  packageId: string,
  fileId: string,
  sink: AuditSink,
  options: { nonce?: string; atIso?: string; operator?: string } = {},
): RenewResult {
  const at = options.atIso ?? new Date().toISOString()
  const packageItem = state.packages.find((item) => item.id === packageId)
  const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
  if (!packageItem || !file) throw new Error('资料包或文件不存在')
  const versionId = file.referencedVersionId
  const version = file.versions.find((item) => item.id === versionId)
  if (!version) throw new Error('审批引用版本不存在')
  const controlledPages = controlledPageNumbers(file, versionId)
  if (controlledPages.length === 0) {
    throw new Error('引用版本为一般页，不签发受控查看凭证')
  }
  if (file.activeVersionId !== file.referencedVersionId) {
    throw new Error('引用版本与现行版本不一致，请先在版本差异中确认引用版本后再续签')
  }

  const existing = effectiveCredential(state.credentials, fileId, versionId, at)
  if (existing && currentClock(at) - new Date(existing.issuedAt).getTime() <= RENEW_DEDUP_MS) {
    return {
      credential: existing,
      duplicated: true,
      reason: '续签请求与仍有效的凭证重复，已保留先签发的一份。',
    }
  }
  supersedeActive(state.credentials, fileId, versionId, at, '到期前续签，旧凭证被替换。')
  const credential = buildCredential({
    packageItem,
    file,
    versionId,
    source: 'renewal',
    issuedAtIso: at,
    reason: '到期前续签，按最新引用版本与人员范围重新签发。',
    nonce: options.nonce,
  })
  if (!credential) throw new Error('引用版本没有受控页')
  state.credentials.unshift(credential)
  sink.unshift({
    packageId,
    action: '续签查看凭证',
    target: `${packageItem.code} / ${file.name}`,
    operator: options.operator ?? '当前用户',
    detail: `续签凭证 ${credential.code}，覆盖 ${version.label} 受控页 ${controlledPages.join('、')}，30 分钟内有效。`,
    createdAt: at,
  })
  return { credential, duplicated: false, reason: '已按最新版本和人员范围续签。' }
}

/** 撤回授权：该文件（不指定则整包）旧凭证马上被拒绝；审批中则退回待复核 */
export function revokeCredentials(
  state: WorkspaceState,
  packageId: string,
  sink: AuditSink,
  options: { fileId?: string; atIso?: string; operator?: string; reason?: string } = {},
): number {
  const at = options.atIso ?? new Date().toISOString()
  const packageItem = state.packages.find((item) => item.id === packageId)
  if (!packageItem) throw new Error('资料包不存在')
  const file = options.fileId
    ? state.files.find((item) => item.id === options.fileId && item.packageId === packageId)
    : undefined
  if (options.fileId && !file) throw new Error('文件不存在')
  const detail =
    options.reason ??
    (file ? `撤回 ${file.name} 的受控页查看授权。` : `撤回 ${packageItem.code} 全部受控页查看授权。`)
  const targets = state.credentials.filter(
    (item) =>
      item.packageId === packageId &&
      (!file || item.fileId === file.id) &&
      effectiveStatus(item, at) === 'active',
  )
  targets.forEach((item) => {
    item.status = 'revoked'
    item.endedAt = at
    item.reason = detail
  })
  sink.unshift({
    packageId,
    action: '撤回查看授权',
    target: file?.name ?? packageItem.code,
    operator: options.operator ?? '当前用户',
    detail: `${detail} 旧凭证立即拒绝，共 ${targets.length} 份。`,
    createdAt: at,
  })
  if (packageItem.status === 'reviewing') {
    setRouteRecheck(packageItem, detail, at)
    sink.unshift({
      packageId,
      action: '审批退回待复核',
      target: packageItem.code,
      operator: options.operator ?? '当前用户',
      detail: '查看授权撤回后，审批路线退回待复核，须重新提交。',
      createdAt: at,
    })
  }
  return targets.length
}

/**
 * 写入失败模拟：凭证已构造但持久化未确认，状态置为 write-failed。
 * 访问检查直接拒绝，并提示可按最新版本恢复。
 */
export function markCredentialWriteFailed(
  state: WorkspaceState,
  credentialId: string,
  sink: AuditSink,
  options: { atIso?: string; operator?: string } = {},
): ViewCredential {
  const at = options.atIso ?? new Date().toISOString()
  const credential = state.credentials.find((item) => item.id === credentialId)
  if (!credential) throw new Error('凭证不存在')
  credential.status = 'write-failed'
  credential.endedAt = at
  credential.reason = '凭证写入后未收到持久化确认，暂不可用，可按最新版本恢复重签。'
  sink.unshift({
    packageId: credential.packageId,
    action: '凭证写入失败',
    target: credential.code,
    operator: options.operator ?? '当前用户',
    detail: '凭证写入失败已登记，恢复时按最新版本重新签发，旧记录保留追溯。',
    createdAt: at,
  })
  return credential
}

/** 写入失败后恢复：按最新版本重新签 */
export function recoverCredential(
  state: WorkspaceState,
  failedCredentialId: string,
  sink: AuditSink,
  options: { atIso?: string; operator?: string } = {},
): ViewCredential {
  const at = options.atIso ?? new Date().toISOString()
  const failed = state.credentials.find((item) => item.id === failedCredentialId)
  if (!failed) throw new Error('待恢复凭证不存在')
  const packageItem = state.packages.find((item) => item.id === failed.packageId)
  const file = state.files.find((item) => item.id === failed.fileId)
  if (!packageItem || !file) throw new Error('资料包或文件已不存在')
  if (file.activeVersionId !== file.referencedVersionId) {
    throw new Error('引用版本与现行版本不一致，恢复前请先确认唯一引用版本')
  }
  const controlledPages = controlledPageNumbers(file, file.referencedVersionId)
  if (controlledPages.length === 0) throw new Error('最新引用版本已无受控页，无需恢复凭证')
  failed.status = 'superseded'
  failed.endedAt = at
  failed.reason = '写入失败后按最新版本恢复，原记录作废。'
  supersedeActive(state.credentials, file.id, file.referencedVersionId, at, '失败恢复重签。')
  const credential = buildCredential({
    packageItem,
    file,
    versionId: file.referencedVersionId,
    source: 'recovery',
    issuedAtIso: at,
    reason: `写入失败后恢复，按最新引用版本 ${
      file.versions.find((item) => item.id === file.referencedVersionId)?.label
    } 重新签发。`,
  })
  if (!credential) throw new Error('恢复签发失败')
  state.credentials.unshift(credential)
  sink.unshift({
    packageId: packageItem.id,
    action: '恢复查看凭证',
    target: `${file.name} / ${credential.code}`,
    operator: options.operator ?? '当前用户',
    detail: `凭证 ${failed.code} 写入失败后已按最新版本恢复重签为 ${credential.code}。`,
    createdAt: at,
  })
  return credential
}

export interface AccessCheckResult {
  record: AccessRecord
}

/** 受控页访问闸门：一般页直接放行不查凭证；受控页必须有当前版本、当前人员范围绑定的有效凭证 */
export function checkPageAccess(
  state: WorkspaceState,
  params: {
    packageId: string
    fileId: string
    page: number
    viewer?: string
    atIso?: string
  },
): AccessCheckResult {
  const at = params.atIso ?? new Date().toISOString()
  const packageItem = state.packages.find((item) => item.id === params.packageId)
  const file = state.files.find(
    (item) => item.id === params.fileId && item.packageId === params.packageId,
  )
  if (!packageItem || !file) throw new Error('资料包或文件不存在')
  // 审批人查看的是审批引用版本
  const versionId = file.referencedVersionId
  const version = file.versions.find((item) => item.id === versionId)
  const pageReview = version?.pages.find((item) => item.page === params.page)
  const base = {
    id: uid('access'),
    packageId: packageItem.id,
    fileId: file.id,
    versionId,
    page: params.page,
    viewer: params.viewer ?? '当前用户',
    createdAt: at,
  }

  const deny = (credential: ViewCredential | undefined, reason: string): AccessCheckResult => {
    const record: AccessRecord = {
      ...base,
      controlled: true,
      credentialId: credential?.id,
      result: 'denied',
      deniedReason: reason,
    }
    state.accessRecords.unshift(record)
    state.audit.unshift({
      id: uid('audit'),
      packageId: packageItem.id,
      action: '受控页访问拒绝',
      target: `${file.name} 第 ${params.page} 页`,
      operator: base.viewer,
      detail: reason,
      createdAt: at,
    })
    return { record }
  }

  const grant = (credential: ViewCredential | undefined, controlled: boolean): AccessCheckResult => {
    const record: AccessRecord = {
      ...base,
      controlled,
      credentialId: credential?.id,
      result: 'granted',
    }
    state.accessRecords.unshift(record)
    return { record }
  }

  if (!pageReview?.controlled) {
    // 一般页不签凭证、不查凭证
    return grant(undefined, false)
  }

  const candidates = state.credentials.filter(
    (item) => item.fileId === file.id && item.versionId === versionId,
  )
  const credential = candidates.find((item) => effectiveStatus(item, at) === 'active')
  if (!credential) {
    const failed = candidates.find((item) => item.status === 'write-failed')
    if (failed) {
      return deny(failed, '凭证写入失败未确认，请按最新版本恢复后再查看。')
    }
    const invalidated = candidates.find(
      (item) => item.status === 'invalidated' || item.status === 'superseded',
    )
    if (invalidated) {
      return deny(invalidated, '文件版本、受控标记或人员范围已变更，旧凭证已失效，须重新提交审批。')
    }
    const revoked = candidates.find((item) => item.status === 'revoked')
    if (revoked) return deny(revoked, '查看授权已撤回，旧凭证立即拒绝。')
    const manual = candidates.find((item) => item.status === 'manual-check')
    if (manual) {
      return deny(manual, '旧凭证按引用版本回填但人员范围无法确认，待人工核对后放行。')
    }
    if (candidates.some((item) => effectiveStatus(item, at) === 'expired')) {
      return deny(undefined, '短期查看凭证已到期，请在仍有效时续签或重新提交审批。')
    }
    return deny(undefined, '该受控页尚未签发查看凭证，请先提交审批。')
  }

  // 人员范围必须与凭证签发快照一致
  if (JSON.stringify(credential.personnelScopes) !== JSON.stringify(packageItem.personnelScopes)) {
    return deny(
      credential,
      '人员范围已调整，签发时的凭证范围与当前不一致，访问被拒绝并退回待复核。',
    )
  }
  return grant(credential, true)
}

/** 旧数据缺少凭证：按引用版本回填；范围无法确认的列待人工核对 */
export function backfillCredentialsForLegacyState(
  state: WorkspaceState,
  options: { nowIso?: string } = {},
): { backfilled: number; manual: number } {
  if ((state.credentials?.length ?? 0) > 0 || (state.scopeManualChecks?.length ?? 0) > 0) {
    return { backfilled: 0, manual: 0 }
  }
  if (!Array.isArray(state.credentials)) state.credentials = []
  if (!Array.isArray(state.accessRecords)) state.accessRecords = []
  if (!Array.isArray(state.scopeManualChecks)) state.scopeManualChecks = []
  const at = options.nowIso ?? new Date().toISOString()
  let backfilled = 0
  let manual = 0
  const auditDetails: string[] = []

  state.files.forEach((file) => {
    const packageItem = state.packages.find((item) => item.id === file.packageId)
    if (!packageItem) return
    const version = file.versions.find((item) => item.id === file.referencedVersionId)
    if (!version) return
    const controlledPages = controlledPageNumbers(file, version.id)
    if (controlledPages.length === 0) return

    // 范围确认：只有资料包快照中曾记录过该引用版本，才能确认签发时的人员范围；
    // 现行版本在快照中存在不代表历史引用版本的范围可确认，此类条目列待人工核对
    const snapshotVersion = packageItem.versions.find((item) =>
      Object.entries(item.snapshot.activeFileVersions).some(
        ([snapshotFileId, snapshotVersionId]) =>
          snapshotFileId === file.id && snapshotVersionId === version.id,
      ),
    )
    const scopeConfirmed = Boolean(snapshotVersion)
    const issuedAt = packageItem.updatedAt
    const credential: ViewCredential = {
      id: uid('credential'),
      code: `VC-BACK-${shortId()}`,
      packageId: packageItem.id,
      fileId: file.id,
      versionId: version.id,
      versionLabel: version.label,
      controlledPages,
      personnelScopes: snapshotVersion
        ? [...snapshotVersion.snapshot.personnelScopes]
        : [...packageItem.personnelScopes],
      // 旧凭证不延续访问权：一律到期；范围无法确认的另列人工核对
      status: scopeConfirmed ? 'expired' : 'manual-check',
      issueSource: 'backfill',
      issuedAt,
      expiresAt: new Date(new Date(issuedAt).getTime() + CREDENTIAL_TTL_MS).toISOString(),
      endedAt: issuedAt,
      reason: snapshotVersion
        ? `旧数据按引用版本 ${version.label} 回填，已到期，续签后恢复访问。`
        : `旧数据按引用版本 ${version.label} 回填，但无对应资料包快照确认人员范围，待人工核对。`,
    }
    state.credentials.unshift(credential)
    backfilled += 1
    if (!scopeConfirmed) {
      manual += 1
      const check: ScopeManualCheck = {
        id: uid('manual-check'),
        packageId: packageItem.id,
        fileId: file.id,
        versionId: version.id,
        controlledPages,
        status: 'pending',
        note: `${file.name} ${version.label} 在资料包快照中找不到该引用版本，人员范围无法自动确认。`,
        createdAt: at,
      }
      state.scopeManualChecks.unshift(check)
      auditDetails.push(`${file.name} 人员范围待人工核对`)
    } else {
      auditDetails.push(`${file.name} 按 ${version.label} 回填`)
    }
  })

  state.audit.unshift({
    id: uid('audit'),
    action: '旧数据凭证回填',
    target: '工作区迁移',
    operator: '系统',
    detail:
      `按审批引用版本回填 ${backfilled} 份受控页凭证（旧凭证不延续访问权，须续签），` +
      `${manual} 份人员范围无法确认已列待人工核对。` +
      (auditDetails.length ? `（${auditDetails.join('；')}）` : ''),
    createdAt: at,
  })
  return { backfilled, manual }
}

/** 人工核对完成：确认人员范围，manual-check 凭证作废，提示重新提交/续签 */
export function resolveScopeCheck(
  state: WorkspaceState,
  checkId: string,
  confirmedScopes: string[],
  sink: AuditSink,
  options: { atIso?: string; operator?: string; note?: string } = {},
): ScopeManualCheck {
  const at = options.atIso ?? new Date().toISOString()
  const check = state.scopeManualChecks.find((item) => item.id === checkId)
  if (!check) throw new Error('待核对条目不存在')
  if (check.status === 'resolved') throw new Error('该条目已完成核对')
  check.status = 'resolved'
  check.resolvedAt = at
  check.resolvedBy = options.operator ?? '当前用户'
  check.confirmedScopes = [...confirmedScopes]
  if (options.note) check.note = `${check.note} 核对结论：${options.note}`
  state.credentials
    .filter(
      (item) =>
        item.fileId === check.fileId &&
        item.versionId === check.versionId &&
        item.status === 'manual-check',
    )
    .forEach((item) => {
      item.status = 'invalidated'
      item.endedAt = at
      item.reason = '人员范围经人工核对确认，回填凭证作废，请重新提交审批签发。'
    })
  const packageItem = state.packages.find((item) => item.id === check.packageId)
  const file = state.files.find((item) => item.id === check.fileId)
  sink.unshift({
    packageId: check.packageId,
    action: '人员范围人工核对',
    target: file?.name ?? check.fileId,
    operator: options.operator ?? '当前用户',
    detail: `确认人员范围：${confirmedScopes.join('、') || '无特别范围'}，回填凭证作废，可重新提交审批。`,
    createdAt: at,
  })
  if (packageItem?.status === 'reviewing') {
    setRouteRecheck(packageItem, '人员范围人工核对后须重新提交。', at)
  }
  return check
}

export const credentialStatusLabels: Record<ViewCredential['status'], string> = {
  active: '有效',
  expired: '已到期',
  superseded: '已替换',
  invalidated: '已失效',
  revoked: '已撤回',
  'write-failed': '写入失败',
  'manual-check': '待人工核对',
}

export const credentialStatusColors: Record<ViewCredential['status'], string> = {
  active: 'success',
  expired: 'default',
  superseded: 'default',
  invalidated: 'error',
  revoked: 'error',
  'write-failed': 'warning',
  'manual-check': 'warning',
}

export const issueSourceLabels: Record<CredentialIssueSource, string> = {
  submit: '提交审批签发',
  renewal: '续签',
  recovery: '失败恢复',
  backfill: '旧数据回填',
}
