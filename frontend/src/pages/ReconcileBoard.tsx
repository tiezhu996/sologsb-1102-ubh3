/**
 * /reconcile 连排对账页
 *
 * 工作流：粘贴外班日程包到「待确认区」→ 本地折子锚点 + 场序时长推出每场起止 →
 * 角色操耍人与领奏占用逐场对账 → 逐场确认；包更新后未确认场次失效重算，已确认场次留旧依据。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  FileDoneOutlined,
  FileSearchOutlined,
  ImportOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useReconStore } from '../stores/reconStore';
import { DAY_BASE_HOUR, WEEKDAY_LABEL, WEEKDAY_OPTIONS, minuteToClock, type Weekday } from '../types/operator';
import { RECON_PROBLEM_KIND_LABEL, RECON_STATUS_META, type ReconProblem } from '../types/rehearsal';
import type { AttendanceFactRow, AttendancePackRow, PlanBlockRow, ReconEntryRow } from '../utils/db';
import { formatStamp } from '../utils/uuid';

interface BlockForm {
  playId: string | null;
  start: dayjs.Dayjs;
}

const PROBLEM_COLOR: Record<ReconProblem['kind'], string> = {
  unassigned: 'default',
  missingRecord: 'warning',
  coverageGap: 'orange',
  doubleBooked: 'error',
};

function offsetToDayjs(offsetMinute: number): dayjs.Dayjs {
  const total = DAY_BASE_HOUR * 60 + offsetMinute;
  const hour = Math.floor(total / 60) % 24;
  return dayjs().hour(hour).minute(total % 60).second(0);
}

const SAMPLE_PACK = `霍连生
周一 08:00-12:00
苗凤仪
周一 08:00-11:30
裴三保
周一 09:00-12:00
闻小楼
周一 08:00-10:00`;

export default function ReconcileBoard() {
  const { message, modal } = App.useApp();
  const {
    loading,
    error,
    plan,
    blocks,
    entries,
    packs,
    facts,
    plays,
    scenes,
    operators,
    draftText,
    loadRecon,
    setDraftText,
    clearDraft,
    setWeekday,
    upsertBlock,
    removeBlock,
    importPack,
    deletePack,
    activatePack,
    confirmEntry,
    unconfirmEntry,
    recompute,
  } = useReconStore();

  const [importing, setImporting] = useState(false);
  const [parseError, setParseError] = useState('');
  const [blockForm, setBlockForm] = useState<BlockForm>({
    playId: null,
    start: dayjs().hour(DAY_BASE_HOUR).minute(0),
  });

  useEffect(() => {
    void loadRecon();
  }, [loadRecon]);

  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);

  const sceneById = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  const playById = useMemo(() => new Map(plays.map((play) => [play.id, play])), [plays]);
  const blockById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const operatorById = useMemo(() => new Map(operators.map((operator) => [operator.id, operator])), [operators]);
  const factsByPack = useMemo(() => {
    const map = new Map<string, AttendanceFactRow[]>();
    facts.forEach((fact) => {
      const list = map.get(fact.packId) ?? [];
      list.push(fact);
      map.set(fact.packId, list);
    });
    return map;
  }, [facts]);

  const entriesOrdered = useMemo(
    () =>
      [...entries].sort((a, b) => {
        const blockOrder =
          (blockById.get(a.blockId)?.sortOrder ?? 0) - (blockById.get(b.blockId)?.sortOrder ?? 0);
        if (blockOrder !== 0) return blockOrder;
        const sceneA = sceneById.get(a.sceneId);
        const sceneB = sceneById.get(b.sceneId);
        return (sceneA?.seq ?? 0) - (sceneB?.seq ?? 0);
      }),
    [entries, blockById, sceneById],
  );

  const stats = useMemo(() => {
    const allProblems = entries.flatMap((entry) => entry.problems);
    return {
      scenes: entries.length,
      confirmed: entries.filter((entry) => entry.confirmed).length,
      conflict: entries.filter((entry) => entry.status === 'conflict').length,
      needInfo: entries.filter((entry) => entry.status === 'needInfo').length,
      missing: allProblems.filter((problem) => problem.kind === 'missingRecord').length,
      doubleBooked: allProblems.filter((problem) => problem.kind === 'doubleBooked').length,
    };
  }, [entries]);

  const handleImport = async () => {
    if (draftText.trim() === '') {
      setParseError('请先把外班日程包文本粘进待确认区');
      return;
    }
    setImporting(true);
    setParseError('');
    try {
      const result = await importPack(draftText);
      message.success(`已导入「${result.label}」：${result.personCount} 人 / ${result.factCount} 段到场，未确认场次已重算`);
      result.warnings.forEach((warning) => message.warning(warning));
    } catch (importError) {
      // 导入失败：草稿原样保留，可直接改完重试
      setParseError(importError instanceof Error ? importError.message : '导入失败，请检查文本后重试');
    } finally {
      setImporting(false);
    }
  };

  const handleAddBlock = async () => {
    if (!blockForm.playId) {
      message.warning('请先选一出要纳入连排的剧目');
      return;
    }
    const anchor = blockForm.start.hour() * 60 + blockForm.start.minute() - DAY_BASE_HOUR * 60;
    await upsertBlock(blockForm.playId, anchor);
    message.success('折子已纳入连排，场次按本地场序与时长重排');
    setBlockForm((prev) => ({ ...prev, playId: null }));
  };

  const handleDeletePack = (pack: AttendancePackRow) => {
    modal.confirm({
      title: `删除日程包「${pack.label}」？`,
      content:
        plan?.activePackId === pack.id
          ? '它是当前对账依据：删除后未确认场次将按「无到场包」重算（全部占用转待补），已确认场次保留旧依据。'
          : '已确认场次与当前未确认结论不受影响。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => deletePack(pack.id).then(() => message.success('日程包已删除')),
    });
  };

  const occupantTags = (entry: ReconEntryRow) =>
    (entry.evidence?.occupants ?? []).map((occupant) => (
      <Tag
        key={`${occupant.kind}-${occupant.refId}`}
        color={occupant.operatorId === null ? 'default' : occupant.kind === 'cue' ? 'blue' : '#7a1f1f'}
        style={{ marginBottom: 4 }}
      >
        {occupant.label}→{occupant.operatorName}
      </Tag>
    ));

  const entryColumns: ColumnsType<ReconEntryRow> = [
    {
      title: '折子 / 场次',
      key: 'scene',
      width: 220,
      render: (_value, record) => {
        const block = blockById.get(record.blockId);
        const play = block ? playById.get(block.playId) : undefined;
        const scene = sceneById.get(record.sceneId);
        return (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{play?.title ?? '（剧目已删除）'}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {scene ? `第 ${scene.seq} 场 · ${scene.title}` : '（场次已删除）'}
              {record.confirmed ? <Tag color="success" style={{ marginInlineStart: 6 }}>已确认</Tag> : null}
              {record.dirty ? (
                <Tooltip title="该场所依赖的到场包、场序时长或指派已变化；当前展示的是确认时的旧依据，解冻后才会重算">
                  <Tag color="warning" style={{ marginInlineStart: 4 }}>依据已更新</Tag>
                </Tooltip>
              ) : null}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: `起止（${WEEKDAY_LABEL[(plan?.weekday ?? 1) as Weekday]}）`,
      key: 'range',
      width: 150,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span className="gb-mono" style={{ fontWeight: 600 }}>
            {minuteToClock(record.startMinute)} - {minuteToClock(record.endMinute)}
          </span>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {record.endMinute - record.startMinute} 分钟·本地场序
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '占用（角色 / 领奏）',
      key: 'occupants',
      width: 260,
      render: (_value, record) => (
        <div>{occupantTags(record).length > 0 ? occupantTags(record) : <Typography.Text type="secondary">无占用</Typography.Text>}</div>
      ),
    },
    {
      title: '对账问题',
      key: 'problems',
      render: (_value, record) => {
        if (record.problems.length === 0) {
          return <Tag color="success">到场全覆盖，无撞档</Tag>;
        }
        return (
          <Space direction="vertical" size={3}>
            {record.problems.map((problem, index) => (
              <Space key={`${problem.kind}-${index}`} size={6}>
                <Tag color={PROBLEM_COLOR[problem.kind]}>{RECON_PROBLEM_KIND_LABEL[problem.kind]}</Tag>
                <Typography.Text
                  type={problem.kind === 'doubleBooked' ? 'danger' : problem.kind === 'missingRecord' ? 'warning' : undefined}
                  style={{ fontSize: 12 }}
                >
                  {problem.text}
                </Typography.Text>
              </Space>
            ))}
          </Space>
        );
      },
    },
    {
      title: '结论',
      key: 'status',
      width: 92,
      render: (_value, record) => {
        const meta = RECON_STATUS_META[record.status];
        return <Tag color={meta.color} style={{ fontWeight: 600 }}>{meta.label}</Tag>;
      },
    },
    {
      title: '依据',
      key: 'evidence',
      width: 150,
      render: (_value, record) => {
        const evidence = record.evidence;
        if (!evidence) return <Typography.Text type="secondary">无</Typography.Text>;
        const windows = evidence.windowsByOperator.flatMap((group) =>
          group.windows.map((window) => ({ key: `${group.operatorId}-${window.startMinute}`, text: `${group.operatorName} ${minuteToClock(window.startMinute)}-${minuteToClock(window.endMinute)}` })),
        );
        return (
          <Tooltip
            title={
              <Space direction="vertical" size={2}>
                <span>依据包：{evidence.packLabel}</span>
                <span>计算于 {formatStamp(evidence.computedAt)}</span>
                {windows.length > 0 ? windows.map((window) => <span key={window.key}>{window.text}</span>) : <span>包内无相关到场记录（待补，非空闲）</span>}
              </Space>
            }
          >
            <Tag style={{ cursor: 'help' }}>{evidence.packLabel.length > 10 ? `${evidence.packLabel.slice(0, 10)}…` : evidence.packLabel}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 96,
      render: (_value, record) =>
        record.confirmed ? (
          <Button size="small" onClick={() => void unconfirmEntry(record.id).then(() => message.info('已解冻，场次按当前依据重算'))}>
            解冻重算
          </Button>
        ) : (
          <Button
            size="small"
            type="primary"
            ghost
            icon={<CheckCircleOutlined />}
            onClick={() => void confirmEntry(record.id).then(() => message.success('已按当前依据冻结该场次'))}
          >
            确认
          </Button>
        ),
    },
  ];

  const addedPlayIds = new Set(blocks.map((block) => block.playId));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              <ThunderboltOutlined /> 连排对账
            </Typography.Title>
            <Typography.Text type="secondary">
              外班日程包只提供到场事实；本地场序与时长决定每场起止，角色与领奏都算占用，逐场确认冻结依据
            </Typography.Text>
          </div>
          <Space wrap>
            <Select
              style={{ width: 110 }}
              value={plan?.weekday ?? 1}
              options={[...WEEKDAY_OPTIONS]}
              onChange={(value) => void setWeekday(value)}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void recompute()} loading={loading}>
              按本地数据重算
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={4}>
            <Statistic title="连排场次" value={stats.scenes} suffix="场" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="已确认" value={stats.confirmed} valueStyle={{ color: '#2f6f4f' }} suffix="场" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="冲突" value={stats.conflict} prefix={<FileSearchOutlined />} valueStyle={{ color: '#cf1322' }} suffix="场" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="待补" value={stats.needInfo} valueStyle={{ color: '#c9963c' }} suffix="场" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="缺到场记录" value={stats.missing} suffix="处" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="两戏撞档" value={stats.doubleBooked} valueStyle={{ color: '#cf1322' }} suffix="处" />
          </Col>
        </Row>
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={14}>
          <Card
            size="small"
            title={
              <Space>
                <ImportOutlined />
                <span>待确认区 · 粘贴外班日程包</span>
                {draftText.trim() !== '' ? <Tag color="processing">草稿已保留</Tag> : null}
              </Space>
            }
            extra={
              <Space>
                <Button size="small" type="text" onClick={() => setDraftText(SAMPLE_PACK)}>
                  填入示例
                </Button>
                <Button size="small" type="text" disabled={draftText === ''} onClick={() => { clearDraft(); setParseError(''); }}>
                  清空
                </Button>
              </Space>
            }
          >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Input.TextArea
                rows={9}
                value={draftText}
                onChange={(event) => {
                  setDraftText(event.target.value);
                  if (parseError) setParseError('');
                }}
                placeholder={'姓名独占一行，下面跟可到场时段，支持并列多人，例如：\n霍连生\n周一 08:00-12:00\n苗凤仪、裴三保\n周一 09:00-11:30'}
                style={{ fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13 }}
              />
              {parseError ? (
                <Alert
                  type="error"
                  showIcon
                  message="导入失败，草稿已原样保留，可修改后直接重试"
                  description={parseError}
                />
              ) : null}
              <Alert
                type="info"
                showIcon
                style={{ fontSize: 12 }}
                message="包只提供「姓名 + 可到场时段」事实；老剧目若在包里查无到场记录，一律标待补，绝不当作空闲。写入为整包事务，失败不留半套。"
              />
              <Space>
                <Button type="primary" icon={<ImportOutlined />} loading={importing} onClick={() => void handleImport()}>
                  导入并重算未确认场次
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  当前依据：{plan?.activePackId ? packs.find((pack) => pack.id === plan.activePackId)?.label ?? '（包已删除）' : '无到场包（全部占用待补）'}
                </Typography.Text>
              </Space>
            </Space>
          </Card>

          <Card size="small" style={{ marginTop: 16 }} title={<Space><ClockCircleOutlined />连排折子与开排锚点</Space>}>
            <Space wrap style={{ marginBottom: 12 }}>
              <Select
                showSearch
                style={{ width: 240 }}
                placeholder="选择纳入连排的剧目"
                value={blockForm.playId}
                optionFilterProp="label"
                options={plays
                  .filter((play) => !addedPlayIds.has(play.id))
                  .map((play) => ({ value: play.id, label: play.title }))}
                onChange={(value) => setBlockForm((prev) => ({ ...prev, playId: value }))}
              />
              <TimePicker
                format="HH:mm"
                minuteStep={15}
                value={blockForm.start}
                onChange={(value) => value && setBlockForm((prev) => ({ ...prev, start: value }))}
                allowClear={false}
              />
              <Button type="primary" ghost onClick={() => void handleAddBlock()}>
                加入连排
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                锚点后各场起止由本地场序与时长自动累加
              </Typography.Text>
            </Space>

            <Table<PlanBlockRow>
              rowKey="id"
              size="small"
              className="gb-table-compact"
              tableLayout="fixed"
              pagination={false}
              dataSource={[...blocks].sort((a, b) => a.sortOrder - b.sortOrder)}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有折子纳入本场连排" /> }}
              columns={[
                {
                  title: '顺序',
                  dataIndex: 'sortOrder',
                  width: 60,
                  render: (value: number) => <Tag>{value + 1}</Tag>,
                },
                {
                  title: '剧目',
                  key: 'play',
                  render: (_value, record) => playById.get(record.playId)?.title ?? '（剧目已删除）',
                },
                {
                  title: '开排锚点',
                  key: 'anchor',
                  width: 190,
                  render: (_value, record) => (
                    <TimePicker
                      size="small"
                      format="HH:mm"
                      minuteStep={15}
                      allowClear={false}
                      value={offsetToDayjs(record.anchorStartMinute)}
                      onChange={(value) => {
                        if (!value) return;
                        const offset = value.hour() * 60 + value.minute() - DAY_BASE_HOUR * 60;
                        void upsertBlock(record.playId, offset);
                      }}
                    />
                  ),
                },
                {
                  title: '操作',
                  key: 'action',
                  width: 72,
                  render: (_value, record) => (
                      <Popconfirm
                      title="移出连排？"
                      description="该折子下的对账行（含已确认归档行）一并删除。"
                      okText="移出"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => void removeBlock(record.id).then(() => message.success('折子已移出，相关场次失效'))}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card size="small" title={<Space><FileDoneOutlined />日程包存档（按导入时间）</Space>}>
            {packs.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未导入任何日程包" />
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {packs.map((pack) => {
                  const packFacts = factsByPack.get(pack.id) ?? [];
                  const people = new Set(packFacts.map((fact) => fact.personName));
                  const isActive = plan?.activePackId === pack.id;
                  return (
                    <Card
                      key={pack.id}
                      size="small"
                      type="inner"
                      style={{ borderColor: isActive ? '#7a1f1f' : undefined, background: isActive ? '#fff8f2' : undefined }}
                      title={
                        <Space wrap size={6}>
                          <Typography.Text strong>{pack.label}</Typography.Text>
                          {isActive ? <Tag color="#7a1f1f">当前依据</Tag> : null}
                        </Space>
                      }
                      extra={
                        <Space size={4}>
                          {!isActive ? (
                            <Button size="small" type="link" onClick={() => void activatePack(pack.id).then(() => message.success('已切换依据包，未确认场次重算'))}>
                              作为依据
                            </Button>
                          ) : null}
                          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => handleDeletePack(pack)} />
                        </Space>
                      }
                    >
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          导入于 {formatStamp(pack.importedAt)} · {people.size} 人 · {packFacts.length} 段到场
                        </Typography.Text>
                        <div>
                          {[...people].map((name) => {
                            const known = operatorById.size > 0 && operators.some((operator) => operator.name === name);
                            return (
                              <Tag key={name} color={known ? 'default' : 'warning'} style={{ marginBottom: 4 }}>
                                {name}
                                {known ? '' : '·档外'}
                              </Tag>
                            );
                          })}
                        </div>
                      </Space>
                    </Card>
                  );
                })}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <div className="gb-panel">
        <div className="gb-panel-title">
          <Typography.Text strong>场次对账（{entriesOrdered.length}）</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已确认场次冻结确认时的旧依据；新包导入只重算未确认场次，解冻后才会按新依据重算
          </Typography.Text>
        </div>
        <Table<ReconEntryRow>
          rowKey="id"
          size="small"
          className="gb-table-compact"
          tableLayout="fixed"
          loading={loading}
          columns={entryColumns}
          dataSource={entriesOrdered}
          pagination={false}
          rowClassName={(record) => (record.confirmed ? 'gb-row-confirmed' : record.dirty ? 'gb-row-dirty' : '')}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="先在左侧导入日程包并把剧目加入连排，这里会按本地场序与时长逐场列出对账结论"
              />
            ),
          }}
        />
      </div>
    </Space>
  );
}
