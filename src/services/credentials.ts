import type {
  AccessRecord,
  AuditEntry,
  CredentialInvalidReason,
  CredentialStatus,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ViewCredential,
} from '@/types/domain'

/** 短期查看凭证有效期：30 分钟 */
export const CREDENTIAL_TTL_MS = 30 * 60 * 1000

export const credentialStatusLabels: Record<CredentialStatus, string> = {
  active: '有效',
  expired: '已到期',
  invalidated: '已失效',
  revoked: '已撤回',
  'write-failed': '写入失败待恢复',
  unconfirmed: '范围待人工核对',
}

export const invalidReasonLabels: Record<CredentialInvalidReason, string> = {
  'personnel-scope-changed': '人员范围调整',
  'file-version-changed': '文件现行版本变更',
  'controlled-flag-changed': '受控标记改变',
  'reference-version-changed': '审批引用版本变更',
  'superseded-renewal': '并发续签被合并',
  'authorization-withdrawn': '授权撤回',
  expired: '凭证到期',
  'manual-reject': '人工核对拒绝',
}

type AuditSink = (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => void

export function newToken() {
  return `vc-${crypto.randomUUID()}`
}

function maskToken(token: string) {
  return token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-6)}` : token
}

/** 受控页目标：仅已完成核对且标记受控的页面，一般页永远不签凭证 */
interface ControlledTarget {
  file: MaterialFile
  versionId: string
  pages: PageReview[]
}

export function collectControlledTargets(
  packageItem: MaterialPackage,
  files: MaterialFile[],
): ControlledTarget[] {
  return files
    .filter((file) => file.packageId === packageItem.id)
    .map((file) => {
      const version =
        file.versions.find((item) => item.id === file.referencedVersionId) ??
        file.versions.find((item) => item.id === file.activeVersionId)
      return {
        file,
        versionId: version?.id ?? file.referencedVersionId,
        pages:
          version?.pages.filter((page) => page.controlled && page.reviewedAt) ?? [],
      }
    })
    .filter((target) => target.pages.length > 0)
}

export function credentialBindingKey(credential: Pick<ViewCredential, 'packageId' | 'fileId' | 'versionId' | 'pageIds'>) {
  return [credential.packageId, credential.fileId, credential.versionId, [...credential.pageIds].sort().join('|')].join(
    '::',
  )
}

function isUsable(status: CredentialStatus, atIso: string) {
  return status === 'active' && new Date(atIso).getTime() > Date.now()
}

export function isCredentialActive(credential: ViewCredential, at = new Date().toISOString()) {
  return isUsable(credential.status, at) && new Date(credential.expiresAt).getTime() > new Date(at).getTime()
}

function buildCredential(input: {
  packageItem: MaterialPackage
  fileId: string
  versionId: string
  pageIds: string[]
  source: ViewCredential['source']
  status?: CredentialStatus
  confidence?: ViewCredential['scopeConfidence']
  renewedFromId?: string
  note?: string
  issuedAt: string
}): ViewCredential {
  const issuedMs = new Date(input.issuedAt).getTime()
  return {
    id: `credential-${crypto.randomUUID()}`,
    token: newToken(),
    packageId: input.packageItem.id,
    fileId: input.fileId,
    versionId: input.versionId,
    pageIds: [...input.pageIds],
    personnelScopes: [...input.packageItem.personnelScopes],
    status: input.status ?? 'active',
    source: input.source,
    scopeConfidence: input.confidence ?? 'confirmed',
    issuedAt: input.issuedAt,
    expiresAt: new Date(issuedMs + CREDENTIAL_TTL_MS).toISOString(),
    renewedFromId: input.renewedFromId,
    note: input.note,
  }
}

/** 作废旧凭证：只作废仍有效（未到期）或已到期但未留痕的凭证 */
function markSuperseded(
  credentials: ViewCredential[],
  packageId: string,
  issuedAt: string,
): ViewCredential[] {
  return credentials.map((credential) =>
    credential.packageId === packageId && credential.status === 'active'
      ? {
          ...credential,
          status: 'invalidated',
          invalidReason: 'superseded-renewal',
          invalidatedAt: issuedAt,
        }
      : credential,
  )
}

/** 安全兜底：同一绑定只保留最新一份有效凭证，其余标记为续签合并 */
export function enforceSingleActive(credentials: ViewCredential[]): ViewCredential[] {
  const winners = new Map<string, ViewCredential>()
  for (const credential of credentials) {
    if (credential.status !== 'active') continue
    const key = credentialBindingKey(credential)
    const current = winners.get(key)
    if (!current || new Date(credential.issuedAt).getTime() > new Date(current.issuedAt).getTime()) {
      winners.set(key, credential)
    }
  }
  const winnerIds = new Set([...winners.values()].map((item) => item.id))
  return credentials.map((credential) =>
    credential.status === 'active' && !winnerIds.has(credential.id)
      ? {
          ...credential,
          status: 'invalidated',
          invalidReason: 'superseded-renewal',
          invalidatedAt: new Date().toISOString(),
        }
      : credential,
  )
}

export interface IssueResult {
  credentials: ViewCredential[]
  created: ViewCredential[]
  blocked: string[]
}

/**
 * 提交审批时签发短期查看凭证：
 * 按当前文件引用版本与当前人员范围，仅为受控页逐页签发；一般页不签。
 */
export function issueCredentialsForSubmission(params: {
  credentials: ViewCredential[]
  packageItem: MaterialPackage
  files: MaterialFile[]
  audit: AuditSink
  at: string
  round?: number
}): IssueResult {
  const { credentials, packageItem, files, audit, at, round } = params
  const blocked: string[] = []
  const draft: Array<{ fileId: string; versionId: string; page: PageReview }> = []

  files
    .filter((file) => file.packageId === packageItem.id)
    .forEach((file) => {
      const version = file.versions.find((item) => item.id === file.referencedVersionId)
      if (!version) {
        blocked.push(`${file.name}：审批引用版本不存在`)
        return
      }
      version.pages
        .filter((page) => page.controlled)
        .forEach((page) => {
          if (!page.reviewedAt) {
            blocked.push(`${file.name} 第 ${page.page} 页：受控页未完成核对，不能签发查看凭证`)
            return
          }
          draft.push({ fileId: file.id, versionId: version.id, page })
        })
    })

  if (blocked.length) {
    return { credentials, created: [], blocked }
  }

  const created = draft.map(({ fileId, versionId, page }) =>
    buildCredential({
      packageItem,
      fileId,
      versionId,
      pageIds: [page.id],
      source: 'issue',
      issuedAt: at,
    }),
  )
  const next = enforceSingleActive([...markSuperseded(credentials, packageItem.id, at), ...created])

  if (created.length) {
    audit({
      packageId: packageItem.id,
      action: '签发查看凭证',
      target: `${created.length} 个受控页`,
      operator: '系统',
      detail: `提交审批（第 ${round ?? packageItem.currentRound} 轮），按引用版本与人员范围 ${
        packageItem.personnelScopes.join('、') || '不限制'
      } 签发短期凭证，有效期 30 分钟；一般页不签凭证。`,
    })
  }
  return { credentials: next, created, blocked }
}

/** 标记写入失败：凭证保留下来，等待恢复时按最新版本重签 */
export function markCredentialWriteFailed(params: {
  credentials: ViewCredential[]
  credentialId: string
  at: string
}): ViewCredential[] {
  const { credentials, credentialId, at } = params
  return credentials.map((credential) =>
    credential.id === credentialId
      ? {
          ...credential,
          status: 'write-failed',
          invalidatedAt: at,
          note: '凭证写入中断，恢复前不可使用。',
        }
      : credential,
  )
}

export interface RenewResult {
  credentials: ViewCredential[]
  renewed: ViewCredential
  merged: boolean
}

/** 续签：仅仍有效的凭证可续签；同绑定并发续签只保留一份有效凭证 */
export function renewCredential(params: {
  credentials: ViewCredential[]
  credentialId: string
  packageItem: MaterialPackage
  files: MaterialFile[]
  audit: AuditSink
  at: string
}): RenewResult {
  const { credentials, credentialId, packageItem, audit, at } = params
  const original = credentials.find((item) => item.id === credentialId)
  if (!original) throw new Error('凭证不存在')
  if (original.packageId !== packageItem.id) throw new Error('凭证不属于当前资料包')
  if (original.status !== 'active') {
    throw new Error('仅仍有效的凭证可以续签')
  }
  if (new Date(original.expiresAt).getTime() <= new Date(at).getTime()) {
    throw new Error('凭证已到期，请重新提交审批签发')
  }

  const sameBinding = credentials.find(
    (item) =>
      item.id !== original.id &&
      item.status === 'active' &&
      new Date(item.issuedAt).getTime() >= new Date(original.issuedAt).getTime() &&
      credentialBindingKey(item) === credentialBindingKey(original),
  )

  let renewed: ViewCredential
  let next: ViewCredential[]
  let merged = false
  if (sameBinding) {
    // 两个窗口同时续签：已存在更新的有效凭证，本窗口直接复用，不新增
    renewed = sameBinding
    next = credentials
    merged = true
  } else {
    renewed = buildCredential({
      packageItem,
      fileId: original.fileId,
      versionId: original.versionId,
      pageIds: original.pageIds,
      source: 'renew',
      renewedFromId: original.id,
      issuedAt: at,
    })
    next = credentials.map((item) =>
      item.id === original.id
        ? {
            ...item,
            status: 'invalidated',
            invalidReason: 'superseded-renewal',
            invalidatedAt: at,
            renewedById: renewed.id,
          }
        : item,
    )
    next = enforceSingleActive([...next, renewed])
  }

  audit({
    packageId: packageItem.id,
    action: merged ? '续签合并' : '续签查看凭证',
    target: maskToken(renewed.token),
    operator: '当前用户',
    detail: merged
      ? `检测到并发续签，保留仍有效的一份凭证 ${maskToken(renewed.token)}。`
      : `原凭证 ${maskToken(original.token)} 作废，新凭证 ${maskToken(renewed.token)} 有效期延长 30 分钟。`,
  })
  return { credentials: next, renewed, merged }
}

/**
 * 写入失败后恢复：按最新引用版本与最新人员范围逐页重签；
 * 最新版本中该页已不再受控或无法定位的，按原因失效，不静默恢复。
 */
export function recoverFailedCredentials(params: {
  credentials: ViewCredential[]
  packageItem: MaterialPackage
  files: MaterialFile[]
  audit: AuditSink
  at: string
}): { credentials: ViewCredential[]; recovered: number; dropped: number } {
  const { credentials, packageItem, files, audit, at } = params
  const failed = credentials.filter(
    (item) => item.packageId === packageItem.id && item.status === 'write-failed',
  )
  if (!failed.length) return { credentials, recovered: 0, dropped: 0 }

  let recovered = 0
  let dropped = 0
  let next = credentials

  failed.forEach((failedCredential) => {
    const file = files.find((item) => item.id === failedCredential.fileId)
    const version = file?.versions.find((item) => item.id === file.referencedVersionId)
    const oldPageId = failedCredential.pageIds[0]
    const oldPage = file?.versions.flatMap((item) => item.pages).find((page) => page.id === oldPageId)
    const latestPage =
      version?.pages.find((page) => page.id === oldPageId) ??
      version?.pages.find((page) => page.page === oldPage?.page)

    let reason: CredentialInvalidReason | undefined
    if (!file || !version) reason = 'reference-version-changed'
    else if (!latestPage) reason = 'file-version-changed'
    else if (!latestPage.controlled) reason = 'controlled-flag-changed'
    else if (!latestPage.reviewedAt) reason = 'controlled-flag-changed'

    if (reason || !version || !latestPage) {
      dropped += 1
      next = next.map((item) =>
        item.id === failedCredential.id
          ? {
              ...item,
              status: 'invalidated',
              invalidReason: reason ?? 'file-version-changed',
              invalidatedAt: at,
              note: '恢复时按最新版本核对，未重新签发。',
            }
          : item,
      )
      return
    }

    const replacement = buildCredential({
      packageItem,
      fileId: file!.id,
      versionId: version.id,
      pageIds: [latestPage.id],
      source: 'recover',
      renewedFromId: failedCredential.id,
      note: '写入失败恢复后按最新引用版本重签。',
      issuedAt: at,
    })
    recovered += 1
    next = next.map((item) =>
      item.id === failedCredential.id
        ? {
            ...item,
            status: 'invalidated',
            invalidReason: 'superseded-renewal',
            invalidatedAt: at,
            renewedById: replacement.id,
          }
        : item,
    )
    next = [...next, replacement]
  })

  next = enforceSingleActive(next)
  audit({
    packageId: packageItem.id,
    action: '恢复查看凭证',
    target: `${recovered} 张重签 / ${dropped} 张作废`,
    operator: '系统',
    detail: '凭证写入失败后恢复，按最新引用版本与人员范围重新签发；已不再受控或无法定位的页不作恢复。',
  })
  return { credentials: next, recovered, dropped }
}

/** 撤回授权：旧凭证立刻被拒绝 */
export function revokeCredential(params: {
  credentials: ViewCredential[]
  credentialId: string
  audit: AuditSink
  at: string
}): ViewCredential[] {
  const { credentials, credentialId, audit, at } = params
  const target = credentials.find((item) => item.id === credentialId)
  if (!target) throw new Error('凭证不存在')
  audit({
    packageId: target.packageId,
    action: '撤回受控页授权',
    target: maskToken(target.token),
    operator: '当前用户',
    detail: '撤回授权后旧凭证立即失效，再次打开受控页将被拒绝。',
  })
  return credentials.map((item) =>
    item.id === credentialId
      ? {
          ...item,
          status: 'revoked',
          invalidReason: 'authorization-withdrawn',
          invalidatedAt: at,
        }
      : item,
  )
}

export interface VerifyResult {
  allowed: boolean
  reason?: string
  record: AccessRecord
}

/** 打开受控页时校验凭证，访问记录与审批状态一起追溯 */
export function verifyCredentialAccess(params: {
  credentials: ViewCredential[]
  token: string
  packageId: string
  fileId: string
  versionId: string
  pageId: string
  viewer: string
  files: MaterialFile[]
  packages: MaterialPackage[]
  at: string
}): VerifyResult {
  const { credentials, token, packageId, fileId, versionId, pageId, viewer, files, packages, at } = params
  const credential = credentials.find((item) => item.token === token.trim())
  const file = files.find((item) => item.id === fileId)
  const version = file?.versions.find((item) => item.id === versionId)
  const page = version?.pages.find((item) => item.id === pageId)

  const base = {
    id: `access-${crypto.randomUUID()}`,
    credentialId: credential?.id ?? 'unknown',
    token,
    packageId,
    fileId,
    versionId,
    pageId,
    page: page?.page,
    viewer,
    at,
  }

  const deny = (reason: string): VerifyResult => ({
    allowed: false,
    reason,
    record: { ...base, result: 'denied' as const, denyReason: reason },
  })

  if (!credential) return deny('凭证不存在或已被清除')
  if (credential.status === 'revoked') return deny('授权已撤回，旧凭证立即拒绝')
  if (credential.status === 'write-failed') return deny('凭证写入失败待恢复，请先恢复后再打开')
  if (credential.status === 'unconfirmed') return deny('旧数据回填凭证的人员范围待人工核对')
  if (credential.status === 'invalidated') {
    return deny(`凭证已失效（${invalidReasonLabels[credential.invalidReason ?? 'expired']}）`)
  }
  if (credential.packageId !== packageId || credential.fileId !== fileId) {
    return deny('凭证与资料包或文件不匹配')
  }
  if (credential.versionId !== versionId) {
    return deny('文件已换版，旧版本访问凭证拒绝打开现行页')
  }
  if (!credential.pageIds.includes(pageId)) return deny('凭证未覆盖该页')
  if (!page?.controlled) return deny('该页为一般页，不需要受控查看凭证')
  if (new Date(credential.expiresAt).getTime() <= new Date(at).getTime()) {
    return deny('短期凭证已到期')
  }

  const packageItem = packages.find((item) => item.id === packageId)
  if (packageItem?.needsRecheck) {
    return deny(`审批路线已退回待复核：${packageItem.needsRecheck.reason}`)
  }
  if (
    packageItem &&
    JSON.stringify([...packageItem.personnelScopes].sort()) !==
      JSON.stringify([...credential.personnelScopes].sort())
  ) {
    return deny('人员范围已调整，凭证立即失效')
  }
  if (credential.status !== 'active') return deny('凭证当前不可用')

  return {
    allowed: true,
    record: { ...base, result: 'granted' as const },
  }
}

/** 旧数据人工核对：确认范围后恢复有效；核对不通过则拒绝 */
export function reviewBackfilledCredential(params: {
  credentials: ViewCredential[]
  credentialId: string
  decision: 'confirm' | 'reject'
  comment: string
  audit: AuditSink
  at: string
}): ViewCredential[] {
  const { credentials, credentialId, decision, comment, audit, at } = params
  const target = credentials.find((item) => item.id === credentialId)
  if (!target) throw new Error('凭证不存在')
  if (target.status !== 'unconfirmed' && target.scopeConfidence !== 'unconfirmed') {
    throw new Error('该凭证无需人工核对')
  }
  audit({
    packageId: target.packageId,
    action: decision === 'confirm' ? '人工核对通过' : '人工核对拒绝',
    target: maskToken(target.token),
    operator: '当前用户',
    detail: `${comment || '无补充说明'}${decision === 'confirm' ? '，范围确认后凭证恢复有效。' : '，旧凭证保持拒绝。'}`,
  })
  return credentials.map((item) =>
    item.id === credentialId
      ? decision === 'confirm'
        ? {
            ...item,
            status: 'active',
            scopeConfidence: 'confirmed',
            note: `人工核对通过：${comment || '范围确认'}`,
            issuedAt: at,
            expiresAt: new Date(new Date(at).getTime() + CREDENTIAL_TTL_MS).toISOString(),
          }
        : {
            ...item,
            status: 'invalidated',
            scopeConfidence: 'confirmed',
            invalidReason: 'manual-reject',
            invalidatedAt: at,
            note: `人工核对拒绝：${comment || '范围无法确认'}`,
          }
      : item,
  )
}

/** 惰性到期：每次加载工作区时把已过有效期的凭证标记为到期 */
export function sweepExpiredCredentials(
  credentials: ViewCredential[],
  at = new Date().toISOString(),
): ViewCredential[] {
  const nowMs = new Date(at).getTime()
  return credentials.map((credential) =>
    credential.status === 'active' && new Date(credential.expiresAt).getTime() <= nowMs
      ? {
          ...credential,
          status: 'expired',
          invalidReason: 'expired',
          invalidatedAt: at,
        }
      : credential,
  )
}

/** 作废资料包下的有效凭证 */
export function invalidatePackageCredentials(params: {
  credentials: ViewCredential[]
  packageId: string
  reason: CredentialInvalidReason
  at: string
}): ViewCredential[] {
  const { credentials, packageId, reason, at } = params
  return credentials.map((credential) =>
    credential.packageId === packageId && credential.status === 'active'
      ? { ...credential, status: 'invalidated', invalidReason: reason, invalidatedAt: at }
      : credential,
  )
}

/** 作废文件现行/引用版本覆盖的有效凭证 */
export function invalidateFileCredentials(params: {
  credentials: ViewCredential[]
  fileId: string
  versionIds?: string[]
  reason: CredentialInvalidReason
  at: string
}): ViewCredential[] {
  const { credentials, fileId, versionIds, reason, at } = params
  return credentials.map((credential) => {
    if (credential.status !== 'active' || credential.fileId !== fileId) return credential
    if (versionIds && !versionIds.includes(credential.versionId)) return credential
    return { ...credential, status: 'invalidated', invalidReason: reason, invalidatedAt: at }
  })
}

/** 作废单页凭证（受控标记改变） */
export function invalidatePageCredentials(params: {
  credentials: ViewCredential[]
  fileId: string
  pageId: string
  reason: CredentialInvalidReason
  at: string
}): ViewCredential[] {
  const { credentials, fileId, pageId, reason, at } = params
  return credentials.map((credential) =>
    credential.status === 'active' &&
    credential.fileId === fileId &&
    credential.pageIds.includes(pageId)
      ? { ...credential, status: 'invalidated', invalidReason: reason, invalidatedAt: at }
      : credential,
  )
}

/**
 * 审批路线退回待复核：保留历史意见，路线重置到首步，资料包标记退回原因。
 * 未提交过（无路线）的草稿不触发。
 */
export function returnRouteToRecheck(params: {
  packageItem: MaterialPackage
  reason: string
  at: string
}): boolean {
  const { packageItem, reason, at } = params
  if (!packageItem.approvalRoute.length || packageItem.status === 'locked') return false
  packageItem.approvalRoute = packageItem.approvalRoute.map((step, index) => ({
    ...step,
    status: index === 0 ? ('active' as const) : ('recheck' as const),
  }))
  packageItem.needsRecheck = {
    reason,
    resetAt: at,
    round: packageItem.currentRound,
    fromStatus: packageItem.status,
  }
  packageItem.status = 'returned'
  packageItem.updatedAt = at
  return true
}

export function personnelScopesEqual(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

/**
 * 旧数据缺少凭证：按审批引用版本回填。
 * 受控页已完成核对的回填为有效凭证；页未核对导致范围无法确认的，回填为待人工核对。
 */
export function backfillCredentialsForLegacyState(params: {
  packages: MaterialPackage[]
  files: MaterialFile[]
  at: string
}): ViewCredential[] {
  const { packages, files, at } = params
  const created: ViewCredential[] = []
  packages
    .filter((packageItem) =>
      ['reviewing', 'returned', 'approved', 'licensed'].includes(packageItem.status),
    )
    .forEach((packageItem) => {
      files
        .filter((file) => file.packageId === packageItem.id)
        .forEach((file) => {
          const version =
            file.versions.find((item) => item.id === file.referencedVersionId) ??
            file.versions.find((item) => item.id === file.activeVersionId)
          if (!version) return
          version.pages
            .filter((page) => page.controlled)
            .forEach((page) => {
              const confirmed = Boolean(page.reviewedAt)
              created.push({
                ...buildCredential({
                  packageItem,
                  fileId: file.id,
                  versionId: version.id,
                  pageIds: [page.id],
                  source: 'backfill',
                  status: confirmed ? 'active' : 'unconfirmed',
                  confidence: confirmed ? 'confirmed' : 'unconfirmed',
                  note: confirmed
                    ? '旧数据迁移：按审批引用版本回填。'
                    : '旧数据迁移：受控页未完成核对，范围无法确认，待人工核对。',
                  issuedAt: at,
                }),
              })
            })
        })
    })
  return enforceSingleActive(created)
}

export function fileLabel(files: MaterialFile[], fileId: string) {
  return files.find((file) => file.id === fileId)?.name ?? fileId
}
