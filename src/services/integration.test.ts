import assert from 'node:assert'
import { webcrypto } from 'node:crypto'

// ---- 浏览器环境垫片 ----
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
}
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: new MemoryStorage(),
  setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    setTimeout(fn, ms, ...args) as unknown as number,
}
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

let passed = 0
function check(name: string, condition: boolean) {
  assert.ok(condition, name)
  passed += 1
  console.log(`✓ ${name}`)
}

const { configureStore } = await import('@reduxjs/toolkit')
const { workspaceApi: api } = await import('@/app/api')
type Workspace = {
  packages: any[]
  files: any[]
  rules: any[]
  findings: any[]
  comments: any[]
  audit: any[]
  credentials: any[]
  accessRecords: any[]
  backfilledAt?: string
}
const store = configureStore({
  reducer: { [api.reducerPath]: api.reducer },
  middleware: (getDefault) => getDefault().concat(api.middleware),
})

async function run<T>(thunk: any): Promise<T> {
  const result: any = await store.dispatch(thunk)
  if (result.error) {
    const message = result.error?.data?.error ?? result.error?.error ?? '操作失败'
    const err = new Error(message) as Error & { isError: true }
    err.isError = true
    throw err
  }
  return result.data as T
}

const e = api.endpoints
let ws = await run<Workspace>(e.resetWorkspace.initiate())

// 0. 旧数据迁移回填
const backfilledActive = ws.credentials.filter((c) => c.packageId === 'pkg-002' && c.status === 'active')
const backfilledPending = ws.credentials.filter((c) => c.packageId === 'pkg-003' && c.status === 'unconfirmed')
check('旧数据按引用版本回填有效凭证', backfilledActive.length >= 1 && backfilledActive[0].source === 'backfill')
check('范围无法确认（未核对）的回填为待人工核对', backfilledPending.length >= 1)
check('回填记录了 backfilledAt', Boolean(ws.backfilledAt))

// 1. pkg-001 切引用到未核对受控页的现行版本后，提交审批被凭证签发阻断
const file = ws.files.find((f) => f.id === 'file-001-a')
const v2 = file.versions.find((v: any) => v.id === file.activeVersionId)
ws = await run<Workspace>(e.setReferenceVersion.initiate({ fileId: file.id, versionId: v2.id }))
const blockMsg = await run(e.submitApproval.initiate({ packageId: 'pkg-001' })).then(
  () => '',
  (error: Error) => error.message,
)
check('受控页未核对时提交被阻断', /凭证签发被阻断/.test(blockMsg))

// 2. 核对 V1.1 受控页后提交 → 签发凭证
for (const page of v2.pages.filter((p: any) => p.controlled && !p.reviewedAt)) {
  ws = await run<Workspace>(e.savePageReview.initiate({
    fileId: file.id, versionId: v2.id,
    page: { ...page, reviewer: '当前用户', reviewedAt: new Date().toISOString() },
  }))
}
ws = await run<Workspace>(e.submitApproval.initiate({ packageId: 'pkg-001' }))
const issued = ws.credentials.filter((c) => c.packageId === 'pkg-001' && c.source === 'issue' && c.status === 'active')
check('提交审批为受控页签发凭证', issued.length === v2.pages.filter((p: any) => p.controlled).length)
check('提交后清除待复核标记', !ws.packages.find((p) => p.id === 'pkg-001').needsRecheck)

// 3. 有效凭证打开受控页放行 / 错误凭证拒绝
const cred = issued[0]
const page = v2.pages.find((p: any) => p.id === cred.pageIds[0])
const open: any = await run(e.accessControlledPage.initiate({
  token: cred.token, packageId: 'pkg-001', fileId: file.id, versionId: v2.id, pageId: page.id,
}))
check('有效凭证打开受控页放行', open.access.allowed === true)
ws = open.workspace
check('访问记录留痕', ws.accessRecords[0].result === 'granted')
const badOpen: any = await run(e.accessControlledPage.initiate({
  token: 'vc-not-exist', packageId: 'pkg-001', fileId: file.id, versionId: v2.id, pageId: page.id,
}))
check('错误凭证立即拒绝', badOpen.access.allowed === false)

// 4. 人员范围调整 → 凭证失效 + 退回待复核 + 旧凭证拒绝
ws = await run<Workspace>(e.savePackage.initiate({
  packageId: 'pkg-001', patch: { personnelScopes: ['外籍人员', '第三方承包商'] },
}))
const pkgAfterScope = ws.packages.find((p) => p.id === 'pkg-001')
const credAfterScope = ws.credentials.find((c) => c.id === cred.id)
check('人员范围变化后凭证失效', credAfterScope.status === 'invalidated' && credAfterScope.invalidReason === 'personnel-scope-changed')
check('人员范围变化后路线退回待复核', pkgAfterScope.status === 'returned' && Boolean(pkgAfterScope.needsRecheck))
check('退回原因包含人员范围', /人员范围/.test(pkgAfterScope.needsRecheck.reason))
const deniedScope: any = await run(e.accessControlledPage.initiate({
  token: cred.token, packageId: 'pkg-001', fileId: file.id, versionId: v2.id, pageId: page.id,
}))
check('旧凭证打开立即拒绝', deniedScope.access.allowed === false)

// 5. 重新提交 → 新凭证签发，待复核清除
ws = await run<Workspace>(e.submitApproval.initiate({ packageId: 'pkg-001' }))
check('补正后可重新提交', ws.packages.find((p) => p.id === 'pkg-001').status === 'reviewing')
const newCreds = ws.credentials.filter((c) => c.packageId === 'pkg-001' && c.status === 'active')
check('重新提交签发新凭证，旧凭证保持失效', newCreds.length === issued.length)

// 6. 文件换新版本 → 凭证失效 + 退回待复核
ws = await run<Workspace>(e.addFileVersion.initiate({
  packageId: 'pkg-001', fileId: file.id, label: 'V1.2', pageCount: v2.pages.length, summary: '集成测试换版',
}))
const pkgAfterVersion = ws.packages.find((p) => p.id === 'pkg-001')
check('文件换版后凭证失效', ws.credentials
  .filter((c) => c.packageId === 'pkg-001' && c.fileId === file.id)
  .every((c) => c.status !== 'active'))
check('文件换版后路线退回待复核', pkgAfterVersion.status === 'returned' && /现行版本变更/.test(pkgAfterVersion.needsRecheck.reason))

// 7. 受控标记改变 → 单页凭证失效 + 退回
const v3 = ws.files.find((f) => f.id === file.id).versions.find((v: any) => v.label === 'V1.2')
for (const p of v3.pages) {
  ws = await run<Workspace>(e.savePageReview.initiate({
    fileId: file.id, versionId: v3.id,
    page: { ...p, controlled: true, desensitized: true, reviewer: '当前用户', reviewedAt: new Date().toISOString() },
  }))
}
ws = await run<Workspace>(e.setReferenceVersion.initiate({ fileId: file.id, versionId: v3.id }))
ws = await run<Workspace>(e.submitApproval.initiate({ packageId: 'pkg-001' }))
const activeCred = ws.credentials.find((c) => c.fileId === file.id && c.status === 'active')
const targetPage = v3.pages.find((p: any) => p.id === activeCred.pageIds[0])
ws = await run<Workspace>(e.savePageReview.initiate({
  fileId: file.id, versionId: v3.id,
  page: { ...targetPage, controlled: false, desensitized: false, reviewer: '当前用户', reviewedAt: new Date().toISOString() },
}))
const toggledCred = ws.credentials.find((c) => c.id === activeCred.id)
const pkgAfterFlag = ws.packages.find((p) => p.id === 'pkg-001')
check('受控标记改变后该页凭证失效', toggledCred.status === 'invalidated' && toggledCred.invalidReason === 'controlled-flag-changed')
check('受控标记改变后路线退回待复核', pkgAfterFlag.status === 'returned' && /受控标记/.test(pkgAfterFlag.needsRecheck.reason))

// 8. 写入失败 → 访问拒绝 → 按最新版本恢复重签
ws = await run<Workspace>(e.savePageReview.initiate({
  fileId: file.id, versionId: v3.id,
  page: { ...targetPage, controlled: true, desensitized: true, reviewer: '当前用户', reviewedAt: new Date().toISOString() },
}))
ws = await run<Workspace>(e.submitApproval.initiate({ packageId: 'pkg-001' }))
const goodCred = ws.credentials.find((c) => c.fileId === file.id && c.status === 'active' && c.source === 'issue')
ws = await run<Workspace>(e.simulateCredentialWriteFailure.initiate({ credentialId: goodCred.id }))
check('凭证进入写入失败状态', ws.credentials.find((c) => c.id === goodCred.id).status === 'write-failed')
const failOpen: any = await run(e.accessControlledPage.initiate({
  token: goodCred.token, packageId: 'pkg-001', fileId: file.id, versionId: v3.id, pageId: goodCred.pageIds[0],
}))
check('写入失败凭证访问被拒绝', failOpen.access.allowed === false)
ws = await run<Workspace>(e.recoverCredentials.initiate({ packageId: 'pkg-001' }))
const recovered = ws.credentials.find((c) => c.source === 'recover' && c.status === 'active')
check('恢复后按最新版本重签', Boolean(recovered) && recovered.versionId === v3.id && recovered.renewedFromId === goodCred.id)

// 9. 撤回授权 → 旧凭证马上拒绝
ws = await run<Workspace>(e.revokeCredential.initiate({ credentialId: recovered.id }))
check('撤回后凭证状态为 revoked', ws.credentials.find((c) => c.id === recovered.id).status === 'revoked')
const revokedOpen: any = await run(e.accessControlledPage.initiate({
  token: recovered.token, packageId: 'pkg-001', fileId: file.id, versionId: v3.id, pageId: recovered.pageIds[0],
}))
check('撤回后旧凭证马上被拒绝', revokedOpen.access.allowed === false && /撤回/.test(revokedOpen.access.reason))

// 10. 双窗口并发续签：只保留一份有效
ws = await run<Workspace>(e.submitApproval.initiate({ packageId: 'pkg-001' }))
const renewTarget = ws.credentials.find((c) => c.fileId === file.id && c.status === 'active')
ws = await run<Workspace>(e.renewCredentialBatch.initiate({ credentialId: renewTarget.id }))
const sameBindingActive = ws.credentials.filter(
  (c) => c.fileId === file.id && c.versionId === renewTarget.versionId &&
    c.pageIds[0] === renewTarget.pageIds[0] && c.status === 'active',
)
check('两个窗口同时续签只保留一份有效凭证', sameBindingActive.length === 1)

// 11. 审计追溯（在重置演示数据前校验本轮全部留痕）
const actions = ws.audit.map((a) => a.action)
check('审计包含签发、退回、访问、撤回、续签等动作',
  actions.includes('签发查看凭证') &&
  actions.some((a) => a.includes('访问')) &&
  actions.some((a) => a.includes('退回待复核')) &&
  actions.includes('撤回受控页授权') &&
  actions.includes('并发续签演练'))

// 12. 人工核对回填凭证（基于重置后的旧数据）
ws = await run<Workspace>(e.resetWorkspace.initiate())
const pendingCred = ws.credentials.find((c) => c.status === 'unconfirmed')
ws = await run<Workspace>(e.reviewBackfilledCredential.initiate({
  credentialId: pendingCred.id, decision: 'confirm', comment: '已核对人员接触清单',
}))
check('人工核对通过后凭证恢复有效', ws.credentials.find((c) => c.id === pendingCred.id).status === 'active')
check('人工核对写入审计', ws.audit.some((a) => a.action === '人工核对通过'))

console.log(`\n端到端集成 ${passed} 项断言全部通过`)
process.exit(0)
