import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  EyeOutlined,
  KeyOutlined,
  ReloadOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import {
  useAccessPageMutation,
  useGetWorkspaceQuery,
  useRecoverCredentialMutation,
  useRenewCredentialBothMutation,
  useRenewCredentialMutation,
  useResolveScopeCheckMutation,
  useRevokeCredentialMutation,
  useSimulateWriteFailMutation,
} from '@/app/api'
import type { AccessRecord, ScopeManualCheck, ViewCredential } from '@/types/domain'
import {
  credentialStatusColors,
  credentialStatusLabels,
  effectiveStatus,
  issueSourceLabels,
} from '@/services/credentials'

function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

export function CredentialsPage() {
  const { data, isLoading } = useGetWorkspaceQuery()
  const [renewCredential] = useRenewCredentialMutation()
  const [renewBoth] = useRenewCredentialBothMutation()
  const [revokeCredential, revokeState] = useRevokeCredentialMutation()
  const [simulateWriteFail] = useSimulateWriteFailMutation()
  const [recoverCredential, recoverState] = useRecoverCredentialMutation()
  const [accessPage, accessState] = useAccessPageMutation()
  const [resolveScopeCheck, scopeState] = useResolveScopeCheckMutation()
  const [selectedPackageId, setSelectedPackageId] = useState('')
  const [accessTarget, setAccessTarget] = useState<{ fileId: string; page: number }>()
  const [scopeTarget, setScopeTarget] = useState<ScopeManualCheck>()
  const [confirmedScopes, setConfirmedScopes] = useState<string[]>([])
  const [scopeNote, setScopeNote] = useState('')

  useEffect(() => {
    if (!selectedPackageId && data?.packages[0]) setSelectedPackageId(data.packages[0].id)
  }, [data, selectedPackageId])

  const selectedPackage = useMemo(
    () => data?.packages.find((item) => item.id === selectedPackageId),
    [data, selectedPackageId],
  )
  const packageFiles = useMemo(
    () => data?.files.filter((file) => file.packageId === selectedPackageId) ?? [],
    [data, selectedPackageId],
  )
  const credentials = useMemo(
    () =>
      (data?.credentials ?? [])
        .filter((item) => item.packageId === selectedPackageId)
        .map((item) => ({ ...item, status: effectiveStatus(item) })),
    [data, selectedPackageId],
  )
  const accessRecords = useMemo(
    () => data?.accessRecords.filter((item) => item.packageId === selectedPackageId) ?? [],
    [data, selectedPackageId],
  )
  const scopeChecks = useMemo(
    () => data?.scopeManualChecks.filter((item) => item.packageId === selectedPackageId) ?? [],
    [data, selectedPackageId],
  )
  const allScopeChecks = data?.scopeManualChecks ?? []

  if (isLoading || !data) return <div className="panel">正在加载受控页凭证...</div>

  const fileName = (fileId: string) => data.files.find((file) => file.id === fileId)?.name ?? fileId

  async function handleRenew(fileId: string) {
    if (!selectedPackage) return
    try {
      const result = await renewCredential({
        packageId: selectedPackage.id,
        fileId,
        nonce: crypto.randomUUID(),
      }).unwrap()
      if (result.renewDuplicated) message.warning(result.renewMessage ?? '续签请求重复，已保留仍有效的一份')
      else message.success(result.renewMessage ?? '已按最新版本续签短期凭证')
    } catch (error) {
      message.error(readError(error))
    }
  }

  async function handleRenewBoth(fileId: string) {
    if (!selectedPackage) return
    try {
      const result = await renewBoth({ packageId: selectedPackage.id, fileId }).unwrap()
      result.renewDuplicated
        ? message.warning(result.renewMessage ?? '两个窗口的续签只保留了一份')
        : message.info(result.renewMessage ?? '并发续签已完成')
    } catch (error) {
      message.error(readError(error))
    }
  }

  async function handleRevoke(fileId?: string) {
    if (!selectedPackage) return
    await revokeCredential({ packageId: selectedPackage.id, fileId }).unwrap()
    message.success('授权已撤回，旧凭证立即被拒绝')
  }

  async function handleAccess() {
    if (!selectedPackage || !accessTarget) return
    try {
      const result = await accessPage({
        packageId: selectedPackage.id,
        fileId: accessTarget.fileId,
        page: accessTarget.page,
      }).unwrap()
      const record = result.accessRecords[0]
      if (record?.result === 'granted') {
        message.success(
          record.controlled
            ? `第 ${record.page} 页为受控页，凭证校验通过，允许查看`
            : `第 ${record.page} 页为一般页，无需凭证，允许查看`,
        )
      } else {
        message.error(record?.deniedReason ?? '访问被拒绝')
      }
    } catch (error) {
      message.error(readError(error))
    }
    setAccessTarget(undefined)
  }

  async function handleResolveScope() {
    if (!scopeTarget) return
    try {
      await resolveScopeCheck({
        checkId: scopeTarget.id,
        confirmedScopes,
        note: scopeNote,
      }).unwrap()
      message.success('人员范围已人工确认，回填凭证作废，可重新提交审批签发')
      setScopeTarget(undefined)
      setConfirmedScopes([])
      setScopeNote('')
    } catch (error) {
      message.error(readError(error))
    }
  }

  const credentialColumns: TableColumnsType<ViewCredential> = [
    { title: '凭证编号', dataIndex: 'code', width: 150, render: (value: string) => <strong>{value}</strong> },
    {
      title: '文件 / 版本',
      width: 210,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span>{fileName(record.fileId)}</span>
          <span className="muted">{record.versionLabel}</span>
        </Space>
      ),
    },
    {
      title: '受控页',
      dataIndex: 'controlledPages',
      width: 140,
      render: (pages: number[]) => pages.map((page) => `第${page}页`).join('、'),
    },
    {
      title: '绑定人员范围',
      dataIndex: 'personnelScopes',
      width: 170,
      render: (scopes: string[]) => scopes.join('、') || <span className="muted">无特别范围</span>,
    },
    {
      title: '来源',
      dataIndex: 'issueSource',
      width: 110,
      render: (value: ViewCredential['issueSource']) => issueSourceLabels[value],
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 105,
      render: (value: ViewCredential['status']) => (
        <Tag color={credentialStatusColors[value]}>{credentialStatusLabels[value]}</Tag>
      ),
    },
    {
      title: '有效期',
      width: 280,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span className="muted">签发 {formatTime(record.issuedAt)}</span>
          <span className="muted">到期 {formatTime(record.expiresAt)}</span>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 250,
      fixed: 'right',
      render: (_, record) => {
        const live = record.status === 'active'
        return (
          <Space wrap size={2}>
            <Button
              type="link"
              size="small"
              disabled={!live}
              onClick={() => handleRenew(record.fileId)}
            >
              续签
            </Button>
            <Button
              type="link"
              size="small"
              disabled={!live}
              onClick={() => handleRenewBoth(record.fileId)}
            >
              两个窗口同时续签
            </Button>
            <Button
              type="link"
              size="small"
              danger
              disabled={!live}
              loading={revokeState.isLoading}
              onClick={() => handleRevoke(record.fileId)}
            >
              撤回授权
            </Button>
            <Button
              type="link"
              size="small"
              disabled={!live}
              onClick={async () => {
                await simulateWriteFail({ credentialId: record.id }).unwrap()
                message.warning('已模拟凭证写入失败，可用"恢复重签"按最新版本恢复')
              }}
            >
              模拟写入失败
            </Button>
            {record.status === 'write-failed' ? (
              <Button
                type="link"
                size="small"
                loading={recoverState.isLoading}
                onClick={async () => {
                  await recoverCredential({ credentialId: record.id }).unwrap()
                  message.success('已按最新版本重新签发凭证')
                }}
              >
                恢复重签
              </Button>
            ) : null}
          </Space>
        )
      },
    },
  ]

  const accessColumns: TableColumnsType<AccessRecord> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 175,
      render: (value: string) => formatTime(value),
    },
    { title: '文件', width: 180, render: (_, record) => fileName(record.fileId) },
    { title: '页码', dataIndex: 'page', width: 80, render: (page: number) => `第 ${page} 页` },
    {
      title: '页面属性',
      dataIndex: 'controlled',
      width: 90,
      render: (value: boolean) => (value ? <Tag color="red">受控</Tag> : <Tag>一般</Tag>),
    },
    {
      title: '结果',
      dataIndex: 'result',
      width: 90,
      render: (value: AccessRecord['result']) =>
        value === 'granted' ? <Tag color="success">放行</Tag> : <Tag color="error">拒绝</Tag>,
    },
    { title: '查看人', dataIndex: 'viewer', width: 100 },
    {
      title: '凭证 / 拒绝原因',
      render: (_, record) =>
        record.result === 'granted' ? (
          <span className="muted">{record.credentialId ? data.credentials.find((item) => item.id === record.credentialId)?.code ?? '受控凭证' : '一般页无凭证'}</span>
        ) : (
          <span className="finding-message">{record.deniedReason}</span>
        ),
    },
  ]

  const scopeColumns: TableColumnsType<ScopeManualCheck> = [
    { title: '文件', width: 200, render: (_, record) => fileName(record.fileId) },
    {
      title: '引用版本 / 受控页',
      width: 200,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span>{data.files.find((file) => file.id === record.fileId)?.versions.find((version) => version.id === record.versionId)?.label}</span>
          <span className="muted">{record.controlledPages.map((page) => `第${page}页`).join('、')}</span>
        </Space>
      ),
    },
    { title: '原因', dataIndex: 'note' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: ScopeManualCheck['status']) =>
        value === 'pending' ? <Tag color="warning">待人工核对</Tag> : <Tag color="success">已核对</Tag>,
    },
    {
      title: '操作',
      width: 130,
      render: (_, record) =>
        record.status === 'pending' ? (
          <Button
            type="link"
            onClick={() => {
              setScopeTarget(record)
              setConfirmedScopes(selectedPackage?.personnelScopes ?? [])
              setScopeNote('')
            }}
          >
            人工核对
          </Button>
        ) : (
          <span className="muted">{record.confirmedScopes?.join('、') || '无特别范围'}</span>
        ),
    },
  ]

  const accessOptions = packageFiles.flatMap((file) => {
    const version = file.versions.find((item) => item.id === file.referencedVersionId)
    return (version?.pages ?? []).map((page) => ({
      value: `${file.id}:${page.page}`,
      label: `${file.name} · ${version?.label} · 第 ${page.page} 页（${page.controlled ? '受控' : '一般'}）`,
    }))
  })

  const credentialTimeline = credentials.slice(0, 8).map((item) => ({
    color: item.status === 'active' ? 'green' : item.status === 'revoked' || item.status === 'invalidated' ? 'red' : 'gray',
    children: (
      <div>
        <strong>{item.code}</strong> · {fileName(item.fileId)} {item.versionLabel}
        <div className="muted">
          {credentialStatusLabels[item.status]} · {issueSourceLabels[item.issueSource]} · {item.reason}
        </div>
      </div>
    ),
  }))

  return (
    <div>
      <PageHeader
        title="受控页访问凭证"
        description="提交审批时按当前文件引用版本和人员范围为受控页签发 30 分钟短期凭证，一般页不签凭证；版本、受控标记或人员范围变化立即作废并退回待复核。"
        actions={
          <Select
            value={selectedPackageId || undefined}
            placeholder="选择资料包"
            style={{ width: 340 }}
            onChange={setSelectedPackageId}
            options={data.packages.map((item) => ({
              value: item.id,
              label: `${item.code} · ${item.title}`,
            }))}
          />
        }
      />

      {allScopeChecks.some((item) => item.status === 'pending') ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${allScopeChecks.filter((item) => item.status === 'pending').length} 条旧数据回填凭证的人员范围无法确认，已列入待人工核对。`}
          style={{ marginBottom: 14 }}
        />
      ) : null}

      {selectedPackage?.status === 'recheck' ? (
        <Alert
          type="error"
          showIcon
          message="该资料包审批路线已退回待复核"
          description="人员范围、文件现行版本或受控标记发生变化，旧凭证全部失效；请处理差异后到审批页面重新提交，将按最新版本重新签发凭证。"
          style={{ marginBottom: 14 }}
        />
      ) : null}

      {selectedPackage ? (
        <div className="two-column">
          <section className="panel">
            <div className="panel-title">
              <h3>凭证概览</h3>
              <StatusTag status={selectedPackage.status} />
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="当前人员范围">
                {selectedPackage.personnelScopes.join('、') || '无特别范围'}
              </Descriptions.Item>
              <Descriptions.Item label="有效凭证">
                {credentials.filter((item) => item.status === 'active').length} 份
              </Descriptions.Item>
              <Descriptions.Item label="审批轮次">
                {selectedPackage.currentRound ? `第 ${selectedPackage.currentRound} 轮` : '未提交'}
              </Descriptions.Item>
              <Descriptions.Item label="引用版本">
                {packageFiles
                  .map((file) => {
                    const version = file.versions.find((item) => item.id === file.referencedVersionId)
                    const mismatch = file.activeVersionId !== file.referencedVersionId
                    return `${file.name} ${version?.label ?? '—'}${mismatch ? '（与现行版本不一致）' : ''}`
                  })
                  .join('；') || '无文件'}
              </Descriptions.Item>
            </Descriptions>
            <Space style={{ marginTop: 14 }} wrap>
              <Button
                icon={<EyeOutlined />}
                type="primary"
                loading={accessState.isLoading}
                disabled={!accessOptions.length}
                onClick={() => setAccessTarget({ fileId: accessOptions[0].value.split(':')[0], page: Number(accessOptions[0].value.split(':')[1]) })}
              >
                模拟审批人打开页面
              </Button>
              <Button
                icon={<StopOutlined />}
                danger
                loading={revokeState.isLoading}
                disabled={!credentials.some((item) => item.status === 'active')}
                onClick={() => handleRevoke()}
              >
                撤回整包授权
              </Button>
            </Space>
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 14 }}
              message="受控页必须出示当前版本、当前人员范围绑定且未到期的凭证；撤回授权或凭证失效后，旧凭证马上被拒绝。"
            />
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>最近凭证动态</h3>
              <Tag>{credentials.length} 条记录</Tag>
            </div>
            {credentialTimeline.length ? <Timeline items={credentialTimeline} /> : <Alert type="info" showIcon message="尚无凭证，提交审批后自动为受控页签发。" />}
          </section>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>
            <KeyOutlined /> 受控页查看凭证
          </h3>
          <Space>
            <Tag icon={<ReloadOutlined />} color="blue">
              有效期 30 分钟
            </Tag>
            <Tag color="gold" icon={<SyncOutlined />}>
              续签 5 秒幂等窗口
            </Tag>
            <Tag color="red" icon={<ThunderboltOutlined />}>
              变更立即失效
            </Tag>
          </Space>
        </div>
        <Table
          rowKey="id"
          columns={credentialColumns}
          dataSource={credentials}
          scroll={{ x: 1500 }}
          pagination={false}
          locale={{ emptyText: '该资料包暂无受控页凭证（一般页不签凭证）' }}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>
            <ToolOutlined /> 待人工核对（旧数据回填）
          </h3>
          <Tag color={scopeChecks.length ? 'warning' : 'success'}>{scopeChecks.length} 条</Tag>
        </div>
        <Table
          rowKey="id"
          columns={scopeColumns}
          dataSource={scopeChecks}
          pagination={false}
          locale={{ emptyText: '没有待人工核对的人员范围条目' }}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>受控页访问记录</h3>
          <Tag>{accessRecords.length} 条</Tag>
        </div>
        <Table
          rowKey="id"
          columns={accessColumns}
          dataSource={accessRecords}
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: '暂无访问记录，使用"模拟审批人打开页面"生成放行或拒绝记录' }}
        />
      </section>

      <Modal
        title="模拟审批人打开页面"
        open={Boolean(accessTarget)}
        onCancel={() => setAccessTarget(undefined)}
        onOk={handleAccess}
        confirmLoading={accessState.isLoading}
        okText="申请查看"
      >
        <Select
          style={{ width: '100%' }}
          value={accessTarget ? `${accessTarget.fileId}:${accessTarget.page}` : undefined}
          options={accessOptions}
          onChange={(value) => {
            const [fileId, page] = value.split(':')
            setAccessTarget({ fileId, page: Number(page) })
          }}
        />
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          message="受控页将校验凭证绑定的文件版本、人员范围和有效期；一般页不查凭证直接放行，所有结果写入访问记录并与审批状态一起追溯。"
        />
      </Modal>

      <Modal
        title="人员范围人工核对"
        open={Boolean(scopeTarget)}
        onCancel={() => setScopeTarget(undefined)}
        onOk={handleResolveScope}
        confirmLoading={scopeState.isLoading}
        okText="确认范围并作废回填凭证"
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={scopeTarget?.note}
          description="确认后回填凭证立即作废，审批路线退回待复核，重新提交审批时按最新版本和确认范围签发。"
        />
        <Select
          mode="multiple"
          style={{ width: '100%', marginBottom: 12 }}
          placeholder="确认审批时的人员范围"
          value={confirmedScopes}
          onChange={setConfirmedScopes}
          options={['外籍人员', '第三方承包商', '双用途研发人员'].map((value) => ({ value, label: value }))}
        />
        <Input.TextArea
          rows={3}
          value={scopeNote}
          onChange={(event) => setScopeNote(event.target.value)}
          placeholder="核对依据与说明"
        />
      </Modal>
    </div>
  )
}

function readError(error: unknown): string {
  if (typeof error === 'object' && error && 'data' in error) {
    return (error.data as { error?: string }).error ?? '操作失败'
  }
  return '操作失败'
}
