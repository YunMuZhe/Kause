import React, { useState, useRef, useEffect } from 'react';
import {
    Play,
    Terminal as TerminalIcon,
    CheckCircle2,
    XCircle,
    Loader2,
    AlertTriangle,
    ChevronDown,
    ChevronUp
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface PlaybookCardProps {
    playbookId: string;
    title: string;
    rationale: string;
    args: Record<string, any>;
}

type ExecutionStatus = 'idle' | 'running' | 'success' | 'error';

const PlaybookCard: React.FC<PlaybookCardProps> = ({ playbookId, title, rationale, args }) => {
    const [status, setStatus] = useState<ExecutionStatus>('idle');
    const [logs, setLogs] = useState<string[]>([]);
    const [currentStatusMsg, setCurrentStatusMsg] = useState<string>('');
    const [report, setReport] = useState<string | null>(null);
    const [isLogExpanded, setIsLogExpanded] = useState(true);
    const [editableArgs, setEditableArgs] = useState<Record<string, any>>(args);
    const logEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs]);

    useEffect(() => {
        setEditableArgs(args);
    }, [args]);

    const handleArgChange = (key: string, value: string) => {
        setEditableArgs(prev => ({
            ...prev,
            [key]: value
        }));
    };

    const runPlaybook = async () => {
        setStatus('running');
        setLogs([]);
        setReport(null);
        setCurrentStatusMsg('Connecting...');

        try {
            const response = await fetch('/api/playbooks/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playbook_id: playbookId, params: editableArgs }),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || 'Endpoint error');
            }

            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let eventType = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.slice(7).trim();
                    } else if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));

                            if (eventType === 'status') {
                                setCurrentStatusMsg(data);
                                setLogs(prev => [...prev, `[STATUS] ${data}`]);
                            } else if (eventType === 'log') {
                                setLogs(prev => [...prev, data]);
                            } else if (eventType === 'result') {
                                if (data.success) {
                                    setStatus('success');
                                    setReport(data.report);
                                } else {
                                    setStatus('error');
                                }
                                setLogs(prev => [...prev, `[RESULT] ${data.message}`]);
                            } else if (eventType === 'error') {
                                setStatus('error');
                                setLogs(prev => [...prev, `[ERROR] ${data}`]);
                            }
                        } catch (e) {
                            console.error("Error parsing SSE data:", e);
                        }
                    }
                }
            }
        } catch (err: any) {
            setStatus('error');
            setLogs(prev => [...prev, `[FATAL] ${err.message}`]);
        }
    };

    return (
        <div className="w-full my-4 bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden shadow-xl animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header */}
            <div className="p-4 border-b border-[#30363d] bg-[#0d1117]/50 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${status === 'running' ? 'bg-blue-500/10 text-blue-400 animate-pulse' : 'bg-amber-500/10 text-amber-400'}`}>
                        <TerminalIcon size={18} />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-slate-100">{title}</h3>
                        <p className="text-xs text-slate-400 mt-0.5 font-mono">{playbookId}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {status === 'success' && <CheckCircle2 size={18} className="text-green-500" />}
                    {status === 'error' && <XCircle size={18} className="text-red-500" />}
                    <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full border ${status === 'idle' ? 'text-slate-500 border-slate-700' :
                        status === 'running' ? 'text-blue-400 border-blue-500/30' :
                            status === 'success' ? 'text-green-400 border-green-500/30' :
                                'text-red-400 border-red-500/30'
                        }`}>
                        {status}
                    </span>
                </div>
            </div>

            {/* Rationale & Args */}
            <div className="p-4 space-y-4">
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex gap-3">
                    <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-200/80 leading-relaxed italic">
                        "{rationale}"
                    </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {Object.entries(editableArgs).map(([key, value]) => (
                        <div key={key} className="bg-[#0d1117] border border-[#30363d] rounded-lg p-2 focus-within:border-blue-500/50 transition-colors group">
                            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-tighter mb-1 group-focus-within:text-blue-400 transition-colors">
                                {key.replace(/_/g, ' ')}
                            </label>
                            <input
                                type="text"
                                value={String(value)}
                                onChange={(e) => handleArgChange(key, e.target.value)}
                                disabled={status !== 'idle'}
                                className="w-full bg-transparent text-xs font-mono text-blue-300 outline-none placeholder-slate-700 disabled:opacity-70 disabled:cursor-not-allowed"
                                placeholder={`Enter ${key}...`}
                            />
                        </div>
                    ))}
                </div>

                {status === 'idle' && (
                    <button
                        onClick={runPlaybook}
                        className="w-full py-3 bg-gradient-to-br from-[#1f6feb] to-[#0969da] hover:brightness-110 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-500/10 active:scale-[0.98]"
                    >
                        <Play size={14} fill="currentColor" />
                        执行修复剧本
                    </button>
                )}
            </div>

            {/* Terminal Area */}
            {status !== 'idle' && (
                <div className="border-t border-[#30363d]">
                    <div
                        className="flex items-center justify-between px-4 py-2 bg-[#0d1117] cursor-pointer hover:bg-[#161b22] transition-colors"
                        onClick={() => setIsLogExpanded(!isLogExpanded)}
                    >
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Execution Logs</span>
                            {status === 'running' && <Loader2 size={12} className="text-blue-500 animate-spin" />}
                        </div>
                        {isLogExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </div>

                    {isLogExpanded && (
                        <div className="bg-[#0d1117] p-4 font-mono text-[11px] max-h-60 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800">
                            <div className="space-y-1">
                                {logs.map((log, i) => (
                                    <div key={i} className={`flex gap-2 ${log.startsWith('[ERROR]') ? 'text-red-400' : log.startsWith('[STATUS]') ? 'text-blue-400' : 'text-slate-300'}`}>
                                        <span className="text-slate-600 shrink-0">{i + 1}</span>
                                        <span className="break-all whitespace-pre-wrap">{log}</span>
                                    </div>
                                ))}
                                {status === 'running' && (
                                    <div className="flex gap-2 items-center text-blue-400 animate-pulse">
                                        <span className="text-slate-600 shrink-0">{logs.length + 1}</span>
                                        <span className="flex items-center gap-2">
                                            {currentStatusMsg}
                                            <span className="w-1.5 h-3 bg-blue-500 animate-blink" />
                                        </span>
                                    </div>
                                )}
                                <div ref={logEndRef} />
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Final Report */}
            {status === 'success' && report && (
                <div className="p-4 bg-green-500/5 border-t border-[#30363d]">
                    <div className="flex items-center gap-2 mb-3">
                        <CheckCircle2 size={14} className="text-green-500" />
                        <span className="text-[10px] font-bold text-green-400 uppercase tracking-widest">诊断报告汇总</span>
                    </div>
                    <div className="prose prose-invert prose-xs max-w-none text-[#c9d1d9]">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {report}
                        </ReactMarkdown>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PlaybookCard;
