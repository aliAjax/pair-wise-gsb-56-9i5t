import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  ViewCredential,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, mutateWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  checkPageAccess,
  createAuditSink,
  invalidatePackageCredentials,
  issueCredentialsForSubmission,
  markCredentialWriteFailed,
  recoverCredential,
  renewCredential,
  resolveScopeCheck,
  revokeCredentials,
} from '@/services/credentials'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()
const sameScopes = (left: string[], right: string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())

type RenewResponse = WorkspaceState & { renewDuplicated?: boolean; renewMessage?: string }
type StateWithTransient = WorkspaceState & {
  __renewDuplicated?: boolean
  __renewMessage?: string
}

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({ url, body }) => {
  await wait()
  const payload = (body ?? {}) as Record<string, unknown>

  // 读接口不加锁，写接口统一通过 mutateWorkspace 串行化，避免两个窗口同时提交互相覆盖
  if (url === '/workspace') return { data: loadWorkspace() }
  if (url === '/workspace/reset') {
    await wait()
    return { data: resetWorkspace() }
  }

  try {
    const data = await mutateWorkspace<WorkspaceState>((state) => {
      const audit = (
        entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>,
        atIso?: string,
      ) => {
        state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: atIso ?? now() })
      }

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
        // 人员范围变化：有效凭证立即失效，审批路线退回待复核
        if (
          Array.isArray(patch.personnelScopes) &&
          !sameScopes(previousScopes, patch.personnelScopes)
        ) {
          invalidatePackageCredentials(state, current, {
            trigger: 'personnel',
            target: current.code,
            detail: `人员范围由「${previousScopes.join('、') || '无特别范围'}」调整为「${
              patch.personnelScopes.join('、') || '无特别范围'
            }」。`,
            recheck: true,
          })
        }
      } else if (url === '/package/create') {
        const draft = payload.package as Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
        const rule = findApplicableRule(
          {
            ...draft,
            id: 'temp',
            approvalRoute: [],
            versions: [],
            currentRound: 0,
            createdAt: '',
            updatedAt: '',
          },
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
        const index = state.files.findIndex((item) => item.id === file.id)
        if (index >= 0) state.files[index] = file
        else state.files.push(file)
      } else if (url === '/file/version/add') {
        const packageId = String(payload.packageId)
        const fileId = String(payload.fileId)
        const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
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
        // 文件现行版本改变：旧凭证立即失效，审批路线退回待复核
        if (packageItem && packageItem.status === 'reviewing') {
          invalidatePackageCredentials(state, packageItem, {
            trigger: 'version',
            target: `${file.name} ${label}`,
            detail: `文件现行版本更新为 ${label}，原受控页查看凭证立即失效。`,
            recheck: true,
            fileIds: [file.id],
          })
        }
      } else if (url === '/file/reference') {
        const fileId = String(payload.fileId)
        const versionId = String(payload.versionId)
        const file = state.files.find((item) => item.id === fileId)
        const packageItem = state.packages.find((item) => item.id === file?.packageId)
        if (!file) throw new Error('文件不存在')
        const previous = file.referencedVersionId
        file.referencedVersionId = versionId
        audit({
          packageId: file.packageId,
          action: '选择引用版本',
          target: file.name,
          operator: '当前用户',
          detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
        })
        // 审批引用版本切换：原引用版本绑定的凭证立即失效
        if (packageItem && previous !== versionId && packageItem.status === 'reviewing') {
          invalidatePackageCredentials(state, packageItem, {
            trigger: 'version',
            target: file.name,
            detail: `审批引用版本切换，原引用版本上的受控页凭证立即失效。`,
            recheck: true,
            fileIds: [file.id],
            versionIds: [previous],
          })
        }
      } else if (url === '/page/save') {
        const file = state.files.find((item) => item.id === String(payload.fileId))
        const version = file?.versions.find((item) => item.id === String(payload.versionId))
        if (!file || !version) throw new Error('文件版本不存在')
        const page = payload.page as PageReview
        const previous = version.pages.find((item) => item.id === page.id)
        const index = version.pages.findIndex((item) => item.id === page.id)
        if (index >= 0) version.pages[index] = page
        else version.pages.push(page)
        audit({
          packageId: file.packageId,
          action: '逐页分类核对',
          target: `${file.name} 第 ${page.page} 页`,
          operator: page.reviewer || '当前用户',
          detail: page.controlled
            ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}`
            : '标记为一般资料',
        })
        // 受控标记改变（一般⇄受控）：该版本有效凭证立即失效；审批中再退回待复核
        const packageItem = state.packages.find((item) => item.id === file.packageId)
        if (previous && previous.controlled !== page.controlled && packageItem) {
          invalidatePackageCredentials(state, packageItem, {
            trigger: 'controlled',
            target: `${file.name} 第 ${page.page} 页`,
            detail: `第 ${page.page} 页受控标记由「${
              previous.controlled ? '受控' : '一般'
            }」改为「${page.controlled ? '受控' : '一般'}」。`,
            recheck: packageItem.status === 'reviewing',
            fileIds: [file.id],
            versionIds: [version.id],
          })
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
        // 提交前把审批引用对齐到现行版本：凭证只按当前文件版本签发；旧引用版本上的凭证随提交动作替换
        state.files
          .filter((file) => file.packageId === packageId && file.activeVersionId !== file.referencedVersionId)
          .forEach((file) => {
            const previous = file.referencedVersionId
            file.referencedVersionId = file.activeVersionId
            audit({
              packageId,
              action: '提交时对齐引用版本',
              target: file.name,
              operator: '当前用户',
              detail: `提交审批时将引用版本对齐到现行版本 ${
                file.versions.find((item) => item.id === file.activeVersionId)?.label ?? file.activeVersionId
              }，原引用 ${previous} 版本上的凭证不再使用。`,
            })
          })
        packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
        packageItem.matchedRuleId = rule.id
        packageItem.status = 'reviewing'
        packageItem.currentRound += 1
        packageItem.updatedAt = now()
        // 提交审批：按当前文件引用版本和人员范围签发短期查看凭证，一般页不签
        const issued = issueCredentialsForSubmission(state, packageItem, createAuditSink(state), {
          round: packageItem.currentRound,
        })
        audit({
          packageId,
          action: '提交审批',
          target: packageItem.code,
          operator: '当前用户',
          detail: `按 ${rule.name} 生成审批路线，第 ${packageItem.currentRound} 轮，受控页凭证 ${issued.length} 份。`,
        })
      } else if (url === '/approval/decide') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        if (packageItem.status === 'recheck') {
          throw new Error('资料包因人员范围、文件版本或受控标记变化已退回待复核，请重新提交审批后再处理')
        }
        const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
        if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
        const decision = String(payload.decision)
        step.comment = String(payload.comment ?? '')
        step.decidedAt = now()
        if (decision === 'return') {
          step.status = 'returned'
          packageItem.status = 'returned'
          // 退回后审批中的受控页访问权立即收回
          invalidatePackageCredentials(state, packageItem, {
            trigger: 'approval',
            target: packageItem.code,
            detail: '审批退回，受控页查看凭证全部失效，重新发起后按新版本签发。',
            recheck: false,
          })
        } else {
          step.status = 'approved'
          const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
          if (next) {
            next.status = 'active'
          } else {
            packageItem.status = 'approved'
            invalidatePackageCredentials(state, packageItem, {
              trigger: 'approval',
              target: packageItem.code,
              detail: '审批全部通过，审批期间短期查看凭证到期关闭，后续访问按许可授权执行。',
              recheck: false,
            })
          }
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
        const packageId = String(payload.packageId)
        const fileId = String(payload.fileId)
        const nonce = payload.nonce ? String(payload.nonce) : undefined
        const result = renewCredential(state, packageId, fileId, createAuditSink(state), {
          nonce,
          operator: String(payload.operator ?? '当前用户'),
        })
        // 瞬态提示，不写入持久化状态
        ;(state as StateWithTransient).__renewDuplicated = result.duplicated
        ;(state as StateWithTransient).__renewMessage = result.reason
      } else if (url === '/credential/renew-both') {
        // 模拟两个窗口同时提交续签：写锁串行执行，第二次落在幂等窗口内，只保留先写入的一份
        const packageId = String(payload.packageId)
        const fileId = String(payload.fileId)
        const fileName = state.files.find((item) => item.id === fileId)?.name ?? fileId
        const first = renewCredential(state, packageId, fileId, createAuditSink(state), {
          nonce: `window-A-${crypto.randomUUID()}`,
          operator: '窗口 A',
        })
        const second = renewCredential(state, packageId, fileId, createAuditSink(state), {
          nonce: `window-B-${crypto.randomUUID()}`,
          operator: '窗口 B',
        })
        const kept = second.duplicated ? first.credential : second.credential
        audit({
          packageId,
          action: '并发续签合并',
          target: fileName,
          operator: '系统',
          detail:
            `两个窗口同时提交续签：窗口 A 先写入 ${first.credential?.code}；` +
            (second.duplicated
              ? `窗口 B 在幂等窗口内识别为重复，保留 ${kept?.code}，只保留仍有效的一份。`
              : `窗口 B 替换为 ${second.credential?.code}。`),
        })
        ;(state as StateWithTransient).__renewDuplicated = second.duplicated
        ;(state as StateWithTransient).__renewMessage =
          `窗口 A 签发 ${first.credential?.code}；` +
          (second.duplicated
            ? `窗口 B 的续签被识别为重复请求，最终保留 ${kept?.code}。`
            : `窗口 B 签发 ${second.credential?.code}，前一份被替换。`)
      } else if (url === '/credential/revoke') {
        revokeCredentials(state, String(payload.packageId), createAuditSink(state), {
          fileId: payload.fileId ? String(payload.fileId) : undefined,
          reason: payload.reason ? String(payload.reason) : undefined,
          operator: String(payload.operator ?? '当前用户'),
        })
      } else if (url === '/credential/simulate-write-fail') {
        const credentialId = String(payload.credentialId)
        markCredentialWriteFailed(state, credentialId, createAuditSink(state))
      } else if (url === '/credential/recover') {
        recoverCredential(
          state,
          String(payload.credentialId),
          createAuditSink(state),
        )
      } else if (url === '/credential/access-page') {
        checkPageAccess(state, {
          packageId: String(payload.packageId),
          fileId: String(payload.fileId),
          page: Number(payload.page),
          viewer: String(payload.viewer ?? '审批人'),
        })
      } else if (url === '/credential/resolve-scope') {
        resolveScopeCheck(
          state,
          String(payload.checkId),
          (payload.confirmedScopes as string[]) ?? [],
          createAuditSink(state),
          { note: payload.note ? String(payload.note) : undefined },
        )
      } else {
        throw new Error(`未实现的本地接口：${url}`)
      }
      return state
    })
    // 续签结果提示是瞬态字段：先取出，从持久化对象移除，再随响应返回
    const transient = data as StateWithTransient
    const duplicated = transient.__renewDuplicated
    const renewMessage = transient.__renewMessage
    delete transient.__renewDuplicated
    delete transient.__renewMessage
    saveWorkspace(data)
    return {
      data:
        duplicated !== undefined
          ? ({ ...data, renewDuplicated: duplicated, renewMessage } as WorkspaceState)
          : data,
    }
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
    renewCredential: builder.mutation<
      RenewResponse,
      { packageId: string; fileId: string; nonce?: string }
    >({
      query: (body) => ({ url: '/credential/renew', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    renewCredentialBoth: builder.mutation<
      RenewResponse,
      { packageId: string; fileId: string }
    >({
      query: (body) => ({ url: '/credential/renew-both', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    revokeCredential: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId?: string; reason?: string }
    >({
      query: (body) => ({ url: '/credential/revoke', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    simulateWriteFail: builder.mutation<WorkspaceState, { credentialId: string }>({
      query: (body) => ({ url: '/credential/simulate-write-fail', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    recoverCredential: builder.mutation<WorkspaceState, { credentialId: string }>({
      query: (body) => ({ url: '/credential/recover', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    accessPage: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; page: number; viewer?: string }
    >({
      query: (body) => ({ url: '/credential/access-page', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resolveScopeCheck: builder.mutation<
      WorkspaceState,
      { checkId: string; confirmedScopes: string[]; note?: string }
    >({
      query: (body) => ({ url: '/credential/resolve-scope', method: 'POST', body }),
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
  useRenewCredentialBothMutation,
  useRevokeCredentialMutation,
  useSimulateWriteFailMutation,
  useRecoverCredentialMutation,
  useAccessPageMutation,
  useResolveScopeCheckMutation,
  useResetWorkspaceMutation,
} = workspaceApi

export type { ViewCredential }
