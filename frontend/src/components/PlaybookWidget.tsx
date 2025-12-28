import React, { useState, useEffect } from 'react';
import {
    Settings2,
    Play,
    Loader2,
    CheckCircle2,
    AlertCircle,
    ChevronDown,
    ChevronUp,
    Terminal,
    FileText,
    Activity,
    ShieldAlert,
    ShieldCheck,
    Shield,
    Lightbulb
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DynamicForm from './DynamicForm';

export type WidgetState = 'config' | 'running' | 'finished';

interface PlaybookWidgetProps {
    playbookId: string;
    initialInputs?: Record<string, any>;
    rationale?: string;
    riskLevel?: 'low' | 'medium' | 'high';
    autoRun?: boolean;
    onFinish?: (report: string) => void;
}

const riskConfig = {
    low: {
        label: '低风险',
        color: 'text-green-400 border-green-500/30 bg-green-500/10',
        icon: ShieldCheck,
        description: '只读诊断，不会修改任何资源'
    },
    medium: {
        label: '中风险',
        color: 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10',
        icon: Shield,
        description: '可能包含安全的修改操作'
    },
    high: {
        label: '高风险',
        color: 'text-red-400 border-red-500/30 bg-red-500/10',
        icon: ShieldAlert,
        description: '可能影响服务运行，请谨慎执行'
    }
};

const PlaybookWidget: React.FC<PlaybookWidgetProps> = ({
    playbookId,
    initialInputs = {},
    rationale,
    riskLevel = 'low',
    autoRun = false,
    onFinish
}) => {
    const [playbook, setPlaybook] = useState<any>(null);
    const [state, setState] = useState<WidgetState>('config');
    const [inputs, setInputs] = useState<Record<string, any>>(initialInputs);
    const [steps, setSteps] = useState<any[]>([]);
    const [report, setReport] = useState<string | null>(null);
    const [isExpanded, setIsExpanded] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchPlaybook = async () => {
            try {
                const res = await fetch('/api/playbooks');
                const all = await res.json();
                const found = all.find((p: any) => p.id === playbookId);
                if (found) {
                    setPlaybook(found);
                    const merged = { ...found.inputs.reduce((acc: any, curr: any) => ({ ...acc, [curr.key]: curr.default || '' }), {}), ...initialInputs };
                    setInputs(merged);
                    if (autoRun) handleRun(merged);
                } else {
                    setError(`Playbook ${playbookId} not found`);
                }
            } catch (e) {
                setError("Failed to load playbook data");
            }
        };
        fetchPlaybook();
    }, [playbookId]);

    const handleRun = async (currentInputs: Record<string, any>) => {
        setState('running');
        setError(null);
        setSteps([]);

        try {
            const response = await fetch(`/api/playbooks/${playbookId}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentInputs),
            });

            if (!response.ok) throw new Error('Execution failed');

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            if (!reader) return;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim().startsWith('data: ')) {
                        const data = JSON.parse(line.trim().slice(6));
                        if (data.type === 'step_start') {
                            setSteps(prev => [...prev, { id: data.step_id, name: data.name, status: 'running' }]);
                        } else if (data.type === 'step_finish') {
                            setSteps(prev => prev.map(s => s.id === data.step_id ? { ...s, status: data.status } : s));
                        } else if (data.type === 'report') {
                            setReport(data.content);
                            onFinish?.(data.content);
                        } else if (data.type === 'error') {
                            setError(data.message);
                            setState('config');
                            return;
                        }
                    }
                }
            }
            setState('finished');
        } catch (e: any) {
            setError(e.message);
            setState('config');
        }
    };

    if (!playbook && !error) return (
        <div className="w-full p-8 bg-slate-900/40 rounded-3xl border border-slate-800/50 flex flex-col items-center justify-center gap-4 animate-pulse">
            <div className="p-4 bg-blue-500/10 rounded-2xl">
                <Loader2 size={32} className="animate-spin text-blue-500" />
            </div>
            <span className="text-sm text-slate-400 font-medium">智能排障附件加载中...</span>
        </div>
    );

    if (error) return (
        <div className="w-full p-6 bg-red-500/5 rounded-3xl border border-red-500/20 flex items-center gap-4 text-red-400 shadow-xl shadow-red-950/20">
            <div className="p-3 bg-red-500/10 rounded-xl flex-shrink-0">
                <AlertCircle size={24} />
            </div>
            <div className="flex-1">
                <h4 className="font-bold text-sm">加载失败</h4>
                <p className="text-xs opacity-70">{error}</p>
            </div>
        </div>
    );

    return (
        <div className="w-full my-6 bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-[2rem] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-500">
            {/* Widget Banner / Header */}
            <div className={`px-8 py-6 border-b border-slate-800 flex items-center justify-between transition-colors duration-500 ${state === 'finished' ? 'bg-green-500/5' : state === 'running' ? 'bg-blue-500/5' : 'bg-slate-800/20'
                }`}>
                <div className="flex items-center gap-5">
                    <div className={`p-4 rounded-2xl shadow-lg transition-all duration-500 ${state === 'finished' ? 'bg-green-600 shadow-green-900/20' :
                            state === 'running' ? 'bg-blue-600 shadow-blue-900/20 animate-pulse' :
                                'bg-slate-700'
                        }`}>
                        {state === 'finished' ? <CheckCircle2 size={24} color="white" /> :
                            state === 'running' ? <Activity size={24} color="white" /> :
                                <Settings2 size={24} color="white" />}
                    </div>
                    <div>
                        <div className="flex items-center gap-3">
                            <h3 className="text-xl font-bold text-slate-100 tracking-tight">{playbook.title}</h3>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border ${state === 'finished' ? 'text-green-400 border-green-500/30 bg-green-500/5' :
                                    state === 'running' ? 'text-blue-400 border-blue-500/30 bg-blue-500/5' :
                                        'text-slate-400 border-slate-700 bg-slate-800'
                                }`}>
                                {state === 'finished' ? 'Success' : state === 'running' ? 'Progress' : 'Config'}
                            </span>
                            {/* Risk Level Badge */}
                            {state === 'config' && riskLevel && (
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border flex items-center gap-1 ${riskConfig[riskLevel].color}`}>
                                    {React.createElement(riskConfig[riskLevel].icon, { size: 10 })}
                                    {riskConfig[riskLevel].label}
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-slate-500 mt-1 font-medium">{playbook.summary || '诊断运行插件'}</p>
                    </div>
                </div>
                {state === 'finished' && (
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="flex items-center gap-2 px-4 py-2 hover:bg-white/5 rounded-xl text-slate-400 hover:text-slate-100 transition-all font-semibold text-xs border border-transparent hover:border-slate-800"
                    >
                        {isExpanded ? (
                            <>收起详细报告 <ChevronUp size={16} /></>
                        ) : (
                            <>展开详细报告 <ChevronDown size={16} /></>
                        )}
                    </button>
                )}
            </div>

            <div className="p-8 space-y-10">
                {/* State 1: Config (Initial Form) */}
                {state === 'config' && (
                    <div className="max-w-2xl mx-auto space-y-8 animate-in slide-in-from-bottom-5 duration-700">
                        {/* Rationale Section */}
                        <div className="relative">
                            <div className="absolute inset-0 bg-blue-500/10 blur-3xl rounded-full" />
                            <div className="relative bg-slate-950/40 p-6 rounded-2xl border border-slate-800/50 backdrop-blur-md">
                                <div className="flex items-start gap-3">
                                    <div className="p-2 bg-blue-500/20 rounded-lg flex-shrink-0">
                                        <Lightbulb size={16} className="text-blue-400" />
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-xs text-blue-400 font-bold uppercase tracking-widest mb-2">推荐理由</p>
                                        <p className="text-slate-300 leading-relaxed text-sm">
                                            {rationale || "根据当前上下文，我建议执行此自动化诊断流程。请确认目标资源参数。"}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Risk Warning for high risk */}
                        {riskLevel === 'high' && (
                            <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                                <ShieldAlert size={20} className="text-red-400 flex-shrink-0" />
                                <p className="text-sm text-red-300">{riskConfig.high.description}</p>
                            </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {playbook.inputs.map((field: any) => (
                                <div key={field.key} className="group space-y-2">
                                    <label className="text-xs font-bold text-slate-500 uppercase tracking-widest px-1 transition-colors group-focus-within:text-blue-500">{field.label}</label>
                                    <div className="relative">
                                        <input
                                            type="text"
                                            value={inputs[field.key] || ''}
                                            onChange={(e) => setInputs({ ...inputs, [field.key]: e.target.value })}
                                            className="w-full px-5 py-3.5 bg-slate-950 border border-slate-800 rounded-2xl text-sm focus:ring-2 focus:ring-blue-600 focus:border-transparent outline-none transition-all placeholder:text-slate-700 shadow-inner"
                                            placeholder={field.placeholder || field.label}
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>

                        <button
                            onClick={() => handleRun(inputs)}
                            className="w-full py-5 bg-blue-600 hover:bg-blue-500 text-white rounded-3xl text-sm font-bold flex items-center justify-center gap-3 transition-all shadow-2xl shadow-blue-900/30 active:scale-95 group"
                        >
                            <Play size={18} fill="currentColor" className="group-hover:scale-110 transition-transform" />
                            开始执行自动化诊断
                        </button>
                    </div>
                )}

                {/* State 2: Running (Progress) */}
                {state === 'running' && (
                    <div className="space-y-8 animate-in fade-in duration-1000">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            {playbook.steps?.map((step: any, i: number) => {
                                const s = steps.find(st => st.id === step.id);
                                return (
                                    <div key={i} className={`relative p-5 rounded-2xl border transition-all duration-500 flex flex-col gap-3 ${s?.status === 'running' ? 'bg-blue-600/10 border-blue-500 shadow-lg shadow-blue-900/10 scale-105 z-10' :
                                            s?.status === 'success' ? 'bg-green-500/5 border-green-500/20' :
                                                s?.status === 'error' ? 'bg-red-500/5 border-red-500/20' :
                                                    'bg-slate-950/40 border-slate-800 opacity-40'
                                        }`}>
                                        <div className="flex items-center justify-between">
                                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${s?.status === 'running' ? 'bg-blue-600' :
                                                    s?.status === 'success' ? 'bg-green-600' :
                                                        s?.status === 'error' ? 'bg-red-600' :
                                                            'bg-slate-800'
                                                }`}>
                                                {s?.status === 'running' ? <Loader2 size={14} className="animate-spin text-white" /> :
                                                    s?.status === 'success' ? <CheckCircle2 size={14} className="text-white" /> :
                                                        s?.status === 'error' ? <AlertCircle size={14} className="text-white" /> :
                                                            <div className="text-[10px] font-bold text-slate-400">{i + 1}</div>}
                                            </div>
                                        </div>
                                        <span className={`text-xs font-bold uppercase tracking-wider ${s?.status === 'running' ? 'text-blue-400' :
                                                s?.status === 'success' ? 'text-green-400' :
                                                    'text-slate-500'
                                            }`}>
                                            {step.name}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="bg-slate-950/80 rounded-2xl p-4 border border-slate-800/80 flex items-center gap-4 transition-all animate-in slide-in-from-top-2">
                            <div className="p-2 bg-slate-900 rounded-lg">
                                <Terminal size={16} className="text-blue-500" />
                            </div>
                            <div className="flex-1">
                                <p className="text-xs font-mono text-slate-400 overflow-hidden text-ellipsis whitespace-nowrap">
                                    System Console: 正在初始化资源探测器并分析响应数据流...
                                </p>
                            </div>
                            <div className="flex gap-1.5 px-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" />
                                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce delay-100" />
                                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce delay-200" />
                            </div>
                        </div>
                    </div>
                )}

                {/* State 3: Finished (Result Summary) */}
                {state === 'finished' && report && (
                    <div className="space-y-8 animate-in fade-in duration-1000">
                        {/* Report Section */}
                        {isExpanded && (
                            <div className="animate-in slide-in-from-top-5 duration-700">
                                <div className="flex items-center gap-2 mb-6 text-slate-400 uppercase tracking-widest text-[10px] font-bold">
                                    <FileText size={18} className="text-blue-500" />
                                    深度诊断结论报告
                                </div>
                                <div className="bg-slate-950 p-8 rounded-[2rem] border border-slate-800 shadow-inner prose prose-slate dark:prose-invert max-w-none 
                                                prose-p:text-slate-300 prose-p:leading-relaxed prose-p:text-base
                                                prose-headings:text-slate-100 prose-headings:font-bold prose-headings:tracking-tight
                                                prose-strong:text-blue-400
                                                prose-code:bg-slate-900 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-blue-300 prose-code:before:content-none prose-code:after:content-none
                                                prose-pre:bg-slate-950 prose-pre:border prose-pre:border-slate-800 prose-pre:rounded-2xl prose-pre:p-6
                                                prose-ul:list-disc prose-li:text-slate-400
                                                selection:bg-blue-500/30">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                        {report}
                                    </ReactMarkdown>
                                </div>
                            </div>
                        )}

                        {!isExpanded && (
                            <button
                                onClick={() => setIsExpanded(true)}
                                className="w-full py-4 bg-slate-800/50 hover:bg-slate-800 text-slate-400 rounded-2xl text-[10px] font-bold uppercase tracking-widest border border-slate-800 transition-all hover:text-white"
                            >
                                点击展开详细分析报告
                            </button>
                        )}

                        <div className="flex justify-center border-t border-slate-800/50 pt-8">
                            <p className="text-[10px] text-slate-600 font-medium uppercase tracking-[0.2em]">
                                诊断已结束 • 专家建议已生成 • Agent 模式已准备就绪
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PlaybookWidget;
