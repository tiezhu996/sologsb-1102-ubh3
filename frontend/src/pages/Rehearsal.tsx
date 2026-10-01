/**
 * /rehearsal 连排对账
 * 外班日程包只提供到场事实（姓名 + 可到场时段），粘入待确认区后导入；
 * 本地场序与场次时长决定每场起止，角色操耍人与锣鼓点领奏都算占用。
 * 包更新后，依赖该时段的未确认场次失效重算，已确认场次留下旧依据；
 * 导入失败保留草稿可重试，写入走单事务不留半套；老剧目缺到场记录标「待补」，不当作空闲。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { EmptyState } from '../components/common/EmptyState';
import { useRehearsalStore } from '../stores/rehearsalStore';
import { JOINT_STATUS_COLOR, JOINT_STATUS_LABEL, OCCUPATION_KIND_LABEL, minuteToClockLocal } from '../types/rehearsal';
import { WEEKDAY_LABEL } from '../types/operator';
import type { JointSessionRow } from '../utils/db';
import { detectSessionConflicts } from '../utils/sessionConflicts';
import { formatStamp } from '../utils/uuid';
import { STORAGE_KEYS, readLocalJson, writeLocalJson } from '../utils/localStore';

const WEEKDAY_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 演示用示例日程包（覆盖周一巡演日，刻意让一人缺记录以演示「待补」） */
const SAMPLE_PACKAGE = `周一 霍连生 08:00-12:00
周一 苗凤仪 08:30-11:30
周一 裴三保 09:00-12:30
周一 闻小楼 08:00-10:30, 13:00-17:00
周二 霍连生 08:00-11:00
周二 苗凤仪 14:00-17:30`;

export default function Rehearsal() {
  const { message } = App.useApp();

  const activePackage = useRehearsalStore((state) => state.activePackage);
  const packages = useRehearsalStore((state) => state.packages);
  const sessions = useRehearsalStore((state) => state.sessions);
  const local = useRehearsalStore((state) => state.local);
  const loading = useRehearsalStore((state) => state.loading);
  const error = useRehearsalStore((state) => state.error);
  const load = useRehearsalStore((state) => state.load);
  const importPackage = useRehearsalStore((state) => state.importPackage);
  const recompute = useRehearsalStore((state) => state.recompute);
  const refreshStale = useRehearsalStore((state) => state.refreshStale);
  const confirmSession = useRehearsalStore((state) => state.confirmSession);
  const unconfirmSession = useRehearsalStore((state) => state.unconfirmSession);
  const isStale = useRehearsalStore((state) => state.isStale);

  // 草稿存 localStorage：导入失败/刷新页面都不丢，可改后重试
  const [draft, setDraft] = useState<string>(() => {
    const saved = readLocalJson<string>(STORAGE_KEYS.rehearsalPackageDraft, '');
    return typeof saved === 'string' ? saved : '';
  });
  const [importing, setImporting] = useState(false);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [playFilter, setPlayFilter] = useState<string[]>(() =>
    readLocalJson<string[]>(STORAGE_KEYS.rehearsalPlayFilter, []),
  );

  useEffect(() => {
    void (async () => {
      await load();
      // 本地场序/时长/指派可能在其他页面被改过：进入页面时让过期的未确认场次自动重算
      const refreshed = await refreshStale();
      if (refreshed) message.info('检测到本地场序或指派已调整，未确认场次已按新依据重算');
    })();
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);

  const updateDraft = (value: string): void => {
    setDraft(value);
    writeLocalJson(STORAGE_KEYS.rehearsalPackageDraft, value);
  };

  const updatePlayFilter = (value: string[]): void => {
    setPlayFilter(value);
    writeLocalJson(STORAGE_KEYS.rehearsalPlayFilter, value);
  };

  const handleImport = async (): Promise<void> => {
    setImporting(true);
    setParseWarnings([]);
    try {
      const outcome = await importPackage(draft);
      if (!outcome.ok) {
        setParseWarnings(outcome.warnings);
        message.error(outcome.error ?? '导入失败，草稿已保留，可修改后重试');
        return;
      }
      message.success(`日程包已生效：识别 ${outcome.entryCount} 条到场记录，未确认场次已重算`);
      if (outcome.warnings.length > 0) setParseWarnings(outcome.warnings);
      // 成功后清空草稿
      updateDraft('');
    } catch (err) {
      // 写入回滚时库内仍是旧包，草稿保留
      message.error(`写入被回滚（未留半套数据）：${err instanceof Error ? err.message : '未知错误'}，可直接重试`);
    } finally {
      setImporting(false);
    }
  };

  const conflicts = useMemo(() => detectSessionConflicts(sessions), [sessions]);

  const visibleSessions = useMemo(() => {
    const activeId = activePackage?.id ?? null;
    const filterSet = new Set(playFilter);
    return sessions
      .filter((session) => {
        // 当前包的全部场次 + 历史包里已确认保留的场次（旧依据）
        const inScope = session.packageId === activeId || session.status === 'confirmed';
        const inPlay = filterSet.size === 0 || filterSet.has(session.playId);
        return inScope && inPlay;
      })
      .sort((a, b) => {
        if (a.weekday !== b.weekday) return (a.weekday ?? 9) - (b.weekday ?? 9);
        return (a.startMinute ?? 9999) - (b.startMinute ?? 9999);
      });
  }, [sessions, playFilter, activePackage]);

  const stats = useMemo(() => {
    const placed = visibleSessions.filter((item) => item.status === 'unconfirmed').length;
    const confirmed = visibleSessions.filter((item) => item.status === 'confirmed').length;
    const pending = visibleSessions.filter((item) => item.status === 'pending').length;
    const blocked = visibleSessions.filter((item) => item.status === 'blocked').length;
    const conflictCount = visibleSessions.filter((item) => (conflicts.get(item.id)?.length ?? 0) > 0).length;
    return { placed, confirmed, pending, blocked, conflictCount };
  }, [visibleSessions, conflicts]);

  const playOptions = useMemo(
    () => (local?.plays ?? []).map((play) => ({ value: play.id, label: play.title })),
    [local],
  );

  const sessionColumns: ColumnsType<JointSessionRow> = [
    {
      title: '排练日/起止',
      key: 'when',
      width: 168,
      render: (_value, record) =>
        record.weekday !== null && record.startMinute !== null && record.endMinute !== null ? (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{WEEKDAY_FULL[record.weekday]}</Typography.Text>
            <Typography.Text className="gb-mono" type="secondary" style={{ fontSize: 12 }}>
              {minuteToClockLocal(record.startMinute)}-{minuteToClockLocal(record.endMinute)}
            </Typography.Text>
          </Space>
        ) : (
          <Tag icon={<ExclamationCircleOutlined />} color={JOINT_STATUS_COLOR[record.status]}>
            {JOINT_STATUS_LABEL[record.status]}
          </Tag>
        ),
    },
    {
      title: '剧目 / 场次',
      key: 'scene',
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>
            {record.playTitle}
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              第 {record.seq} 场 · {record.durationMin} 分钟
            </Typography.Text>
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.sceneTitle}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态 / 依据',
      key: 'status',
      width: 132,
      render: (_value, record) => {
        const stale = isStale(record);
        return (
          <Space direction="vertical" size={2}>
            <Tag color={JOINT_STATUS_COLOR[record.status]}>{JOINT_STATUS_LABEL[record.status]}</Tag>
            {record.status === 'confirmed' && activePackage && record.packageId !== activePackage.id ? (
              <Tooltip title={record.basisSnapshot}>
                <Tag color="default" style={{ cursor: 'help' }}>
                  依据旧包
                </Tag>
              </Tooltip>
            ) : null}
            {stale ? (
              <Tooltip title="本地场序、时长或指派已变化；已确认场次保留此旧依据，撤销确认后会按新依据重算">
                <Tag color="volcano" style={{ cursor: 'help' }}>
                  本地依据已变
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '占用（角色 + 领奏）',
      key: 'occupied',
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.occupied.map((person) => (
            <Tooltip key={`${record.id}-${person.operatorId ?? person.name}`} title={person.refs.join('、')}>
              <Tag color={person.operatorId === null ? 'orange' : 'blue'} style={{ cursor: 'help' }}>
                {person.name}
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ·{person.kinds.map((kind) => OCCUPATION_KIND_LABEL[kind]).join('/')}
                </Typography.Text>
              </Tag>
            </Tooltip>
          ))}
        </Space>
      ),
    },
    {
      title: '问题说明',
      key: 'reason',
      width: 220,
      render: (_value, record) => {
        const list = conflicts.get(record.id) ?? [];
        if (list.length === 0 && record.reason === '') return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space direction="vertical" size={2}>
            {record.reason ? (
              <Typography.Text
                type={record.status === 'pending' ? 'warning' : 'danger'}
                style={{ fontSize: 12 }}
              >
                {record.reason}
              </Typography.Text>
            ) : null}
            {list.map((conflict) => (
              <Typography.Text key={`${conflict.otherSessionId}-${conflict.operatorId}`} type="danger" style={{ fontSize: 12 }}>
                <WarningOutlined /> {conflict.describe}
              </Typography.Text>
            ))}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 112,
      render: (_value, record) =>
        record.status === 'confirmed' ? (
          <Button size="small" icon={<UndoOutlined />} onClick={() => void unconfirmSession(record.id)}>
            撤销确认
          </Button>
        ) : (
          <Tooltip title={record.weekday === null ? '只有落了时间轴的场次才能确认' : '确认后包更新也保留该场旧依据'}>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<CheckCircleOutlined />}
              disabled={record.weekday === null}
              onClick={() => void confirmSession(record.id)}
            >
              确认
            </Button>
          </Tooltip>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              连排对账
            </Typography.Title>
            <Typography.Text type="secondary">
              巡演周一批跨剧目连排：外班日程包只给「谁、几点能到场」，每场起止由本地场序与时长推算，角色操耍人和锣鼓点领奏都算占用
            </Typography.Text>
          </div>
          <Space wrap>
            <Select
              mode="multiple"
              allowClear
              maxTagCount="responsive"
              style={{ minWidth: 240 }}
              placeholder="剧目范围（不选=全部）"
              value={playFilter}
              options={playOptions}
              onChange={updatePlayFilter}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void recompute(playFilter)}>
              按当前包重算
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={4}>
            <Statistic title="待确认" value={stats.placed} prefix={<ClockCircleOutlined />} suffix="场" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="已确认" value={stats.confirmed} prefix={<CheckCircleOutlined />} suffix="场" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="待补到场" value={stats.pending} valueStyle={{ color: '#d46b08' }} suffix="场" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="排不进" value={stats.blocked} valueStyle={{ color: '#cf1322' }} suffix="场" />
          </Col>
          <Col xs={12} md={8}>
            <Statistic
              title="同时被排两出戏"
              value={stats.conflictCount}
              valueStyle={{ color: stats.conflictCount > 0 ? '#cf1322' : undefined }}
              prefix={<ThunderboltOutlined />}
              suffix={stats.conflictCount > 0 ? '场需错开' : '场'}
            />
          </Col>
        </Row>
      </div>

      {/* 待确认区：日程包文本粘贴 */}
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Typography.Text strong>
            <CloudUploadOutlined /> 外班日程包 · 待确认区
          </Typography.Text>
          <Space>
            <Button size="small" onClick={() => updateDraft(SAMPLE_PACKAGE)}>
              填入示例
            </Button>
            <Button size="small" disabled={draft === ''} onClick={() => updateDraft('')}>
              清空草稿
            </Button>
            <Button type="primary" loading={importing} disabled={draft.trim() === ''} onClick={() => void handleImport()}>
              导入并对账
            </Button>
          </Space>
        </div>

        <Input.TextArea
          rows={7}
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
          placeholder={'把外班交来的日程包文本整段粘到这里，每行一人，例如：\n周一 霍连生 08:00-12:00\n周一 苗凤仪 8点半-11点半\n周二 裴三保、闻小楼 14:00-17:00\n\n导入失败不会清掉草稿，可改完直接重试；一次导入整体落库，不会只写一半。'}
          style={{ fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace", fontSize: 13 }}
        />

        <Alert
          style={{ marginTop: 10 }}
          type="info"
          showIcon
          message="包只管到场事实，本地决定怎么排"
          description={
            <Typography.Text style={{ fontSize: 12 }}>
              解析只认姓名、排练日（周一～周日）与到场时段；缺到场记录的老剧目一律标「待补到场」，绝不会被当成空闲排进去。
              {activePackage ? (
                <>
                  当前生效包导入于 {formatStamp(activePackage.createdAt)}，覆盖 {activePackage.names.length} 人、
                  {activePackage.weekdays.map((day) => WEEKDAY_LABEL[day]).join('/')}；历史包共 {packages.length} 份。
                </>
              ) : (
                '还没有导入过日程包。'
              )}
            </Typography.Text>
          }
        />

        {parseWarnings.length > 0 ? (
          <Alert
            style={{ marginTop: 10 }}
            type="warning"
            showIcon
            message={`有 ${parseWarnings.length} 行没完全认出来（合法行已照常对账，可补全后重新导入）`}
            description={
              <Space direction="vertical" size={2}>
                {parseWarnings.slice(0, 8).map((text) => (
                  <Typography.Text key={text} type="warning" style={{ fontSize: 12 }}>
                    {text}
                  </Typography.Text>
                ))}
              </Space>
            }
          />
        ) : null}
      </div>

      {/* 对账结果 */}
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Typography.Text strong>跨剧目连排时间轴</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            同剧按场序首尾相接；已确认场次在包更新后保留旧依据，可能与新场次撞时刻，冲突会红标列出
          </Typography.Text>
        </div>

        {!activePackage ? (
          <EmptyState
            title="还没有生效的日程包"
            description="先把外班日程包文本粘进上方待确认区并导入，才能推算每场的排练日与起止时刻。"
            actionText="填入示例文本"
            onAction={() => updateDraft(SAMPLE_PACKAGE)}
          />
        ) : visibleSessions.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={playFilter.length > 0 ? '所选剧目没有连排场次，换个剧目范围试试' : '本地还没有任何场次'}
          />
        ) : (
          <Table<JointSessionRow>
            rowKey="id"
            size="small"
            className="gb-table-compact"
            tableLayout="fixed"
            loading={loading}
            columns={sessionColumns}
            dataSource={visibleSessions}
            pagination={false}
            rowClassName={(record) => ((conflicts.get(record.id)?.length ?? 0) > 0 ? 'gb-row-conflict' : '')}
          />
        )}
      </div>
    </Space>
  );
}
