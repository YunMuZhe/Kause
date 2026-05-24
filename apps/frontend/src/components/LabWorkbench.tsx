import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Database,
  FileSearch,
  Loader2,
  PanelLeft,
  PanelRight,
  Play,
  Search,
  Server,
  Sparkles,
  TerminalSquare,
  TimerReset,
  Waypoints,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';

type LabPreset = {
  name: string;
  label: string;
  description: string;
  serviceEntry: string;
  requestParams: Record<string, string | number>;
};

type ServiceEntryOption = {
  name: string;
  label: string;
};

type LabPresetResponse = {
  namespace: string;
  serviceEntries: ServiceEntryOption[];
  presets: LabPreset[];
};

type ToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
  resultRaw: string;
  result?: unknown;
};

type LabInvestigationResult = {
  summary: string;
  sections: Record<string, string>;
  toolCalls: ToolCall[];
  traceEvidence: Array<any>;
  dbEvidence: Array<any>;
  rawMarkdown: string;
  serviceEntry: string;
  requestParams: Record<string, string | number>;
  namespace: string;
};

type Props = {
  currentClusterId: number | null;
};

const SERVICE_PORTS: Record<string, number> = {
  'order-java-fault': 8082,
  'catalog-fault': 8080,
  'payment-fault': 8081,
};

const FALLBACK_PRESET_DATA: LabPresetResponse = {
  namespace: 'kube-copilot-lab',
  serviceEntries: [
    { name: 'order-java-fault', label: 'Java Front Door' },
    { name: 'catalog-fault', label: 'Catalog Go Service' },
    { name: 'payment-fault', label: 'Payment Go Service' },
  ],
  presets: [
    {
      name: 'baseline',
      label: '正常链路',
      description: 'Java -> catalog -> payment 全链路正常返回',
      serviceEntry: 'order-java-fault',
      requestParams: { fault: 'none', downstreamFault: 'none', fanout: 1, userId: 42, tier: 'gold' },
    },
    {
      name: 'slow-sql',
      label: '慢 SQL',
      description: 'Java 服务触发慢 SQL，并要求 agent 自动做表结构和 EXPLAIN 分析',
      serviceEntry: 'order-java-fault',
      requestParams: { fault: 'slow-sql', downstreamFault: 'none', fanout: 1, userId: 42, tier: 'gold' },
    },
    {
      name: 'null-pointer',
      label: '空指针异常',
      description: 'Java 服务先完成下游调用，再在本地触发 NullPointerException',
      serviceEntry: 'order-java-fault',
      requestParams: { fault: 'null-pointer', downstreamFault: 'none', fanout: 1, userId: 42, tier: 'gold' },
    },
    {
      name: 'db-timeout',
      label: '下游 DB 超时',
      description: '通过 Java -> catalog -> payment 链路触发 payment-fault 的 DB timeout',
      serviceEntry: 'order-java-fault',
      requestParams: { fault: 'none', downstreamFault: 'db-timeout', fanout: 1, userId: 42, tier: 'gold' },
    },
    {
      name: 'cache-stampede',
      label: '缓存击穿',
      description: '通过 Java 入口触发多次回源，观察跨服务延迟和 trace fan-out',
      serviceEntry: 'order-java-fault',
      requestParams: { fault: 'none', downstreamFault: 'cache-stampede', fanout: 5, userId: 42, tier: 'gold' },
    },
  ],
};

function renderJson(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function titleForTool(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function summarizeToolCall(toolCall: ToolCall): string {
  const args = toolCall.arguments ?? {};
  const serviceName = typeof args.service_name === 'string' ? args.service_name : '';
  const path = typeof args.path === 'string' ? args.path : '';
  const tableName = typeof args.table_name === 'string' ? args.table_name : '';
  const database = typeof args.database === 'string' ? args.database : '';

  if (toolCall.toolName === 'probe_service_http') {
    return [serviceName, path].filter(Boolean).join(' ');
  }
  if (toolCall.toolName === 'query_signoz_traces') {
    const serviceNames = typeof args.service_names === 'string' ? args.service_names : '';
    return serviceNames || 'SigNoz traces';
  }
  if (toolCall.toolName === 'describe_mysql_table') {
    return [database, tableName].filter(Boolean).join(' / ');
  }
  if (toolCall.toolName === 'list_mysql_tables') {
    return database || 'table inventory';
  }
  if (toolCall.toolName === 'explain_mysql_query') {
    return database || 'EXPLAIN plan';
  }
  return serviceName || tableName || database || '展开查看详情';
}

function parseProbeHttpStatus(toolCalls: ToolCall[], serviceEntry: string): string {
  const probeCall = toolCalls.find((item) => item.toolName === 'probe_service_http' && item.arguments?.service_name === serviceEntry);
  if (!probeCall || typeof probeCall.resultRaw !== 'string') {
    return '--';
  }
  const match = probeCall.resultRaw.match(/HTTP_STATUS:(\d{3})/);
  return match?.[1] ?? '--';
}

function parseEntryTiming(toolCalls: ToolCall[], serviceEntry: string): string {
  const probeCall = toolCalls.find((item) => item.toolName === 'probe_service_http' && item.arguments?.service_name === serviceEntry);
  const result = probeCall?.result as Record<string, any> | undefined;
  const output = typeof result?.output === 'string' ? result.output : '';
  const body = output.split('---BODY---').pop()?.trim() || '';
  try {
    const parsed = JSON.parse(body);
    const totalMs = parsed?.timing?.totalMs;
    return typeof totalMs === 'number' ? `${totalMs} ms` : '--';
  } catch {
    return '--';
  }
}

function sectionIcon(title: string) {
  if (title === '根因判断') {
    return <AlertTriangle size={16} className="text-amber-300" />;
  }
  if (title === '修复建议') {
    return <Sparkles size={16} className="text-emerald-300" />;
  }
  if (title === '证据链') {
    return <Search size={16} className="text-cyan-300" />;
  }
  return <CheckCircle2 size={16} className="text-blue-300" />;
}

function resultTone(status: string): string {
  if (status.startsWith('2')) {
    return 'text-emerald-300';
  }
  if (status.startsWith('4') || status.startsWith('5')) {
    return 'text-amber-300';
  }
  return 'text-white';
}

function PresetCard({
  preset,
  active,
  onClick,
}: {
  preset: LabPreset;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
        active
          ? 'border-blue-500/40 bg-blue-500/12 shadow-[0_0_0_1px_rgba(31,111,235,0.18)]'
          : 'border-[#273244] bg-[#0f141b] hover:border-[#38506b] hover:bg-[#111a24]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{preset.label}</div>
          <div className="mt-2 text-sm leading-6 text-[#8b949e]">{preset.description}</div>
        </div>
        <div
          className={`mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-full border ${
            active ? 'border-blue-400/40 bg-blue-500/15 text-blue-200' : 'border-[#30363d] bg-[#0d1117] text-[#8b949e]'
          }`}
        >
          <ArrowRight size={14} />
        </div>
      </div>
    </button>
  );
}

function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone: string;
}) {
  return (
    <div className="rounded-2xl border border-[#273244] bg-[#0d1117] px-4 py-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[#8b949e]">
        <Icon size={14} />
        {label}
      </div>
      <div className={`mt-3 text-[30px] font-semibold ${tone}`}>{value}</div>
      <div className="mt-2 text-xs leading-5 text-[#6e7681]">{hint}</div>
    </div>
  );
}

function SectionPanel({
  title,
  content,
  accent = 'default',
}: {
  title: string;
  content: string;
  accent?: 'default' | 'primary' | 'warning';
}) {
  const accentClass =
    accent === 'primary'
      ? 'border-blue-500/22 bg-[linear-gradient(180deg,rgba(19,28,41,0.96),rgba(11,16,24,0.96))]'
      : accent === 'warning'
        ? 'border-amber-500/18 bg-[linear-gradient(180deg,rgba(28,23,14,0.6),rgba(14,16,21,0.96))]'
        : 'border-[#30363d] bg-[#11161d]/90';

  return (
    <section className={`min-w-0 overflow-hidden rounded-3xl border p-5 xl:p-6 ${accentClass}`}>
      <div className="mb-4 flex items-center gap-2">
        {sectionIcon(title)}
        <h4 className="text-[17px] font-semibold text-white">{title}</h4>
      </div>
      <div className="min-w-0 overflow-x-auto">
        <div className="prose prose-invert prose-sm max-w-none text-[#c9d1d9]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '等待结果...'}</ReactMarkdown>
        </div>
      </div>
    </section>
  );
}

function CodePanel({
  title,
  content,
  className = '',
}: {
  title: string;
  content: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 overflow-hidden rounded-2xl border border-[#253041] bg-[#0d1117] ${className}`}>
      <div className="border-b border-[#1c2635] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#7d8590]">
        {title}
      </div>
      <pre className="max-w-full overflow-x-auto overflow-y-auto px-4 py-4 text-xs leading-7 text-[#c9d1d9]">{content || '暂无数据'}</pre>
    </div>
  );
}

function SnapshotChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[#273244] bg-[#0d1117] px-3 py-1.5 text-xs text-[#c9d1d9]">
      <span className="uppercase tracking-[0.18em] text-[#8b949e]">{label}</span>
      <span className="font-medium text-white">{value}</span>
    </div>
  );
}

const LabWorkbench: React.FC<Props> = ({ currentClusterId }) => {
  const [presetData, setPresetData] = useState<LabPresetResponse | null>(null);
  const [selectedPreset, setSelectedPreset] = useState('slow-sql');
  const [namespace, setNamespace] = useState('kube-copilot-lab');
  const [serviceEntry, setServiceEntry] = useState('order-java-fault');
  const [fault, setFault] = useState('slow-sql');
  const [downstreamFault, setDownstreamFault] = useState('none');
  const [fanout, setFanout] = useState('1');
  const [userId, setUserId] = useState('42');
  const [tier, setTier] = useState('gold');
  const [promptOverride, setPromptOverride] = useState('');
  const [result, setResult] = useState<LabInvestigationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [activeToolIndex, setActiveToolIndex] = useState(0);
  const [activeEvidenceTab, setActiveEvidenceTab] = useState<'trace' | 'db' | 'markdown'>('trace');

  useEffect(() => {
    const loadPresets = async () => {
      try {
        const response = await fetch('/api/lab/presets');
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        setPresetData(data);
        setNamespace(data.namespace);
        setNotice('');
      } catch {
        setPresetData(FALLBACK_PRESET_DATA);
        setNamespace(FALLBACK_PRESET_DATA.namespace);
        setNotice('后端暂未连接，当前使用本地演示预设渲染控制台。页面可预览，调查能力需要后端恢复后再执行。');
      }
    };
    loadPresets().catch((err) => setError(err.message || '加载实验室预设失败'));
  }, []);

  useEffect(() => {
    if (!presetData) {
      return;
    }
    const preset = presetData.presets.find((item) => item.name === selectedPreset);
    if (!preset) {
      return;
    }
    setServiceEntry(preset.serviceEntry);
    setFault(String(preset.requestParams.fault ?? 'none'));
    setDownstreamFault(String(preset.requestParams.downstreamFault ?? 'none'));
    setFanout(String(preset.requestParams.fanout ?? 1));
    setUserId(String(preset.requestParams.userId ?? 42));
    setTier(String(preset.requestParams.tier ?? 'gold'));
  }, [presetData, selectedPreset]);

  useEffect(() => {
    if (result?.toolCalls?.length) {
      setActiveToolIndex(0);
    }
  }, [result]);

  const requestParams = useMemo(
    () => ({
      fault,
      downstreamFault,
      fanout: Number(fanout || 1),
      userId: Number(userId || 42),
      tier,
    }),
    [fault, downstreamFault, fanout, userId, tier],
  );

  const currentPreset = useMemo(
    () => presetData?.presets.find((item) => item.name === selectedPreset) ?? null,
    [presetData, selectedPreset],
  );

  const curlCommand = useMemo(() => {
    const params = new URLSearchParams({
      fault,
      downstreamFault,
      fanout: String(Number(fanout || 1)),
      userId: String(Number(userId || 42)),
      tier,
    });
    const port = SERVICE_PORTS[serviceEntry] ?? 8082;
    const path =
      serviceEntry === 'order-java-fault'
        ? '/api/orders/checkout-preview'
        : serviceEntry === 'catalog-fault'
          ? '/api/catalog/items'
          : '/internal/pricing';
    return `kubectl -n ${namespace} exec deploy/${serviceEntry} -- sh -lc 'curl -sS "http://${serviceEntry}:${port}${path}?${params.toString()}"'`;
  }, [fault, downstreamFault, fanout, namespace, serviceEntry, tier, userId]);

  const traceSpanCount = useMemo(
    () => (result?.traceEvidence ?? []).reduce((sum, block) => sum + ((block?.rows?.length as number | undefined) ?? 0), 0),
    [result],
  );

  const dbEvidenceCount = useMemo(() => result?.dbEvidence?.length ?? 0, [result]);

  const httpStatus = useMemo(() => (result ? parseProbeHttpStatus(result.toolCalls, result.serviceEntry) : '--'), [result]);
  const totalLatency = useMemo(() => (result ? parseEntryTiming(result.toolCalls, result.serviceEntry) : '--'), [result]);

  const metrics = useMemo(
    () => [
      {
        label: 'HTTP 状态',
        value: httpStatus,
        hint: '入口探测返回码',
        icon: Activity,
        tone: resultTone(httpStatus),
      },
      {
        label: '入口耗时',
        value: totalLatency,
        hint: '业务入口总耗时',
        icon: TimerReset,
        tone: 'text-white',
      },
      {
        label: 'Trace 证据',
        value: `${traceSpanCount}`,
        hint: '命中的业务 spans',
        icon: Search,
        tone: traceSpanCount > 0 ? 'text-cyan-300' : 'text-[#c9d1d9]',
      },
      {
        label: 'DB 诊断',
        value: dbEvidenceCount > 0 ? 'ON' : 'OFF',
        hint: dbEvidenceCount > 0 ? '已进入 schema / explain' : '未触发 SQL 诊断',
        icon: Database,
        tone: dbEvidenceCount > 0 ? 'text-emerald-300' : 'text-[#c9d1d9]',
      },
    ],
    [dbEvidenceCount, httpStatus, totalLatency, traceSpanCount],
  );

  const activeToolCall = result?.toolCalls?.[activeToolIndex] ?? null;
  const tracePanelText = renderJson(result?.traceEvidence ?? []);
  const dbPanelText = renderJson(result?.dbEvidence ?? []);
  const rawMarkdownText = result?.rawMarkdown || '等待 agent 输出';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(curlCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const runInvestigation = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/lab/investigations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace,
          serviceEntry,
          requestPreset: selectedPreset,
          requestParams,
          promptOverride: promptOverride.trim() || undefined,
          clusterId: currentClusterId ?? undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      }
      setResult(data);
      setActiveEvidenceTab(data.dbEvidence?.length ? 'db' : 'trace');
    } catch (err: any) {
      setError(err?.message || '执行实验排查失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top,rgba(31,111,235,0.10),transparent_25%),linear-gradient(180deg,#0b0f15,#090c10)]">
      <div className="mx-auto max-w-[1820px] px-5 py-5 xl:px-8 xl:py-7">
        <section className="rounded-[28px] border border-[#30363d] bg-[linear-gradient(135deg,rgba(22,27,34,0.96),rgba(12,17,25,0.98))] px-5 py-6 shadow-[0_30px_80px_rgba(0,0,0,0.28)] xl:px-7 xl:py-7">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-4xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-blue-200">
                <Waypoints size={13} />
                Lab 2.0 Investigation Console
              </div>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white xl:text-[42px]">故障实验室</h2>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-[#9aa4af] xl:text-[15px]">
                直接触发一次真实故障，让 agent 走完 HTTP 探测、Kubernetes 诊断、SigNoz trace 检索和 SQL 证据链分析。这里展示的是一次完整 investigation 的操作台，而不是临时调试页。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <SnapshotChip label="Cluster" value={currentClusterId ? `#${currentClusterId}` : '未绑定'} />
              <SnapshotChip label="Preset" value={currentPreset?.label || '未选择'} />
              <SnapshotChip label="Entry" value={serviceEntry} />
              <button
                type="button"
                onClick={() => setLeftCollapsed((value) => !value)}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#30363d] bg-[#11161d] px-3 text-sm text-[#c9d1d9] transition hover:border-blue-500/40 hover:text-white"
              >
                <PanelLeft size={15} />
                {leftCollapsed ? '展开控制区' : '收起控制区'}
              </button>
            </div>
          </div>
        </section>

        {error && (
          <div className="mt-5 rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}

        {notice && (
          <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            {notice}
          </div>
        )}

        <div className="mt-5 flex flex-col gap-5 xl:flex-row">
          <aside
            className={`rounded-[28px] border border-[#30363d] bg-[#11161d]/90 shadow-[0_18px_60px_rgba(0,0,0,0.24)] transition-all duration-300 xl:sticky xl:top-5 xl:self-start ${
              leftCollapsed ? 'xl:w-[88px]' : 'xl:w-[388px] xl:flex-none'
            }`}
          >
            {leftCollapsed ? (
              <div className="flex h-[760px] flex-col items-center justify-between py-5">
                <div className="flex flex-col items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setLeftCollapsed(false)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-[#30363d] bg-[#0d1117] text-[#c9d1d9] transition hover:border-blue-500/40 hover:text-white"
                  >
                    <ChevronRight size={18} />
                  </button>
                  <div className="rounded-2xl border border-[#253041] bg-[#0d1117] p-3 text-blue-300">
                    <Server size={18} />
                  </div>
                  <div className="rounded-2xl border border-[#253041] bg-[#0d1117] p-3 text-cyan-300">
                    <TerminalSquare size={18} />
                  </div>
                  <div className="rounded-2xl border border-[#253041] bg-[#0d1117] p-3 text-[#8b949e]">
                    <Clipboard size={18} />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={runInvestigation}
                  disabled={loading}
                  className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-b from-[#1f6feb] to-[#0958ba] text-white shadow-lg shadow-blue-950/40 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
                </button>
              </div>
            ) : (
              <div className="p-5 xl:p-6">
                <div className="mb-6 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-xl font-semibold text-white">实验控制台</h3>
                    <p className="mt-1 text-sm leading-6 text-[#8b949e]">选择场景、微调入参、生成命令，然后发起一次结构化调查。</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLeftCollapsed(true)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#30363d] bg-[#0d1117] text-[#8b949e] transition hover:border-blue-500/40 hover:text-white"
                  >
                    <ChevronLeft size={16} />
                  </button>
                </div>

                <div className="space-y-6">
                  <div>
                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[#8b949e]">场景预设</div>
                    <div className="space-y-3">
                      {presetData?.presets.map((preset) => (
                        <PresetCard
                          key={preset.name}
                          preset={preset}
                          active={preset.name === selectedPreset}
                          onClick={() => setSelectedPreset(preset.name)}
                        />
                      )) ?? (
                        <div className="rounded-2xl border border-dashed border-[#30363d] px-4 py-5 text-sm text-[#8b949e]">加载预设中...</div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-3xl border border-[#273244] bg-[#0d1117] p-4">
                    <div className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#8b949e]">运行参数</div>
                    <div className="grid gap-4">
                      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#8b949e]">Namespace</label>
                          <Input value={namespace} onChange={(event) => setNamespace(event.target.value)} className="h-11 rounded-xl border-[#30363d] bg-[#0b1118] text-white" />
                        </div>
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#8b949e]">入口服务</label>
                          <select
                            className="h-11 w-full rounded-xl border border-[#30363d] bg-[#0b1118] px-4 text-sm text-white outline-none transition focus:border-blue-500"
                            value={serviceEntry}
                            onChange={(event) => setServiceEntry(event.target.value)}
                          >
                            {presetData?.serviceEntries.map((entry) => (
                              <option key={entry.name} value={entry.name}>
                                {entry.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#8b949e]">Java 故障</label>
                          <select
                            className="h-11 w-full rounded-xl border border-[#30363d] bg-[#0b1118] px-4 text-sm text-white outline-none transition focus:border-blue-500"
                            value={fault}
                            onChange={(event) => setFault(event.target.value)}
                          >
                            <option value="none">none</option>
                            <option value="slow-sql">slow-sql</option>
                            <option value="null-pointer">null-pointer</option>
                            <option value="db-timeout">db-timeout</option>
                            <option value="cache-stampede">cache-stampede</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#8b949e]">下游故障</label>
                          <select
                            className="h-11 w-full rounded-xl border border-[#30363d] bg-[#0b1118] px-4 text-sm text-white outline-none transition focus:border-blue-500"
                            value={downstreamFault}
                            onChange={(event) => setDownstreamFault(event.target.value)}
                          >
                            <option value="none">none</option>
                            <option value="db-timeout">db-timeout</option>
                            <option value="cache-stampede">cache-stampede</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#8b949e]">Fanout</label>
                          <Input value={fanout} onChange={(event) => setFanout(event.target.value)} className="h-11 rounded-xl border-[#30363d] bg-[#0b1118] text-white" />
                        </div>
                        <div>
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#8b949e]">User ID</label>
                          <Input value={userId} onChange={(event) => setUserId(event.target.value)} className="h-11 rounded-xl border-[#30363d] bg-[#0b1118] text-white" />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#8b949e]">Tier</label>
                          <Input value={tier} onChange={(event) => setTier(event.target.value)} className="h-11 rounded-xl border-[#30363d] bg-[#0b1118] text-white" />
                        </div>
                      </div>

                      <div>
                        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#8b949e]">附加提示</label>
                        <textarea
                          value={promptOverride}
                          onChange={(event) => setPromptOverride(event.target.value)}
                          className="min-h-[112px] w-full rounded-2xl border border-[#30363d] bg-[#0b1118] px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-blue-500"
                          placeholder="例如：更关注 traces、只输出应用层根因、需要补探测哪个服务。"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-3xl border border-[#273244] bg-[#0d1117] p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8b949e]">复现命令</div>
                        <div className="mt-1 text-xs text-[#6e7681]">和当前控制区完全一致，可独立复现实验。</div>
                      </div>
                      <button
                        type="button"
                        onClick={handleCopy}
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-blue-300 transition hover:bg-white/5 hover:text-blue-200"
                      >
                        <Clipboard size={12} />
                        {copied ? '已复制' : '复制'}
                      </button>
                    </div>
                    <pre className="max-h-[220px] overflow-auto rounded-2xl bg-[#05070a] p-4 text-xs leading-6 text-[#c9d1d9]">{curlCommand}</pre>
                  </div>

                  <Button
                    onClick={runInvestigation}
                    disabled={loading}
                    className="h-12 w-full rounded-2xl bg-gradient-to-r from-[#1f6feb] to-[#0969da] text-sm font-semibold text-white shadow-lg shadow-blue-950/40 hover:brightness-110"
                  >
                    {loading ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Sparkles size={16} className="mr-2" />}
                    {loading ? '排查中...' : '开始排查'}
                  </Button>
                </div>
              </div>
            )}
          </aside>

          <main className="min-w-0 flex-1 space-y-5">
            <section className="rounded-[28px] border border-[#30363d] bg-[#11161d]/92 p-5 shadow-[0_20px_70px_rgba(0,0,0,0.2)] xl:p-6">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-2xl font-semibold text-white">结构化结论</h3>
                      {result && (
                        <span className="inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">
                          Investigation Completed
                        </span>
                      )}
                      {loading && (
                        <span className="inline-flex items-center rounded-full border border-blue-500/25 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-200">
                          <Loader2 size={12} className="mr-2 animate-spin" />
                          Running
                        </span>
                      )}
                    </div>
                    <p className="mt-3 max-w-4xl text-[15px] leading-7 text-[#c9d1d9]">
                      {result?.summary || '先在左侧确认场景和入参，然后触发一次真实调查。这里优先显示本次实验的症状、根因和修复建议。'}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <SnapshotChip label="Fault" value={fault} />
                      <SnapshotChip label="Downstream" value={downstreamFault} />
                      <SnapshotChip label="Fanout" value={String(requestParams.fanout)} />
                      <SnapshotChip label="Tier" value={tier} />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 xl:w-full xl:max-w-[500px] 2xl:max-w-[820px] 2xl:grid-cols-4">
                    {metrics.map((metric) => (
                      <KpiCard
                        key={metric.label}
                        label={metric.label}
                        value={metric.value}
                        hint={metric.hint}
                        icon={metric.icon}
                        tone={metric.tone}
                      />
                    ))}
                  </div>
                </div>

                <div className="grid gap-5 xl:grid-cols-[1.18fr_0.82fr]">
                  <SectionPanel title="当前症状" content={result?.sections?.['当前症状'] || ''} accent="primary" />
                  <SectionPanel title="根因判断" content={result?.sections?.['根因判断'] || ''} accent="warning" />
                </div>

                <SectionPanel title="修复建议" content={result?.sections?.['修复建议'] || ''} accent="primary" />

                <div className="grid gap-5 xl:grid-cols-[1.04fr_0.96fr]">
                  <SectionPanel title="证据链" content={result?.sections?.['证据链'] || ''} />
                  <SectionPanel title="工具调用" content={result?.sections?.['工具调用'] || ''} />
                </div>
              </div>
            </section>

            <section className="rounded-[28px] border border-[#30363d] bg-[#11161d]/92 p-5 shadow-[0_20px_70px_rgba(0,0,0,0.2)] xl:p-6">
              <div className="mb-5 flex flex-col gap-2 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <h3 className="text-xl font-semibold text-white">调查时间线</h3>
                  <p className="mt-1 text-sm leading-6 text-[#8b949e]">
                    左侧是工具调用时间线，右侧集中查看当前步骤的参数、输出和附属 evidence。这里更适合复盘 agent 走过的路径，而不是只看最终结论。
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex items-center gap-2 rounded-full border border-[#253041] bg-[#0d1117] px-3 py-1.5 text-xs text-[#8b949e]">
                    <Search size={13} />
                    {result?.toolCalls?.length ?? 0} steps
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectorCollapsed((value) => !value)}
                    className="inline-flex items-center gap-2 rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-xs font-semibold text-[#c9d1d9] transition hover:border-blue-500/35 hover:text-white"
                  >
                    <PanelRight size={14} />
                    {inspectorCollapsed ? '展开详情面板' : '收起详情面板'}
                  </button>
                </div>
              </div>

              <div className={`grid gap-5 ${inspectorCollapsed ? 'xl:grid-cols-1' : 'xl:grid-cols-[0.9fr_1.1fr]'}`}>
                <div className="min-w-0 rounded-3xl border border-[#273244] bg-[#0d1117] p-3">
                  <div className="mb-3 px-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8b949e]">Step List</div>
                  <div className="max-h-[760px] space-y-2 overflow-y-auto pr-1">
                    {result?.toolCalls?.length ? (
                      result.toolCalls.map((toolCall, index) => {
                        const selected = index === activeToolIndex;
                        return (
                          <button
                            key={`${toolCall.toolName}-${index}`}
                            type="button"
                            onClick={() => setActiveToolIndex(index)}
                            className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                              selected
                                ? 'border-blue-500/40 bg-blue-500/10 shadow-[0_0_0_1px_rgba(31,111,235,0.12)]'
                                : 'border-[#253041] bg-[#0b1118] hover:border-[#38506b] hover:bg-[#101824]'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <div
                                className={`mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold ${
                                  selected ? 'bg-blue-500 text-white' : 'bg-[#161b22] text-[#8b949e]'
                                }`}
                              >
                                {index + 1}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="text-sm font-semibold text-white">{titleForTool(toolCall.toolName)}</div>
                                  <span className="rounded-full border border-[#2d3c52] bg-[#111927] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[#8b949e]">
                                    {toolCall.toolName}
                                  </span>
                                </div>
                                <div className="mt-1 overflow-x-auto text-sm leading-6 text-[#9aa4af]">{summarizeToolCall(toolCall)}</div>
                              </div>
                            </div>
                          </button>
                        );
                      })
                    ) : (
                      <div className="rounded-2xl border border-dashed border-[#30363d] px-4 py-6 text-sm text-[#8b949e]">等待工具调用结果。</div>
                    )}
                  </div>
                </div>

                <div className={`min-w-0 space-y-5 ${inspectorCollapsed ? 'hidden' : ''}`}>
                  <div className="rounded-3xl border border-[#273244] bg-[#0d1117] p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8b949e]">当前步骤</div>
                        <div className="mt-1 text-base font-semibold text-white">
                          {activeToolCall ? titleForTool(activeToolCall.toolName) : '等待选择'}
                        </div>
                      </div>
                      {activeToolCall && (
                        <div className="rounded-full border border-[#2d3c52] bg-[#111927] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[#8b949e]">
                          Step {activeToolIndex + 1}
                        </div>
                      )}
                    </div>
                    <div className="space-y-4">
                      <CodePanel title="Arguments" content={renderJson(activeToolCall?.arguments ?? {})} />
                      <CodePanel title="Result" content={renderJson(activeToolCall?.result ?? activeToolCall?.resultRaw ?? '')} className="max-h-[360px]" />
                    </div>
                  </div>

                  <div className="rounded-3xl border border-[#273244] bg-[#0d1117] p-4">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8b949e]">附属证据</div>
                        <div className="mt-1 text-base font-semibold text-white">Trace / SQL / Markdown</div>
                      </div>
                      <div className="inline-flex rounded-xl border border-[#253041] bg-[#111827] p-1">
                        {[
                          { key: 'trace', label: 'Trace', icon: Search },
                          { key: 'db', label: 'SQL', icon: Database },
                          { key: 'markdown', label: 'Raw', icon: FileSearch },
                        ].map((tab) => {
                          const Icon = tab.icon;
                          const active = activeEvidenceTab === tab.key;
                          return (
                            <button
                              key={tab.key}
                              type="button"
                              onClick={() => setActiveEvidenceTab(tab.key as 'trace' | 'db' | 'markdown')}
                              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                                active ? 'bg-blue-500/15 text-white' : 'text-[#8b949e] hover:text-white'
                              }`}
                            >
                              <Icon size={13} />
                              {tab.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {activeEvidenceTab === 'trace' && <CodePanel title="Trace Evidence" content={tracePanelText} className="max-h-[360px]" />}
                    {activeEvidenceTab === 'db' && <CodePanel title="DB Evidence" content={dbPanelText} className="max-h-[360px]" />}
                    {activeEvidenceTab === 'markdown' && <CodePanel title="Raw Markdown" content={rawMarkdownText} className="max-h-[360px]" />}
                  </div>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
};

export default LabWorkbench;
