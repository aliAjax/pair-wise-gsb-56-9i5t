import assert from 'node:assert'
import { webcrypto } from 'node:crypto'
;(globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto

import type { AuditEntry, MaterialFile, MaterialPackage, PageReview, WorkspaceState } from '@/types/domain'
import {
  backfillCredentialsForLegacyState,
  collectControlledTargets,
  enforceSingleActive,
  invalidateFileCredentials,
  invalidatePackageCredentials,
  invalidatePageCredentials,
  issueCredentialsForSubmission,
  isCredentialActive,
  markCredentialWriteFailed,
  recoverFailedCredentials,
  renewCredential,
  returnRouteToRecheck,
  revokeCredential,
  verifyCredentialAccess,
} from '@/services/credentials'

type AuditSink = (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => void

let passed = 0
function check(name: string, condition: boolean) {
  assert.ok(condition, name)
  passed += 1
  console.log(`✓ ${name}`)
}

const auditLog: AuditEntry[] = []
const audit: AuditSink = (entry) =>
  auditLog.push({ ...entry, id: `audit-${auditLog.length}`, createdAt: '2026-10-06T00:00:00.000Z' })

function makePage(overrides: Partial<PageReview> = {}): PageReview {
  return {
    id: `page-${webcrypto.randomUUID()}`,
    page: 1,
    category: 'technical',
    controlled: true,
    desensitized: false,
    note: '',
    reviewer: '王合规',
    reviewedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeWorkspace(): { state: WorkspaceState; pkg: MaterialPackage; file: MaterialFile } {
  const controlled = makePage({ page: 1 })
  const normal = makePage({ page: 2, controlled: false, id: `page-${webcrypto.randomUUID()}` })
  const unreviewed = makePage({ page: 3, id: `page-${webcrypto.randomUUID()}`, reviewedAt: undefined, reviewer: '' })
  const file: MaterialFile = {
    id: 'file-1',
    packageId: 'pkg-1',
    name: '受控资料.pdf',
    kind: 'technical',
    activeVersionId: 'v1',
    referencedVersionId: 'v1',
    versions: [
      {
        id: 'v1',
        label: 'V1.0',
        uploadedAt: '2026-10-01T00:00:00.000Z',
        hash: 'AAAA',
        sizeKb: 100,
        pages: [controlled, normal, unreviewed],
        changeSummary: '',
      },
    ],
  }
  const pkg: MaterialPackage = {
    id: 'pkg-1',
    code: 'EC-1',
    title: '测试资料包',
    category: 'technical',
    applicant: '申请人',
    recipient: '外方',
    destination: '新加坡',
    endUse: '民用',
    technologyTags: [],
    personnelScopes: ['第三方承包商'],
    declarations: [],
    status: 'reviewing',
    approvalRoute: [
      { id: 's1', order: 1, role: '业务复核', assignee: '业务', level: 'standard', status: 'active', comment: '' },
      { id: 's2', order: 2, role: '合规审批', assignee: '合规', level: 'standard', status: 'waiting', comment: '' },
    ],
    currentRound: 1,
    quotaUsed: 0,
    quotaLimit: 100,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    versions: [],
  }
  const state: WorkspaceState = {
    packages: [pkg],
    files: [file],
    rules: [],
    findings: [],
    comments: [],
    audit: [],
    credentials: [],
    accessRecords: [],
  }
  return { state, pkg, file }
}

// 1. 提交审批：仅受控且已核对页签发；一般页不签；未核对受控页阻断
{
  const { state, pkg } = makeWorkspace()
  pkg.currentRound = 0
  const result = issueCredentialsForSubmission({
    credentials: state.credentials,
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:00:00.000Z',
  })
  check('未核对受控页阻断签发', result.blocked.length === 1)
  // 把第 3 页核对后，两个受控页都签发
  const version = state.files[0].versions[0]
  version.pages[2] = { ...version.pages[2], reviewedAt: '2026-10-06T00:00:00.000Z' }
  const ok = issueCredentialsForSubmission({
    credentials: [],
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:00:00.000Z',
  })
  check('受控页逐页签发两张凭证', ok.created.length === 2)
  check('一般页不签凭证', ok.created.every((c) => c.pageIds.length === 1))
  const allPages = new Set(ok.created.flatMap((c) => c.pageIds))
  check('凭证只覆盖受控页', !allPages.has(version.pages[1].id))
  check('凭证绑定人员范围', ok.created.every((c) => c.personnelScopes[0] === '第三方承包商'))
  check('凭证有效期 30 分钟', ok.created.every(
    (c) => new Date(c.expiresAt).getTime() - new Date(c.issuedAt).getTime() === 30 * 60 * 1000,
  ))
}

// 2. 有效凭证可以打开受控页；错误版本/范围/撤回均拒绝
{
  const { state, pkg } = makeWorkspace()
  const version = state.files[0].versions[0]
  version.pages[2] = { ...version.pages[2], reviewedAt: '2026-10-06T00:00:00.000Z' }
  const issued = issueCredentialsForSubmission({
    credentials: [],
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:00:00.000Z',
  })
  const credential = issued.created[0]
  state.credentials = issued.credentials
  const allowed = verifyCredentialAccess({
    credentials: state.credentials,
    token: credential.token,
    packageId: pkg.id,
    fileId: state.files[0].id,
    versionId: version.id,
    pageId: version.pages[0].id,
    viewer: '审批人',
    files: state.files,
    packages: state.packages,
    at: '2026-10-06T00:05:00.000Z',
  })
  check('有效凭证打开受控页放行', allowed.allowed)

  // 用旧 token 打开现行页（换版）
  const deniedVersion = verifyCredentialAccess({
    credentials: state.credentials,
    token: credential.token,
    packageId: pkg.id,
    fileId: state.files[0].id,
    versionId: 'v2',
    pageId: version.pages[0].id,
    viewer: '审批人',
    files: state.files,
    packages: state.packages,
    at: '2026-10-06T00:05:00.000Z',
  })
  check('换版后旧凭证被拒绝', !deniedVersion.allowed && /换版/.test(deniedVersion.reason ?? ''))

  // 人员范围变化 + 待复核
  state.credentials = invalidatePackageCredentials({
    credentials: state.credentials,
    packageId: pkg.id,
    reason: 'personnel-scope-changed',
    at: '2026-10-06T00:06:00.000Z',
  })
  pkg.personnelScopes = ['外籍人员']
  returnRouteToRecheck({ packageItem: pkg, reason: '人员范围调整', at: '2026-10-06T00:06:00.000Z' })
  const deniedScope = verifyCredentialAccess({
    credentials: state.credentials,
    token: credential.token,
    packageId: pkg.id,
    fileId: state.files[0].id,
    versionId: version.id,
    pageId: version.pages[0].id,
    viewer: '审批人',
    files: state.files,
    packages: state.packages,
    at: '2026-10-06T00:07:00.000Z',
  })
  check('人员范围变化凭证立即失效', !deniedScope.allowed)
  check('路线退回待复核：首步 active，其余 recheck', pkg.status === 'returned' &&
    pkg.approvalRoute[0].status === 'active' && pkg.approvalRoute[1].status === 'recheck')
  check('退回原因留痕', Boolean(pkg.needsRecheck) && /人员范围/.test(pkg.needsRecheck!.reason))
}

// 3. 文件现行版本变化 / 受控标记变化
{
  const { state, pkg, file } = makeWorkspace()
  state.files[0].versions[0].pages[2] = { ...state.files[0].versions[0].pages[2], reviewedAt: '2026-10-06T00:00:00.000Z' }
  const issued = issueCredentialsForSubmission({
    credentials: [],
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:00:00.000Z',
  })
  state.credentials = issued.credentials
  const v1 = file.versions[0]

  // 受控标记改变：一般→受控 或 受控→一般 都作废该页
  state.credentials = invalidatePageCredentials({
    credentials: state.credentials,
    fileId: file.id,
    pageId: v1.pages[0].id,
    reason: 'controlled-flag-changed',
    at: '2026-10-06T01:00:00.000Z',
  })
  const pageCred = state.credentials.find((c) => c.pageIds.includes(v1.pages[0].id))
  check('受控标记改变单页凭证失效', pageCred?.status === 'invalidated')

  // 上传新版本：文件下凭证全部失效
  state.credentials = invalidateFileCredentials({
    credentials: state.credentials.map((c) =>
      c.status === 'invalidated' ? { ...c, status: 'active' } : c,
    ),
    fileId: file.id,
    reason: 'file-version-changed',
    at: '2026-10-06T01:00:00.000Z',
  })
  check('换版后文件全部凭证失效', state.credentials.every((c) => c.status === 'invalidated'))
}

// 4. 续签：仅有效凭证可续；并发续签只保留一份
{
  const { state, pkg } = makeWorkspace()
  state.files[0].versions[0].pages[2] = { ...state.files[0].versions[0].pages[2], reviewedAt: '2026-10-06T00:00:00.000Z' }
  const issued = issueCredentialsForSubmission({
    credentials: [],
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:00:00.000Z',
  })
  const original = issued.created[0]
  let credentials = issued.credentials

  // 两个窗口同时（同一时刻、同一基准状态）提交续签
  const at = '2026-10-06T00:10:00.000Z'
  const a = renewCredential({
    credentials,
    credentialId: original.id,
    packageItem: pkg,
    files: state.files,
    audit,
    at,
  })
  const b = renewCredential({
    credentials,
    credentialId: original.id,
    packageItem: pkg,
    files: state.files,
    audit,
    at,
  })
  // 两张新凭证绑定完全相同：enforceSingleActive 去重只保留最新一份
  credentials = enforceSingleActive([...a.credentials, ...b.credentials.filter((c) => c.id !== a.renewed.id)])
  check('并发续签产生同绑定新凭证', a.renewed.renewedFromId === original.id && b.renewed.renewedFromId === original.id)
  const bindingActive = credentials.filter(
    (c) =>
      c.status === 'active' &&
      c.fileId === original.fileId &&
      c.versionId === original.versionId &&
      c.pageIds[0] === original.pageIds[0],
  )
  check('同一绑定只保留一份有效凭证', bindingActive.length === 1)
  check('原凭证标记续签作废', credentials.find((c) => c.id === original.id)?.status === 'invalidated')

  // 已失效凭证不能再续签
  let rejected = false
  try {
    renewCredential({
      credentials,
      credentialId: original.id,
      packageItem: pkg,
      files: state.files,
      audit,
      at: '2026-10-06T00:11:00.000Z',
    })
  } catch {
    rejected = true
  }
  check('旧凭证续签被拒绝', rejected)

  // 到期凭证不可续签
  const expired = enforceSingleActive([
    ...credentials.map((c) => (c.id === a.renewed.id ? { ...c, expiresAt: '2026-10-06T00:05:00.000Z' } : c)),
  ])
  let expiredRejected = false
  try {
    renewCredential({
      credentials: expired,
      credentialId: a.renewed.id,
      packageItem: pkg,
      files: state.files,
      audit,
      at: '2026-10-06T00:20:00.000Z',
    })
  } catch {
    expiredRejected = true
  }
  check('到期凭证续签被拒绝', expiredRejected)
  check('isCredentialActive 到期判定', !isCredentialActive(a.renewed, '2026-10-06T00:41:00.000Z'))
}

// 5. 写入失败后恢复：按最新版本重签；最新版本不再受控则作废
{
  const { state, pkg, file } = makeWorkspace()
  state.files[0].versions[0].pages[2] = { ...state.files[0].versions[0].pages[2], reviewedAt: '2026-10-06T00:00:00.000Z' }
  const issued = issueCredentialsForSubmission({
    credentials: [],
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:00:00.000Z',
  })
  let credentials = issued.credentials
  const target = issued.created[0]
  credentials = markCredentialWriteFailed({
    credentials,
    credentialId: target.id,
    at: '2026-10-06T00:05:00.000Z',
  })
  check('写入失败标记', credentials.find((c) => c.id === target.id)?.status === 'write-failed')
  check('写入失败凭证被拒绝访问', !verifyCredentialAccess({
    credentials,
    token: target.token,
    packageId: pkg.id,
    fileId: file.id,
    versionId: file.referencedVersionId,
    pageId: target.pageIds[0],
    viewer: '审批人',
    files: state.files,
    packages: state.packages,
    at: '2026-10-06T00:05:30.000Z',
  }).allowed)

  // 恢复：同页仍受控 → 重签
  const recovered = recoverFailedCredentials({
    credentials,
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:06:00.000Z',
  })
  check('恢复重签 1 张', recovered.recovered === 1)
  const replacement = recovered.credentials.find(
    (c) => c.source === 'recover' && c.status === 'active',
  )
  check('新凭证按最新版本签发且关联旧凭证', Boolean(replacement) && replacement!.renewedFromId === target.id)

  // 再次模拟失败 + 新版本中该页改为一般页
  let credentials2 = markCredentialWriteFailed({
    credentials: recovered.credentials,
    credentialId: replacement!.id,
    at: '2026-10-06T00:10:00.000Z',
  })
  const v1 = file.versions[0]
  const page = v1.pages.find((p) => p.id === replacement!.pageIds[0])!
  const v2 = {
    ...v1,
    id: 'v2',
    label: 'V2.0',
    pages: v1.pages.map((p) => (p.id === page.id ? { ...p, controlled: false } : p)),
  }
  file.versions.push(v2)
  file.activeVersionId = 'v2'
  file.referencedVersionId = 'v2'
  const dropped = recoverFailedCredentials({
    credentials: credentials2,
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:11:00.000Z',
  })
  check('最新版本不再受控时不恢复并作废', dropped.recovered === 0 && dropped.dropped === 1)
  check('无待恢复时幂等', recoverFailedCredentials({
    credentials: dropped.credentials,
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:12:00.000Z',
  }).recovered === 0)
  void credentials2
}

// 6. 撤回授权：旧凭证马上拒绝
{
  const { state, pkg, file } = makeWorkspace()
  state.files[0].versions[0].pages[2] = { ...state.files[0].versions[0].pages[2], reviewedAt: '2026-10-06T00:00:00.000Z' }
  const issued = issueCredentialsForSubmission({
    credentials: [],
    packageItem: pkg,
    files: state.files,
    audit,
    at: '2026-10-06T00:00:00.000Z',
  })
  const target = issued.created[0]
  const credentials = revokeCredential({
    credentials: issued.credentials,
    credentialId: target.id,
    audit,
    at: '2026-10-06T00:05:00.000Z',
  })
  const result = verifyCredentialAccess({
    credentials,
    token: target.token,
    packageId: pkg.id,
    fileId: file.id,
    versionId: file.referencedVersionId,
    pageId: target.pageIds[0],
    viewer: '审批人',
    files: state.files,
    packages: state.packages,
    at: '2026-10-06T00:05:30.000Z',
  })
  check('撤回后旧凭证立即拒绝', !result.allowed && /撤回/.test(result.reason ?? ''))
}

// 7. 旧数据回填：已核对→有效；未核对→待人工核对
{
  const { state, pkg } = makeWorkspace()
  const backfilled = backfillCredentialsForLegacyState({
    packages: state.packages,
    files: state.files,
    at: '2026-10-06T00:00:00.000Z',
  })
  // 第 1 页受控已核对 → active；第 3 页受控未核对 → unconfirmed
  const v1 = state.files[0].versions[0]
  const confirmed = backfilled.find((c) => c.pageIds[0] === v1.pages[0].id)
  const pending = backfilled.find((c) => c.pageIds[0] === v1.pages[2].id)
  check('已核对受控页回填为有效', confirmed?.status === 'active' && confirmed?.source === 'backfill')
  check('未核对受控页回填待人工核对', pending?.status === 'unconfirmed')
  check('一般页不回填', backfilled.length === 2)

  // 草稿包不回填
  pkg.status = 'draft'
  check('草稿包不回填凭证', backfillCredentialsForLegacyState({
    packages: state.packages,
    files: state.files,
    at: '2026-10-06T00:00:00.000Z',
  }).length === 0)

  // collectControlledTargets 只取已核对受控页
  pkg.status = 'reviewing'
  const targets = collectControlledTargets(pkg, state.files)
  check('受控目标只含已核对页', targets[0]?.pages.length === 1)
}

console.log(`\n全部 ${passed} 项核心规则断言通过`)
