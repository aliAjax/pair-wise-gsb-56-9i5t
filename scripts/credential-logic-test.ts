import {
  backfillCredentialsForLegacyState,
  checkPageAccess,
  createAuditSink,
  effectiveStatus,
  invalidatePackageCredentials,
  issueCredentialsForSubmission,
  markCredentialWriteFailed,
  recoverCredential,
  renewCredential,
  resolveScopeCheck,
  revokeCredentials,
  SCHEMA_VERSION,
} from '@/services/credentials'
import { createApprovalRoute } from '@/services/rules'
import type { MaterialFile, MaterialPackage, WorkspaceState } from '@/types/domain'

let passed = 0
let failed = 0
function assert(condition: boolean, message: string) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const iso = (offsetMin: number) =>
  new Date(Date.UTC(2026, 9, 6, 8, offsetMin, 0)).toISOString()

function makeState(): WorkspaceState {
  const pages = [
    { id: 'p1', page: 1, category: 'technical' as const, controlled: false, desensitized: false, note: '', reviewer: 'r', reviewedAt: iso(0) },
    { id: 'p2', page: 2, category: 'technical' as const, controlled: true, desensitized: true, note: '', reviewer: 'r', reviewedAt: iso(0) },
    { id: 'p3', page: 3, category: 'technical' as const, controlled: true, desensitized: false, note: '', reviewer: 'r', reviewedAt: iso(0) },
  ]
  const file: MaterialFile = {
    id: 'file-1',
    packageId: 'pkg-1',
    name: '受控工艺.pdf',
    kind: 'technical',
    activeVersionId: 'v1',
    referencedVersionId: 'v1',
    versions: [
      { id: 'v1', label: 'V1.0', uploadedAt: iso(0), hash: 'AAA', sizeKb: 100, pages, changeSummary: '初始' },
    ],
  }
  const file2: MaterialFile = {
    id: 'file-2',
    packageId: 'pkg-1',
    name: '一般说明.pdf',
    kind: 'technical',
    activeVersionId: 'g1',
    referencedVersionId: 'g1',
    versions: [
      {
        id: 'g1', label: 'V1.0', uploadedAt: iso(0), hash: 'BBB', sizeKb: 50,
        pages: [{ id: 'gp1', page: 1, category: 'technical' as const, controlled: false, desensitized: false, note: '', reviewer: '', reviewedAt: iso(0) }],
        changeSummary: '',
      },
    ],
  }
  const pkg: MaterialPackage = {
    id: 'pkg-1',
    code: 'EC-T1',
    title: '测试包',
    category: 'technical',
    applicant: '甲',
    recipient: '境外方',
    destination: '新加坡',
    endUse: '测试',
    technologyTags: [],
    personnelScopes: ['第三方承包商'],
    declarations: [],
    status: 'reviewing',
    approvalRoute: createApprovalRoute('standard'),
    currentRound: 1,
    quotaUsed: 0,
    quotaLimit: 100,
    createdAt: iso(0),
    updatedAt: iso(0),
    versions: [
      {
        id: 'pv1', label: 'V1.0', createdAt: iso(0), createdBy: '甲', summary: '',
        snapshot: {
          title: '测试包', category: 'technical', destination: '新加坡', endUse: '测试',
          technologyTags: [], personnelScopes: ['第三方承包商'], declarations: [],
          activeFileVersions: { 'file-1': 'v1', 'file-2': 'g1' },
        },
      },
    ],
  }
  return {
    packages: [pkg], files: [file, file2], rules: [], findings: [], comments: [],
    audit: [], credentials: [], accessRecords: [], scopeManualChecks: [], schemaVersion: SCHEMA_VERSION,
  }
}

// 场景 1：提交审批只给受控页签凭证，一般页不签
{
  const state = makeState()
  const pkg = state.packages[0]
  const issued = issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  assert(issued.length === 1, '提交审批：仅 1 个含受控页的文件获得凭证（一般页文件不签）')
  assert(issued[0].controlledPages.join() === '2,3', '凭证覆盖引用版本的第 2、3 受控页')
  assert(JSON.stringify(issued[0].personnelScopes) === JSON.stringify(['第三方承包商']), '凭证绑定签发时人员范围快照')
  assert(effectiveStatus(issued[0], iso(10)) === 'active', '10 分钟后凭证仍有效')
  assert(effectiveStatus(issued[0], iso(31)) === 'expired', '30 分钟后凭证到期')

  const accessGeneral = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-2', page: 1, atIso: iso(1) })
  assert(accessGeneral.record.result === 'granted' && !accessGeneral.record.credentialId, '一般页不查凭证直接放行')
  const accessControlled = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 2, atIso: iso(1) })
  assert(accessControlled.record.result === 'granted' && Boolean(accessControlled.record.credentialId), '受控页凭有效凭证放行并记录凭证号')
}

// 场景 2：人员范围变化 → 凭证立即失效 + 路线退回待复核
{
  const state = makeState()
  const pkg = state.packages[0]
  issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  invalidatePackageCredentials(state, pkg, {
    trigger: 'personnel', target: pkg.code, detail: '人员范围调整', recheck: true, atIso: iso(2),
  })
  assert(state.credentials.every((c) => c.status === 'invalidated'), '人员范围变化：凭证全部失效')
  assert(pkg.status === 'recheck', '审批状态变为待复核')
  assert(pkg.approvalRoute[0].status === 'active' && pkg.approvalRoute.slice(1).every((s) => s.status === 'waiting'), '审批路线重置：第一步活动，其余等待')
  const denied = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 2, atIso: iso(2) })
  assert(denied.record.result === 'denied', '旧凭证立即被拒绝')
  assert(state.accessRecords[0].deniedReason?.includes('已变更') ?? false, '拒绝原因说明版本/范围已变更')
}

// 场景 3：文件换版 → 失效 + 待复核；按最新版本重新提交签发
{
  const state = makeState()
  const pkg = state.packages[0]
  const file = state.files[0]
  issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  invalidatePackageCredentials(state, pkg, {
    trigger: 'version', target: file.name, detail: '文件现行版本更新', recheck: true, fileIds: [file.id], atIso: iso(2),
  })
  assert(state.credentials.every((c) => c.status === 'invalidated'), '文件现行版本变化：旧凭证失效')
  assert(pkg.status === 'recheck', '换版后退回待复核')
  // 重新提交：引用新版本
  file.versions.push({
    id: 'v2', label: 'V2.0', uploadedAt: iso(2), hash: 'CCC', sizeKb: 110,
    pages: [
      { id: 'n1', page: 1, category: 'technical', controlled: true, desensitized: false, note: '', reviewer: '', reviewedAt: iso(2) },
      { id: 'n2', page: 2, category: 'technical', controlled: false, desensitized: false, note: '', reviewer: '', reviewedAt: iso(2) },
    ],
    changeSummary: '换版',
  })
  file.activeVersionId = 'v2'
  file.referencedVersionId = 'v2'
  pkg.status = 'reviewing'
  pkg.currentRound = 2
  const reissued = issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 2, atIso: iso(3) })
  assert(reissued.length === 1 && reissued[0].versionId === 'v2', '重新提交按最新引用版本 V2.0 签发')
  assert(reissued[0].controlledPages.join() === '1', '新凭证只覆盖 V2.0 第 1 受控页')
  const ok = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 1, atIso: iso(4) })
  assert(ok.record.result === 'granted', '新版本受控页凭新凭证放行')
}

// 场景 4：受控标记改变 → 该版本凭证失效 + 待复核
{
  const state = makeState()
  const pkg = state.packages[0]
  issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  invalidatePackageCredentials(state, pkg, {
    trigger: 'controlled', target: 'file-1', detail: '第 2 页受控标记改变', recheck: true,
    fileIds: ['file-1'], versionIds: ['v1'], atIso: iso(2),
  })
  assert(state.credentials.every((c) => c.status === 'invalidated'), '受控标记改变：凭证失效')
  assert(pkg.status === 'recheck', '受控标记改变后退回待复核')
}

// 场景 5：两个窗口同时续签，只保留仍有效的一份
{
  const state = makeState()
  const pkg = state.packages[0]
  issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  const a = renewCredential(state, 'pkg-1', 'file-1', createAuditSink(state), { nonce: 'A', atIso: iso(10), operator: '窗口 A' })
  const b = renewCredential(state, 'pkg-1', 'file-1', createAuditSink(state), { nonce: 'B', atIso: iso(10), operator: '窗口 B' })
  assert(!a.duplicated && b.duplicated, '窗口 A 先签发，窗口 B 识别为重复续签')
  assert(b.credential?.id === a.credential?.id, '第二次续签返回的仍是先签发的一份')
  const active = state.credentials.filter((c) => effectiveStatus(c, iso(10)) === 'active')
  assert(active.length === 1, '同一目标最终只有 1 份有效凭证')
  assert(state.credentials.find((c) => c.id === a.credential?.id)?.status === 'active', '保留的凭证仍为有效')
}

// 场景 6：写入失败 → 按最新版本恢复重签
{
  const state = makeState()
  const pkg = state.packages[0]
  const issued = issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  markCredentialWriteFailed(state, issued[0].id, createAuditSink(state), { atIso: iso(5) })
  const denied = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 2, atIso: iso(5) })
  assert(denied.record.result === 'denied' && denied.record.deniedReason?.includes('写入失败'), '写入失败的凭证被拒绝')
  const recovered = recoverCredential(state, issued[0].id, createAuditSink(state), { atIso: iso(6) })
  assert(recovered.issueSource === 'recovery' && recovered.versionId === 'v1', '按最新版本恢复重签')
  const ok = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 2, atIso: iso(6) })
  assert(ok.record.result === 'granted', '恢复后受控页可访问')
  assert(state.credentials.find((c) => c.id === issued[0].id)?.status === 'superseded', '原失败凭证标记为已替换，保留追溯')
}

// 场景 7：撤回授权后旧凭证马上被拒绝
{
  const state = makeState()
  const pkg = state.packages[0]
  issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  const count = revokeCredentials(state, 'pkg-1', createAuditSink(state), { atIso: iso(3) })
  assert(count === 1, '撤回命中 1 份有效凭证')
  const denied = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 2, atIso: iso(3) })
  assert(denied.record.result === 'denied' && denied.record.deniedReason?.includes('撤回'), '撤回后旧凭证立即拒绝')
  assert(pkg.status === 'recheck', '审批中撤回授权，路线退回待复核')
}

// 场景 8：旧数据按引用版本回填；范围无法确认的列待人工核对
{
  const state = makeState()
  state.credentials = []
  // file-1 在快照中可确认范围；再构造一个快照中找不到的文件
  const orphan: MaterialFile = {
    id: 'file-3', packageId: 'pkg-1', name: '历史补页.pdf', kind: 'technical',
    activeVersionId: 'o2', referencedVersionId: 'o1',
    versions: [
      { id: 'o1', label: 'V0.9', uploadedAt: iso(0), hash: 'DDD', sizeKb: 30,
        pages: [{ id: 'op', page: 1, category: 'technical', controlled: true, desensitized: false, note: '', reviewer: '', reviewedAt: iso(0) }],
        changeSummary: '' },
      { id: 'o2', label: 'V1.0', uploadedAt: iso(1), hash: 'EEE', sizeKb: 30,
        pages: [{ id: 'op2', page: 1, category: 'technical', controlled: true, desensitized: false, note: '', reviewer: '', reviewedAt: iso(1) }],
        changeSummary: '' },
    ],
  }
  state.files.push(orphan)
  const result = backfillCredentialsForLegacyState(state, { nowIso: iso(2) })
  assert(result.backfilled === 2 && result.manual === 1, '回填 2 份凭证，其中 1 份人员范围待人工核对')
  const normal = state.credentials.find((c) => c.fileId === 'file-1')
  assert(normal?.status === 'expired', '可确认范围的回填凭证不延续访问权（已到期）')
  const pending = state.credentials.find((c) => c.fileId === 'file-3')
  assert(pending?.status === 'manual-check', '范围无法确认的凭证列为待人工核对')
  assert(state.scopeManualChecks.length === 1 && state.scopeManualChecks[0].status === 'pending', '生成 1 条待人工核对记录')
  const denied = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-3', page: 1, atIso: iso(3) })
  assert(denied.record.result === 'denied' && denied.record.deniedReason?.includes('人工核对'), '待核对凭证访问被拒绝')

  resolveScopeCheck(state, state.scopeManualChecks[0].id, ['外籍人员'], createAuditSink(state), { atIso: iso(4), note: '依据历史接触清单确认' })
  assert(state.scopeManualChecks[0].status === 'resolved', '人工核对完成')
  assert(pending?.status === 'invalidated', '回填凭证核对后作废，需重新提交签发')
  assert(state.packages[0].status === 'recheck', '核对后审批退回待复核')
}

// 场景 9：访问记录与审计一起追溯
{
  const state = makeState()
  const pkg = state.packages[0]
  issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 2, atIso: iso(1) })
  revokeCredentials(state, 'pkg-1', createAuditSink(state), { atIso: iso(2) })
  checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 2, atIso: iso(2) })
  assert(state.accessRecords.length === 2, '访问记录完整保留放行与拒绝各 1 条')
  assert(state.accessRecords[0].result === 'denied' && state.accessRecords[1].result === 'granted', '最新拒绝记录在前')
  assert(state.audit.some((a) => a.action === '受控页访问拒绝'), '拒绝访问写入审计，可与审批状态一起追溯')
  assert(state.audit.some((a) => a.action === '签发查看凭证'), '签发凭证写入审计')
  assert(state.audit.some((a) => a.action === '撤回查看授权'), '撤回授权写入审计')
}

// 场景 10：待复核修复后重新提交，旧凭证替换为按最新版本的新凭证
{
  const state = makeState()
  const pkg = state.packages[0]
  const file = state.files[0]
  const first = issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  invalidatePackageCredentials(state, pkg, {
    trigger: 'personnel', target: pkg.code, detail: '人员范围调整', recheck: true, atIso: iso(2),
  })
  assert(state.credentials.find((c) => c.id === first[0].id)?.status === 'invalidated', '第一轮凭证已失效')
  // 业务修正：调整人员范围、换版并对齐引用，重新提交
  pkg.personnelScopes = ['外籍人员']
  file.versions.push({
    id: 'v2', label: 'V2.0', uploadedAt: iso(3), hash: 'FFF', sizeKb: 110,
    pages: [
      { id: 'q1', page: 1, category: 'technical', controlled: true, desensitized: true, note: '', reviewer: '', reviewedAt: iso(3) },
    ],
    changeSummary: '换版',
  })
  file.activeVersionId = 'v2'
  file.referencedVersionId = 'v2'
  pkg.status = 'reviewing'
  pkg.currentRound = 2
  const second = issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 2, atIso: iso(4) })
  assert(second.length === 1 && second[0].versionId === 'v2', '第二轮按最新版本 V2.0 签发')
  assert(JSON.stringify(second[0].personnelScopes) === JSON.stringify(['外籍人员']), '新凭证绑定调整后的人员范围')
  const active = state.credentials.filter((c) => effectiveStatus(c, iso(4)) === 'active')
  assert(active.length === 1 && active[0].id === second[0].id, '重新提交后只有一份有效凭证')
  const ok = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 1, atIso: iso(5) })
  assert(ok.record.result === 'granted', '新受控页凭第二轮凭证放行')
}

// 场景 11：续签幂等窗口外允许正常续签；旧凭证保留为已替换可追溯
{
  const state = makeState()
  const pkg = state.packages[0]
  const first = issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  const renewed = renewCredential(state, 'pkg-1', 'file-1', createAuditSink(state), { atIso: iso(10) })
  assert(!renewed.duplicated, '窗口外首次续签正常签发')
  const late = renewCredential(state, 'pkg-1', 'file-1', createAuditSink(state), { atIso: iso(20) })
  assert(!late.duplicated, '超过 5 秒幂等窗口的续签正常重新签发')
  assert(state.credentials.find((c) => c.id === first[0].id)?.status === 'superseded', '最初凭证标记为已替换')
  assert(state.credentials.find((c) => c.id === renewed.credential?.id)?.status === 'superseded', '被后续续签替换的凭证也保留为已替换')
  assert(state.credentials.filter((c) => effectiveStatus(c, iso(20)) === 'active').length === 1, '始终只有一份有效凭证')
}

// 场景 12：撤回单个文件不影响同包其他文件的凭证
{
  const state = makeState()
  const pkg = state.packages[0]
  // 给第二个文件也制造受控页
  const file2 = state.files[1]
  file2.versions[0].pages.push({ id: 'gp2', page: 2, category: 'technical', controlled: true, desensitized: false, note: '', reviewer: '', reviewedAt: iso(0) })
  const issued = issueCredentialsForSubmission(state, pkg, createAuditSink(state), { round: 1, atIso: iso(0) })
  assert(issued.length === 2, '两个含受控页文件各有凭证')
  revokeCredentials(state, 'pkg-1', createAuditSink(state), { fileId: 'file-1', atIso: iso(2) })
  const denied = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-1', page: 2, atIso: iso(2) })
  const granted = checkPageAccess(state, { packageId: 'pkg-1', fileId: 'file-2', page: 2, atIso: iso(2) })
  assert(denied.record.result === 'denied', '被撤回文件的受控页立即拒绝')
  assert(granted.record.result === 'granted', '同包其他文件凭证仍然有效')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed) process.exit(1)
