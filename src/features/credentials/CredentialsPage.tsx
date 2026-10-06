import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  CheckCircleOutlined,
  EyeOutlined,
  KeyOutlined,
  ReloadOutlined,
  SyncOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useAccessControlledPageMutation,
  useGetWorkspaceQuery,
  useRecoverCredentialsMutation,
  useRenewCredentialBatchMutation,
  useRenewCredentialMutation,
  useReviewBackfilledCredentialMutation,
  useRevokeCredentialMutation,
  useSimulateCredentialWriteFailureMutation,
} from '@/app/api'
import type { AccessRecord, CredentialStatus, ViewCredential } from '@/types/domain'
import {
  credentialStatusLabels,
  invalidReasonLabels,
} from '@/services/credentials'

const statusColors: Record<CredentialStatus, string> = {
  active: 'success',
  expired: 'default',
  invalidated: 'error',
  revoked: 'error',
  'write-failed': 'warning',
  unconfirmed: 'processing',
}

const sourceLabels: Record<ViewCredential['source'], string> = {
  issue: '提交审批签发',
  renew: '续签',
  recover: '失败恢复',
  backfill: '旧数据回填',
}

export function CredentialsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [renewCredential] = useRenewCredentialMutation()
  const [renewBatch] = useRenewCredentialBatchMutation()
  const [simulateFailure] = useSimulateCredentialWriteFailureMutation()
  const [recoverCredentials] = useRecoverCredentialsMutation()
  const [revokeCredential] = useRevokeCredentialMutation()
  const [reviewBackfill] = useReviewBackfilledCredentialMutation()
  const [accessPage] = useAccessControlledPageMutation()

  const [packageFilter, setPackageFilter] = useState(searchParams.get('package') ?? '')
  const [statusFilter, setStatusFilter] = useState('')
  const [viewerToken, setViewerToken] = useState('')
  const [viewerName, setViewerName] = useState('审批人')
  const [accessTarget, setAccessTarget] = useState<ViewCredential>()
  const [reviewTarget, setReviewTarget] = useState<ViewCredential>()
  const [reviewDecision, setReviewDecision] = useState<'confirm' | 'reject'>('confirm')
  const [reviewComment, setReviewComment] = useState('')
  const [, forceTick] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => forceTick((value) => value + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (packageFilter) next.set('package', packageFilter)
    else next.delete('package')
    setSearchParams(next, { replace: true })
  }, [packageFilter, searchParams, setSearchParams])

  const fileMap = useMemo(() => new Map(data?.files.map((file) => [file.id, file])), [data])
  const packageMap = useMemo(
    () => new Map(data?.packages.map((item) => [item.id, item])),
    [data],
  )

  function describePage(credential: ViewCredential) {
    const file = fileMap.get(credential.fileId)
    const version = file?.versions.find((item) => item.id === credential.versionId)
    const page = version?.pages.find((item) => item.id === credential.pageIds[0])
    return {
      fileName: file?.name ?? credential.fileId,
      versionLabel: version?.label ?? credential.versionId,
      page,
    }
  }

  const credentials = useMemo(
    () =>
      (data?.credentials ?? []).filter(
        (item) =>
          (!packageFilter || item.packageId === packageFilter) &&
          (!statusFilter || item.status === statusFilter),
      ),
    [data, packageFilter, statusFilter],
  )

  if (isLoading || !data) return <div className="panel">正在加载受控页凭证...</div>

  const activeCount = data.credentials.filter((item) => item.status === 'active').length
  const failedCount = data.credentials.filter((item) => item.status === 'write-failed').length
  const unconfirmedCount = data.credentials.filter((item) => item.status === 'unconfirmed').length

  async function handleRenew(credential: ViewCredential) {
    try {
      await renewCredential({ credentialId: credential.id }).unwrap()
      message.success('凭证已续签，旧凭证作废，有效期延长 30 分钟')
    } catch (error) {
      message.error(resolveError(error))
    }
  }

  async function handleBatchRenew(credential: ViewCredential) {
    try {
      await renewBatch({ credentialId: credential.id }).unwrap()
      message.success('并发续签演练完成：同一绑定只保留一份有效凭证')
    } catch (error) {
      message.error(resolveError(error))
    }
  }

  async function handleFailure(credential: ViewCredential) {
    await simulateFailure({ credentialId: credential.id }).unwrap()
    message.warning('已模拟写入失败，凭证变为待恢复状态')
  }

  async function handleRecover(packageId: string) {
    try {
      const result = await recoverCredentials({ packageId }).unwrap()
      const recovered = result.credentials.filter((item) => item.source === 'recover').length
      message.success(`恢复完成：已按最新版本重签 ${recovered} 张凭证`)
    } catch (error) {
      message.error(resolveError(error))
    }
  }

  async function handleRevoke(credential: ViewCredential) {
    await revokeCredential({ credentialId: credential.id }).unwrap()
    message.success('授权已撤回，旧凭证立即失效并被拒绝')
  }

  async function handleAccess(credential: ViewCredential) {
    const { fileName, page } = describePage(credential)
    if (!page) {
      message.error('凭证对应的页已无法在当前版本中定位')
      return
    }
    try {
      const result = await accessPage({
        token: viewerToken.trim() || credential.token,
        packageId: credential.packageId,
        fileId: credential.fileId,
        versionId: credential.versionId,
        pageId: page.id,
        viewer: viewerName || '审批人',
      }).unwrap()
      if (result.access.allowed) {
        message.success(`已打开 ${fileName} 第 ${page.page} 页（受控页短期访问）`)
      } else {
        message.error(`访问被拒绝：${result.access.reason}`)
      }
    } catch (error) {
      message.error(resolveError(error))
    }
    setAccessTarget(undefined)
  }

  async function submitBackfillReview() {
    if (!reviewTarget) return
    await reviewBackfill({
      credentialId: reviewTarget.id,
      decision: reviewDecision,
      comment: reviewComment,
    }).unwrap()
    message.success(reviewDecision === 'confirm' ? '人工核对通过，凭证恢复有效' : '已拒绝，凭证保持失效')
    setReviewTarget(undefined)
    setReviewComment('')
  }

  const columns: TableColumnsType<ViewCredential> = [
    {
      title: '凭证',
      width: 190,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Tag color={statusColors[record.status]}>{credentialStatusLabels[record.status]}</Tag>
          <Tooltip title={record.token}>
            <span className="mono muted">
              {record.token.slice(0, 10)}…{record.token.slice(-4)}
            </span>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '受控页',
      render: (_, record) => {
        const { fileName, versionLabel, page } = describePage(record)
        return (
          <Space direction="vertical" size={2}>
            <strong>
              {fileName} · 第 {page?.page ?? '?'} 页
            </strong>
            <span className="muted">
              {packageMap.get(record.packageId)?.code} · 引用版本 {versionLabel}
            </span>
          </Space>
        )
      },
    },
    {
      title: '人员范围',
      width: 180,
      render: (_, record) => (
        <Space wrap size={4}>
          {record.personnelScopes.length ? (
            record.personnelScopes.map((scope) => <Tag key={scope}>{scope}</Tag>)
          ) : (
            <Tag>不限制</Tag>
          )}
          {record.scopeConfidence === 'unconfirmed' ? <Tag color="processing">范围待核对</Tag> : null}
        </Space>
      ),
    },
    {
      title: '来源 / 有效期',
      width: 220,
      render: (_, record) => {
        const remaining = new Date(record.expiresAt).getTime() - Date.now()
        return (
          <Space direction="vertical" size={2}>
            <span className="muted">{sourceLabels[record.source]}</span>
            {record.status === 'active' ? (
              <Tag color={remaining < 5 * 60 * 1000 ? 'warning' : 'success'}>
                剩余 {Math.max(0, Math.round(remaining / 60000))} 分钟
              </Tag>
            ) : (
              <span className="muted">
                {record.invalidReason
                  ? invalidReasonLabels[record.invalidReason]
                  : record.status === 'expired'
                    ? '已到期'
                    : ''}
              </span>
            )}
          </Space>
        )
      },
    },
    {
      title: '操作',
      width: 300,
      render: (_, record) => (
        <Space wrap size={4}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setAccessTarget(record)}>
            打开受控页
          </Button>
          {record.status === 'active' ? (
            <>
              <Button size="small" icon={<SyncOutlined />} onClick={() => handleRenew(record)}>
                续签
              </Button>
              <Tooltip title="模拟两个窗口同时提交续签">
                <Button size="small" onClick={() => handleBatchRenew(record)}>
                  双窗口续签
                </Button>
              </Tooltip>
              <Button size="small" danger ghost onClick={() => handleFailure(record)}>
                演练写入失败
              </Button>
              <Popconfirm
                title="撤回该受控页授权？"
                description="撤回后旧凭证立即被拒绝。"
                onConfirm={() => handleRevoke(record)}
              >
                <Button size="small" danger>
                  撤回
                </Button>
              </Popconfirm>
            </>
          ) : null}
          {record.status === 'write-failed' ? (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<ReloadOutlined />}
              onClick={() => handleRecover(record.packageId)}
            >
              按最新版本恢复
            </Button>
          ) : null}
          {record.status === 'unconfirmed' ? (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<CheckCircleOutlined />}
              onClick={() => {
                setReviewTarget(record)
                setReviewDecision('confirm')
                setReviewComment('')
              }}
            >
              人工核对
            </Button>
          ) : null}
        </Space>
      ),
    },
  ]

  const accessColumns: TableColumnsType<AccessRecord> = [
    {
      title: '时间',
      dataIndex: 'at',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '结果',
      dataIndex: 'result',
      width: 90,
      render: (value: AccessRecord['result']) => (
        <Tag color={value === 'granted' ? 'success' : 'error'}>
          {value === 'granted' ? '放行' : '拒绝'}
        </Tag>
      ),
    },
    {
      title: '资料包 / 页',
      width: 240,
      render: (_, record) => {
        const file = fileMap.get(record.fileId)
        return (
          <span>
            {packageMap.get(record.packageId)?.code ?? record.packageId} · {file?.name ?? record.fileId} · 第{' '}
            {record.page ?? '?'} 页
          </span>
        )
      },
    },
    { title: '访问人', dataIndex: 'viewer', width: 110 },
    {
      title: '凭证',
      width: 180,
      render: (_, record) => (
        <Tooltip title={record.token}>
          <span className="mono muted">
            {record.credentialId === 'unknown' ? '未提供/不存在' : record.credentialId.slice(-10)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '拒绝原因',
      dataIndex: 'denyReason',
      render: (value?: string) => value ?? <span className="muted">—</span>,
    },
  ]

  const selectedPackage = packageFilter ? packageMap.get(packageFilter) : undefined

  return (
    <div>
      <PageHeader
        title="受控页访问凭证"
        description="提交审批时按当前文件引用版本和人员范围为受控页逐页签发短期凭证（一般页不签）；换版、受控标记或人员范围变化立即失效并退回待复核。"
        actions={
          <Space>
            <Badge count={activeCount} showZero color="#52c41a">
              <Tag style={{ padding: '2px 12px' }}>有效凭证</Tag>
            </Badge>
            {failedCount ? <Badge count={failedCount} color="#faad14" /> : null}
            {unconfirmedCount ? <Badge count={unconfirmedCount} color="#1677ff" /> : null}
          </Space>
        }
      />

      {selectedPackage?.needsRecheck ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`${selectedPackage.code} 审批路线已退回待复核`}
          description={selectedPackage.needsRecheck.reason}
        />
      ) : null}
      {failedCount ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${failedCount} 张凭证写入失败待恢复，可在下方按最新版本恢复重签。`}
        />
      ) : null}
      {unconfirmedCount ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${unconfirmedCount} 张旧数据回填凭证的人员范围无法确认，需逐个人工核对后才会放行。`}
        />
      ) : null}

      <div className="toolbar">
        <Select
          allowClear
          value={packageFilter || undefined}
          onChange={(value) => setPackageFilter(value ?? '')}
          placeholder="选择资料包"
          style={{ width: 300 }}
          options={data.packages.map((item) => ({
            value: item.id,
            label: `${item.code} · ${item.title}`,
          }))}
        />
        <Select
          allowClear
          value={statusFilter || undefined}
          onChange={(value) => setStatusFilter(value ?? '')}
          placeholder="凭证状态"
          style={{ width: 180 }}
          options={(
            ['active', 'expired', 'invalidated', 'revoked', 'write-failed', 'unconfirmed'] as CredentialStatus[]
          ).map((value) => ({ value, label: credentialStatusLabels[value] }))}
        />
        <Input
          placeholder="审批人身份（模拟）"
          style={{ width: 170 }}
          value={viewerName}
          onChange={(event) => setViewerName(event.target.value)}
        />
        <Input
          placeholder="打开页时使用的凭证号（留空用本行凭证）"
          style={{ width: 320 }}
          value={viewerToken}
          onChange={(event) => setViewerToken(event.target.value)}
          allowClear
        />
        <span className="grow" />
        {packageFilter ? (
          <Button
            icon={<ThunderboltOutlined />}
            disabled={!data.credentials.some(
              (item) => item.packageId === packageFilter && item.status === 'write-failed',
            )}
            onClick={() => handleRecover(packageFilter)}
          >
            恢复本资料包失败凭证
          </Button>
        ) : null}
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>
            <KeyOutlined /> 受控页短期凭证
          </h3>
          <span className="muted">每次提交审批重新签发；凭证与引用版本、受控页、人员范围绑定</span>
        </div>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={credentials}
          scroll={{ x: 1100 }}
          pagination={{ pageSize: 8, showSizeChanger: false }}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>
            <EyeOutlined /> 受控页访问记录
          </h3>
          <span className="muted">放行与拒绝均留痕，并同步写入审计与追溯包</span>
        </div>
        <Table
          rowKey="id"
          columns={accessColumns}
          dataSource={data.accessRecords}
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 8, showSizeChanger: false }}
        />
      </section>

      <Modal
        title="打开受控页（凭证校验）"
        open={Boolean(accessTarget)}
        onCancel={() => setAccessTarget(undefined)}
        onOk={() => accessTarget && handleAccess(accessTarget)}
        okText="提交访问请求"
        cancelText="取消"
      >
        {accessTarget ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              showIcon
              type={accessTarget.status === 'active' ? 'info' : 'warning'}
              message={`将使用${viewerToken.trim() ? '输入框中的凭证' : '本行凭证'}打开 ${
                describePage(accessTarget).fileName
              } 第 ${describePage(accessTarget).page?.page ?? '?'} 页`}
            />
            <div>
              <span className="muted">将提交的凭证号</span>
              <div className="mono">{viewerToken.trim() || accessTarget.token}</div>
            </div>
          </Space>
        ) : null}
      </Modal>

      <Modal
        title="旧数据回填凭证人工核对"
        open={Boolean(reviewTarget)}
        onCancel={() => setReviewTarget(undefined)}
        onOk={submitBackfillReview}
        okText={reviewDecision === 'confirm' ? '确认范围有效' : '确认拒绝'}
        okButtonProps={{ danger: reviewDecision === 'reject' }}
        cancelText="取消"
      >
        {reviewTarget ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              showIcon
              type="info"
              message="旧数据缺少凭证，已按审批引用版本回填；该受控页未完成核对，人员范围无法自动确认。"
              description={`${describePage(reviewTarget).fileName} 第 ${
                describePage(reviewTarget).page?.page ?? '?'
              } 页，回填时人员范围：${reviewTarget.personnelScopes.join('、') || '不限制'}`}
            />
            <Select
              value={reviewDecision}
              style={{ width: '100%' }}
              onChange={setReviewDecision}
              options={[
                { value: 'confirm', label: '范围确认无误，凭证恢复有效' },
                { value: 'reject', label: '范围无法确认，拒绝该凭证' },
              ]}
            />
            <Input.TextArea
              rows={3}
              value={reviewComment}
              onChange={(event) => setReviewComment(event.target.value)}
              placeholder="记录核对依据（人员接触清单、审批引用版本等）"
            />
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}

function resolveError(error: unknown) {
  if (error && typeof error === 'object' && 'error' in error) {
    const value = (error as { error?: { error?: string } }).error
    if (value?.error) return value.error
  }
  return '操作失败'
}
