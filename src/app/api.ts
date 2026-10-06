import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  AccessRecord,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  invalidateFileCredentials,
  invalidatePageCredentials,
  invalidatePackageCredentials,
  issueCredentialsForSubmission,
  markCredentialWriteFailed,
  personnelScopesEqual,
  recoverFailedCredentials,
  renewCredential,
  returnRouteToRecheck,
  reviewBackfilledCredential,
  revokeCredential,
  verifyCredentialAccess,
} from '@/services/credentials'

/** 同一份凭证的并发续签请求合并，保证两个窗口同时续签只保留一份有效凭证 */
const inflightRenewals = new Map<string, Promise<unknown>>()

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({
  url,
  body,
}) => {
  await wait()
  let state = loadWorkspace()
  const payload = (body ?? {}) as Record<string, unknown>
  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }

  try {
    if (url === '/workspace') return { data: state }

    if (url === '/package/save') {
      const packageId = String(payload.packageId)
      const patch = payload.patch as Partial<MaterialPackage>
      const current = state.packages.find((item) => item.id === packageId)
      if (!current) throw new Error('资料包不存在')
      const previousScopes = [...current.personnelScopes]
      Object.assign(current, patch, { updatedAt: now() })
      current.matchedRuleId = findApplicableRule(current, state.rules)?.id
      audit({
        packageId,
        action: '更新资料包',
        target: current.code,
        operator: '当前用户',
        detail: '更新收件方、最终用途、声明或技术参数。',
      })
      if (
        patch.personnelScopes &&
        !personnelScopesEqual(previousScopes, current.personnelScopes)
      ) {
        state.credentials = invalidatePackageCredentials({
          credentials: state.credentials,
          packageId,
          reason: 'personnel-scope-changed',
          at: now(),
        })
        const reason = `人员范围由「${previousScopes.join('、') || '不限制'}」调整为「${
          current.personnelScopes.join('、') || '不限制'
        }」，受控页查看凭证立即失效，审批路线退回待复核。`
        if (
          returnRouteToRecheck({ packageItem: current, reason, at: now() })
        ) {
          audit({
            packageId,
            action: '审批退回待复核',
            target: current.code,
            operator: '系统',
            detail: reason,
          })
        }
      }
    } else if (url === '/package/create') {
      const draft = payload.package as Omit<
        MaterialPackage,
        'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
      >
      const rule = findApplicableRule(
        { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, createdAt: '', updatedAt: '' },
        state.rules,
      )
      const packageItem: MaterialPackage = {
        ...draft,
        id: `pkg-${crypto.randomUUID()}`,
        matchedRuleId: rule?.id,
        approvalRoute: [],
        currentRound: 0,
        createdAt: now(),
        updatedAt: now(),
        versions: [],
      }
      packageItem.versions.push({
        id: `version-${crypto.randomUUID()}`,
        label: 'V1.0',
        createdAt: now(),
        createdBy: packageItem.applicant,
        summary: '创建资料包初始版本。',
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: {},
        },
      })
      state.packages.unshift(packageItem)
      audit({
        packageId: packageItem.id,
        action: '创建资料包',
        target: packageItem.code,
        operator: packageItem.applicant,
        detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}。`,
      })
    } else if (url === '/file/save') {
      const file = payload.file as MaterialFile
      const previous = state.files.find((item) => item.id === file.id)
      const index = state.files.findIndex((item) => item.id === file.id)
      if (index >= 0) state.files[index] = file
      else state.files.push(file)
      if (previous && previous.activeVersionId !== file.activeVersionId) {
        state.credentials = invalidateFileCredentials({
          credentials: state.credentials,
          fileId: file.id,
          reason: 'file-version-changed',
          at: now(),
        })
      }
    } else if (url === '/file/version/add') {
      const packageId = String(payload.packageId)
      const fileId = String(payload.fileId)
      const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
      if (!file) throw new Error('文件不存在')
      const pageCount = Number(payload.pageCount)
      const label = String(payload.label)
      const summary = String(payload.summary)
      const newVersion = {
        id: `file-version-${crypto.randomUUID()}`,
        label,
        uploadedAt: now(),
        hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
        sizeKb: pageCount * 96 + 720,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          id: `page-${crypto.randomUUID()}`,
          page: index + 1,
          category: file.kind,
          controlled: false,
          desensitized: false,
          note: '',
          reviewer: '',
        })),
        changeSummary: summary,
      }
      file.versions.push(newVersion)
      file.activeVersionId = newVersion.id
      audit({
        packageId,
        action: '上传文件版本',
        target: `${file.name} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
      state.credentials = invalidateFileCredentials({
        credentials: state.credentials,
        fileId,
        reason: 'file-version-changed',
        at: now(),
      })
      const packageItem = state.packages.find((item) => item.id === packageId)
      const versionReason = `${file.name} 现行版本变更为 ${label}，旧版本受控页凭证立即失效，审批路线退回待复核；核对并引用新版本后需重新提交。`
      if (packageItem && returnRouteToRecheck({ packageItem, reason: versionReason, at: now() })) {
        audit({
          packageId,
          action: '审批退回待复核',
          target: file.name,
          operator: '系统',
          detail: versionReason,
        })
      }
    } else if (url === '/file/reference') {
      const fileId = String(payload.fileId)
      const versionId = String(payload.versionId)
      const file = state.files.find((item) => item.id === fileId)
      if (!file) throw new Error('文件不存在')
      file.referencedVersionId = versionId
      audit({
        packageId: file.packageId,
        action: '选择引用版本',
        target: file.name,
        operator: '当前用户',
        detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
      })
      state.credentials = invalidateFileCredentials({
        credentials: state.credentials,
        fileId,
        reason: 'reference-version-changed',
        at: now(),
      })
      const referencePackage = state.packages.find((item) => item.id === file.packageId)
      const referenceLabel = file.versions.find((item) => item.id === versionId)?.label ?? versionId
      const referenceReason = `${file.name} 审批引用版本调整为 ${referenceLabel}，原受控页凭证立即失效，审批路线退回待复核。`
      if (
        referencePackage &&
        returnRouteToRecheck({ packageItem: referencePackage, reason: referenceReason, at: now() })
      ) {
        audit({
          packageId: file.packageId,
          action: '审批退回待复核',
          target: file.name,
          operator: '系统',
          detail: referenceReason,
        })
      }
    } else if (url === '/page/save') {
      const file = state.files.find((item) => item.id === String(payload.fileId))
      const version = file?.versions.find((item) => item.id === String(payload.versionId))
      if (!file || !version) throw new Error('文件版本不存在')
      const page = payload.page as PageReview
      const index = version.pages.findIndex((item) => item.id === page.id)
      const previous = index >= 0 ? version.pages[index] : undefined
      if (index >= 0) version.pages[index] = page
      else version.pages.push(page)
      audit({
        packageId: file.packageId,
        action: '逐页分类核对',
        target: `${file.name} 第 ${page.page} 页`,
        operator: page.reviewer || '当前用户',
        detail: page.controlled ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}` : '标记为一般资料',
      })
      if (previous && previous.controlled !== page.controlled) {
        state.credentials = invalidatePageCredentials({
          credentials: state.credentials,
          fileId: file.id,
          pageId: page.id,
          reason: 'controlled-flag-changed',
          at: now(),
        })
        const pagePackage = state.packages.find((item) => item.id === file.packageId)
        const flagReason = `${file.name} 第 ${page.page} 页受控标记由「${
          previous.controlled ? '受控' : '一般'
        }」改为「${page.controlled ? '受控' : '一般'}」，查看凭证立即失效，审批路线退回待复核。`
        if (
          pagePackage &&
          returnRouteToRecheck({ packageItem: pagePackage, reason: flagReason, at: now() })
        ) {
          audit({
            packageId: file.packageId,
            action: '审批退回待复核',
            target: `${file.name} 第 ${page.page} 页`,
            operator: '系统',
            detail: flagReason,
          })
        }
      }
    } else if (url === '/package/validate') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      state.findings = [
        ...state.findings.filter((item) => item.packageId !== packageId),
        ...validatePackage(packageItem, state.files, state.rules),
      ]
      audit({
        packageId,
        action: '执行许可校验',
        target: packageItem.code,
        operator: '当前用户',
        detail: `生成 ${state.findings.filter((item) => item.packageId === packageId).length} 条核对结果。`,
      })
    } else if (url === '/package/version') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const summary = String(payload.summary)
      const label = String(payload.label)
      packageItem.versions.push({
        id: `package-version-${crypto.randomUUID()}`,
        label,
        createdAt: now(),
        createdBy: '当前用户',
        summary,
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: Object.fromEntries(
            state.files
              .filter((file) => file.packageId === packageId)
              .map((file) => [file.id, file.activeVersionId]),
          ),
        },
      })
      audit({
        packageId,
        action: '创建资料包版本',
        target: `${packageItem.code} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
    } else if (url === '/approval/submit') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const rule = findApplicableRule(packageItem, state.rules)
      if (!rule) throw new Error('未匹配到许可规则')
      const mismatch = state.files.find(
        (file) =>
          file.packageId === packageId &&
          file.activeVersionId !== file.referencedVersionId,
      )
      if (mismatch) {
        throw new Error(`审批引用版本与现行版本不一致：${mismatch.name}，禁止跨版本提交`)
      }
      const nextRound = packageItem.currentRound + 1
      // 先按当前引用版本与人员范围试签发；任何受控页未核对都整体阻断，审批路线保持原状
      const issue = issueCredentialsForSubmission({
        credentials: state.credentials,
        packageItem,
        files: state.files,
        audit,
        at: now(),
        round: nextRound,
      })
      if (issue.blocked.length) {
        throw new Error(`受控页凭证签发被阻断：${issue.blocked.join('；')}`)
      }
      state.credentials = issue.credentials
      packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
      packageItem.matchedRuleId = rule.id
      packageItem.status = 'reviewing'
      packageItem.currentRound = nextRound
      packageItem.needsRecheck = undefined
      audit({
        packageId,
        action: '提交审批',
        target: packageItem.code,
        operator: '当前用户',
        detail: `按 ${rule.name} 生成审批路线，第 ${packageItem.currentRound} 轮；为 ${issue.created.length} 个受控页签发短期查看凭证，一般页不签凭证。`,
      })
    } else if (url === '/approval/decide') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
      if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
      const decision = String(payload.decision)
      step.comment = String(payload.comment ?? '')
      step.decidedAt = now()
      if (decision === 'return') {
        step.status = 'returned'
        packageItem.status = 'returned'
      } else {
        step.status = 'approved'
        const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
        if (next) next.status = 'active'
        else packageItem.status = 'approved'
      }
      audit({
        packageId,
        action: decision === 'return' ? '审批退回' : '审批通过',
        target: `${packageItem.code} / ${step.role}`,
        operator: step.assignee,
        detail: step.comment || '无补充意见。',
      })
    } else if (url === '/license/deduct') {
      const packageId = String(payload.packageId)
      const amount = Number(payload.amount)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      if (packageItem.quotaUsed + amount > packageItem.quotaLimit) {
        throw new Error('许可额度不足')
      }
      packageItem.quotaUsed += amount
      packageItem.status = 'licensed'
      audit({
        packageId,
        action: '扣减许可额度',
        target: packageItem.code,
        operator: '当前用户',
        detail: `扣减 ${amount}，剩余 ${packageItem.quotaLimit - packageItem.quotaUsed}。`,
      })
    } else if (url === '/comment/add') {
      state.comments.unshift({
        ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
        id: `comment-${crypto.randomUUID()}`,
        createdAt: now(),
      })
    } else if (url === '/audit/add') {
      audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
    } else if (url === '/credential/renew') {
      const credentialId = String(payload.credentialId)
      const packageItem = state.packages.find((item) =>
        state.credentials.some(
          (credential) => credential.id === credentialId && credential.packageId === item.id,
        ),
      )
      if (!packageItem) throw new Error('凭证或资料包不存在')

      const runRenew = async () =>
        renewCredential({
          credentials: state.credentials,
          credentialId,
          packageItem,
          files: state.files,
          audit,
          at: now(),
        })
      // 并发窗口：同一凭证在同一批次内的续签请求合并执行
      let flight = inflightRenewals.get(credentialId) as
        | ReturnType<typeof runRenew>
        | undefined
      if (!flight) {
        flight = runRenew()
        inflightRenewals.set(credentialId, flight)
        window.setTimeout(() => inflightRenewals.delete(credentialId), 0)
      }
      const result = await flight
      state.credentials = result.credentials
      audit({
        packageId: packageItem.id,
        action: result.merged ? '续签请求合并' : '续签完成',
        target: result.renewed.id,
        operator: '当前用户',
        detail: result.merged
          ? '两个窗口同时提交续签，仅保留仍有效的一份。'
          : '短期查看凭证已续签。',
      })
    } else if (url === '/credential/renew/batch') {
      // 演练：两个窗口几乎同时对同一份凭证发起续签
      const credentialId = String(payload.credentialId)
      const packageItem = state.packages.find((item) =>
        state.credentials.some(
          (credential) => credential.id === credentialId && credential.packageId === item.id,
        ),
      )
      if (!packageItem) throw new Error('凭证或资料包不存在')
      const original = state.credentials.find((item) => item.id === credentialId)
      if (!original || original.status !== 'active') {
        throw new Error('仅仍有效的凭证可以续签')
      }

      // 窗口 A、B 同批发起：inflight 合并为同一次续签
      const [first, second] = await Promise.all([
        renewCredential({
          credentials: state.credentials,
          credentialId,
          packageItem,
          files: state.files,
          audit,
          at: now(),
        }),
        renewCredential({
          credentials: state.credentials,
          credentialId,
          packageItem,
          files: state.files,
          audit,
          at: now(),
        }),
      ])
      state.credentials = first.credentials
      if (!second.merged) state.credentials = second.credentials
      // 窗口 B 若持旧凭证号晚一拍再提交，旧凭证已作废，应被拒绝
      await new Promise((resolve) => window.setTimeout(resolve, 30))
      try {
        const retry = renewCredential({
          credentials: state.credentials,
          credentialId: original.id,
          packageItem,
          files: state.files,
          audit,
          at: now(),
        })
        state.credentials = retry.credentials
      } catch {
        // 预期路径：旧凭证续签被拒绝
      }
      const activeForBinding = state.credentials.filter(
        (item) =>
          item.fileId === original.fileId &&
          item.versionId === original.versionId &&
          item.pageIds[0] === original.pageIds[0] &&
          item.status === 'active',
      )
      audit({
        packageId: packageItem.id,
        action: '并发续签演练',
        target: original.id,
        operator: '当前用户',
        detail: `两个窗口同时提交续签，当前绑定有效凭证 ${activeForBinding.length} 份（要求为 1）。`,
      })
    } else if (url === '/credential/simulate-write-failure') {
      const failedCredentialId = String(payload.credentialId)
      const target = state.credentials.find((item) => item.id === failedCredentialId)
      if (!target) throw new Error('凭证不存在')
      if (target.status !== 'active') throw new Error('仅有效凭证可以演练写入失败')
      state.credentials = markCredentialWriteFailed({
        credentials: state.credentials,
        credentialId: failedCredentialId,
        at: now(),
      })
      audit({
        packageId: target.packageId,
        action: '凭证写入失败',
        target: target.id,
        operator: '演练开关',
        detail: '模拟凭证落盘中断：凭证保留为写入失败状态，等待按最新版本恢复重签。',
      })
    } else if (url === '/credential/recover') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const result = recoverFailedCredentials({
        credentials: state.credentials,
        packageItem,
        files: state.files,
        audit,
        at: now(),
      })
      state.credentials = result.credentials
      if (!result.recovered && !result.dropped) throw new Error('当前没有待恢复的凭证')
    } else if (url === '/credential/revoke') {
      state.credentials = revokeCredential({
        credentials: state.credentials,
        credentialId: String(payload.credentialId),
        audit,
        at: now(),
      })
    } else if (url === '/credential/access') {
      const result = verifyCredentialAccess({
        credentials: state.credentials,
        token: String(payload.token ?? ''),
        packageId: String(payload.packageId),
        fileId: String(payload.fileId),
        versionId: String(payload.versionId),
        pageId: String(payload.pageId),
        viewer: String(payload.viewer ?? '审批人'),
        files: state.files,
        packages: state.packages,
        at: now(),
      })
      state.accessRecords.unshift(result.record)
      audit({
        packageId: result.record.packageId,
        action: result.allowed ? '受控页访问放行' : '受控页访问拒绝',
        target: result.record.credentialId,
        operator: result.record.viewer,
        detail: result.allowed
          ? `第 ${result.record.page ?? '-'} 页凭短期凭证打开。`
          : `打开第 ${result.record.page ?? '-'} 页被拒绝：${result.reason}`,
      })
      saveWorkspace(state)
      return { data: { workspace: state, access: result } }
    } else if (url === '/credential/review-backfill') {
      state.credentials = reviewBackfilledCredential({
        credentials: state.credentials,
        credentialId: String(payload.credentialId),
        decision: payload.decision === 'reject' ? 'reject' : 'confirm',
        comment: String(payload.comment ?? ''),
        audit,
        at: now(),
      })
    } else if (url === '/workspace/reset') {
      state = resetWorkspace()
      return { data: state }
    } else {
      throw new Error(`未实现的本地接口：${url}`)
    }

    saveWorkspace(state)
    return { data: state }
  } catch (error) {
    return {
      error: {
        status: 400,
        error: error instanceof Error ? error.message : '本地操作失败',
      },
    }
  }
}

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceState, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceState,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceState,
      {
        package: Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
      }
    >({
      query: (body) => ({ url: '/package/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    saveFile: builder.mutation<WorkspaceState, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductQuota: builder.mutation<WorkspaceState, { packageId: string; amount: number }>({
      query: (body) => ({ url: '/license/deduct', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceState,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceState,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    renewCredential: builder.mutation<WorkspaceState, { credentialId: string }>({
      query: (body) => ({ url: '/credential/renew', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    renewCredentialBatch: builder.mutation<WorkspaceState, { credentialId: string }>({
      query: (body) => ({ url: '/credential/renew/batch', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    simulateCredentialWriteFailure: builder.mutation<
      WorkspaceState,
      { credentialId: string }
    >({
      query: (body) => ({ url: '/credential/simulate-write-failure', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    recoverCredentials: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/credential/recover', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    revokeCredential: builder.mutation<WorkspaceState, { credentialId: string }>({
      query: (body) => ({ url: '/credential/revoke', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    reviewBackfilledCredential: builder.mutation<
      WorkspaceState,
      { credentialId: string; decision: 'confirm' | 'reject'; comment: string }
    >({
      query: (body) => ({ url: '/credential/review-backfill', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    accessControlledPage: builder.mutation<
      { workspace: WorkspaceState; access: { allowed: boolean; reason?: string; record: AccessRecord } },
      {
        token: string
        packageId: string
        fileId: string
        versionId: string
        pageId: string
        viewer?: string
      }
    >({
      query: (body) => ({ url: '/credential/access', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

export const {
  useGetWorkspaceQuery,
  useSavePackageMutation,
  useCreatePackageMutation,
  useSaveFileMutation,
  useAddFileVersionMutation,
  useSetReferenceVersionMutation,
  useSavePageReviewMutation,
  useValidatePackageMutation,
  useCreatePackageVersionMutation,
  useSubmitApprovalMutation,
  useDecideApprovalMutation,
  useDeductQuotaMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useRenewCredentialMutation,
  useRenewCredentialBatchMutation,
  useSimulateCredentialWriteFailureMutation,
  useRecoverCredentialsMutation,
  useRevokeCredentialMutation,
  useReviewBackfilledCredentialMutation,
  useAccessControlledPageMutation,
  useResetWorkspaceMutation,
} = workspaceApi
