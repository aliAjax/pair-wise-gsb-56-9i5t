export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'recheck'
  | 'returned'
  | 'approved'
  | 'licensed'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType = 'missing-declaration' | 'escalation' | 'version-mismatch' | 'unclassified-page' | 'quota'

export interface PageReview {
  id: string
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  note: string
  reviewer: string
  reviewedAt?: string
}

export interface FileVersion {
  id: string
  label: string
  uploadedAt: string
  hash: string
  sizeKb: number
  pages: PageReview[]
  changeSummary: string
}

export interface MaterialFile {
  id: string
  packageId: string
  name: string
  kind: MaterialCategory
  activeVersionId: string
  referencedVersionId: string
  versions: FileVersion[]
}

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: 'waiting' | 'active' | 'approved' | 'returned'
  comment: string
  decidedAt?: string
}

export interface PackageVersion {
  id: string
  label: string
  createdAt: string
  createdBy: string
  summary: string
  snapshot: {
    title: string
    category: MaterialCategory
    destination: string
    endUse: string
    technologyTags: string[]
    personnelScopes: string[]
    declarations: string[]
    activeFileVersions: Record<string, string>
  }
}

export interface ReviewComment {
  id: string
  packageId: string
  author: string
  content: string
  createdAt: string
  round: number
}

export interface MaterialPackage {
  id: string
  code: string
  title: string
  category: MaterialCategory
  applicant: string
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
  status: PackageStatus
  matchedRuleId?: string
  approvalRoute: ApprovalStep[]
  currentRound: number
  quotaUsed: number
  quotaLimit: number
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
}

export interface LicenseRule {
  id: string
  name: string
  categories: MaterialCategory[]
  destinations: string[]
  technologyTags: string[]
  personnelScopes: string[]
  requiredDeclarations: string[]
  approvalLevel: ApprovalLevel
  quotaLimit: number
  explanation: string
}

export interface ValidationFinding {
  id: string
  packageId: string
  type: FindingType
  level: FindingLevel
  message: string
  action: string
  ruleId?: string
}

export interface AuditEntry {
  id: string
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

/** 受控页短期查看凭证的生命周期状态 */
export type CredentialStatus =
  | 'active' // 有效，受控页可凭此查看
  | 'expired' // 短期到期
  | 'superseded' // 同目标重新签发后被替换，或签发写入失败后恢复重签
  | 'invalidated' // 人员范围、现行版本或受控标记变化导致立即失效
  | 'revoked' // 授权被撤回
  | 'write-failed' // 凭证已生成但持久化未确认，须按最新版本恢复
  | 'manual-check' // 旧数据回填时人员范围无法确认，待人工核对

export type CredentialIssueSource =
  | 'submit' // 提交审批签发
  | 'renewal' // 到期前续签
  | 'recovery' // 写入失败后恢复重签
  | 'backfill' // 旧数据按引用版本回填

export interface ViewCredential {
  id: string
  /** 凭证编号，便于人工追溯 */
  code: string
  packageId: string
  fileId: string
  /** 签发行版本（提交时为文件的审批引用版本） */
  versionId: string
  versionLabel: string
  /** 该版本中受凭证覆盖的受控页页码 */
  controlledPages: number[]
  /** 签发时刻的人员范围快照 */
  personnelScopes: string[]
  status: CredentialStatus
  issueSource: CredentialIssueSource
  issuedAt: string
  expiresAt: string
  /** 失效、撤回或替换时间 */
  endedAt?: string
  /** 状态原因，如失效触发点、拒绝原因等 */
  reason: string
  /** 幂等键，两个窗口同时续签时用于识别同一批次 */
  requestNonce?: string
}

export interface AccessRecord {
  id: string
  packageId: string
  fileId: string
  versionId: string
  page: number
  controlled: boolean
  credentialId?: string
  result: 'granted' | 'denied'
  deniedReason?: string
  viewer: string
  createdAt: string
}

export interface ScopeManualCheck {
  id: string
  packageId: string
  fileId: string
  versionId: string
  controlledPages: number[]
  status: 'pending' | 'resolved'
  note: string
  createdAt: string
  resolvedAt?: string
  resolvedBy?: string
  /** 人工确认后生效的人员范围 */
  confirmedScopes?: string[]
}

export interface WorkspaceState {
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  /** 受控页短期查看凭证 */
  credentials: ViewCredential[]
  /** 受控页访问记录（含拒绝记录），与审批状态一起追溯 */
  accessRecords: AccessRecord[]
  /** 旧数据回填中人员范围无法确认、待人工核对的条目 */
  scopeManualChecks: ScopeManualCheck[]
  /** 本地数据结构版本，用于旧数据凭证回填迁移 */
  schemaVersion: number
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
