export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
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
  status: 'waiting' | 'active' | 'approved' | 'returned' | 'recheck'
  comment: string
  decidedAt?: string
}

export interface ApprovalReset {
  reason: string
  resetAt: string
  round: number
  fromStatus: PackageStatus
}

export type CredentialStatus =
  | 'active' // 有效：可打开受控页
  | 'expired' // 短期凭证已到期
  | 'invalidated' // 版本、受控标记或人员范围变化后失效
  | 'revoked' // 授权撤回
  | 'write-failed' // 写入中断，等待恢复重签
  | 'unconfirmed' // 旧数据回填但范围无法确认，待人工核对

export type CredentialInvalidReason =
  | 'personnel-scope-changed'
  | 'file-version-changed'
  | 'controlled-flag-changed'
  | 'reference-version-changed'
  | 'superseded-renewal'
  | 'authorization-withdrawn'
  | 'expired'
  | 'manual-reject'

export type CredentialSource = 'issue' | 'renew' | 'recover' | 'backfill'

export interface ViewCredential {
  id: string
  token: string
  packageId: string
  fileId: string
  versionId: string
  pageIds: string[]
  personnelScopes: string[]
  status: CredentialStatus
  source: CredentialSource
  scopeConfidence: 'confirmed' | 'unconfirmed'
  issuedAt: string
  expiresAt: string
  invalidReason?: CredentialInvalidReason
  invalidatedAt?: string
  renewedFromId?: string
  renewedById?: string
  note?: string
}

export interface AccessRecord {
  id: string
  credentialId: string
  token: string
  packageId: string
  fileId: string
  versionId: string
  pageId?: string
  page?: number
  viewer: string
  result: 'granted' | 'denied'
  denyReason?: string
  at: string
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
  needsRecheck?: ApprovalReset
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

export interface WorkspaceState {
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  credentials: ViewCredential[]
  accessRecords: AccessRecord[]
  backfilledAt?: string
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
