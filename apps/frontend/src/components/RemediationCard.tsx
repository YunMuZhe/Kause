import React, { useState } from 'react';
import {
    Zap,
    Check,
    X,
    Loader2,
    ShieldAlert,
    Terminal,
    Sparkles,
    ChevronRight,
    Eye,
    EyeOff
} from 'lucide-react';

export interface Prescription {
    intent: string;
    reasoning: string;
    tool_name: string;
    arguments: Record<string, any>;
    risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
}

interface RemediationCardProps {
    prescription: Prescription;
    clusterId?: number;
    conversationId?: number;
    initialStatus?: 'idle' | 'loading' | 'success' | 'error' | 'dismissed';
    initialResult?: string | null;
}

const RemediationCard: React.FC<RemediationCardProps> = ({
    prescription,
    clusterId,
    conversationId,
    initialStatus = 'idle',
    initialResult = null
}) => {
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error' | 'dismissed'>(initialStatus);
    const [result, setResult] = useState<string | null>(initialResult);
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);

    // Sync state with props if they change (e.g. from history load or parent update)
    React.useEffect(() => {
        setStatus(initialStatus);
        setResult(initialResult);
    }, [initialStatus, initialResult]);

    const isPatch = prescription.tool_name === 'patch_resource';
    const patchData = isPatch ? prescription.arguments.patch : null;

    const handleExecute = async () => {
        setStatus('loading');
        try {
            const response = await fetch('/api/remediation/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...prescription,
                    cluster_id: clusterId,
                    conversation_id: conversationId
                }),
            });
            const data = await response.json();
            if (data.success) {
                setStatus('success');
                setResult(data.output);
            } else {
                setStatus('error');
                setResult(data.error || data.output || 'Execution failed');
            }
        } catch (err: any) {
            setStatus('error');
            setResult(err.message);
        }
    };

    const riskColors = {
        LOW: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        MEDIUM: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        HIGH: 'bg-rose-500/10 text-rose-400 border-rose-500/20'
    };

    const DiffViewer: React.FC<{ patch: any }> = ({ patch }) => {
        try {
            let ops = patch;
            // Handle string-encoded JSON, potentially double-encoded
            for (let i = 0; i < 2; i++) {
                if (typeof ops === 'string' && (ops.startsWith('[') || ops.startsWith('"'))) {
                    try {
                        ops = JSON.parse(ops);
                    } catch (e) {
                        break;
                    }
                } else {
                    break;
                }
            }

            if (!Array.isArray(ops)) {
                return (
                    <div className="space-y-2">
                        <pre className="text-[10px] text-rose-400 p-2 bg-rose-500/5 rounded border border-rose-500/10">
                            Invalid Patch Format: Expected an array of operations.
                        </pre>
                        <pre className="text-[9px] text-slate-500 bg-black/20 p-2 rounded overflow-x-auto">
                            Received: {typeof patch === 'string' ? patch : JSON.stringify(patch, null, 2)}
                        </pre>
                    </div>
                );
            }

            return (
                <div className="space-y-3">
                    <div className="flex items-center gap-2 mb-1">
                        <Terminal size={12} className="text-blue-400/70" />
                        <span className="text-[10px] font-bold text-blue-400/70 uppercase tracking-widest">JSON Patch Operations</span>
                    </div>
                    {ops.map((op: any, idx: number) => (
                        <div key={idx} className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3 font-mono text-[11px] space-y-2">
                            <div className="flex items-center gap-2 border-b border-white/5 pb-1.5 mb-1.5">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${op.op === 'replace' ? 'bg-blue-500/20 text-blue-400' :
                                    op.op === 'add' ? 'bg-emerald-500/20 text-emerald-400' :
                                        'bg-rose-500/20 text-rose-400'
                                    }`}>
                                    {op.op}
                                </span>
                                <span className="text-[#8b949e]">{op.path}</span>
                            </div>
                            <div className="grid grid-cols-1 gap-2">
                                {op.value !== undefined && (
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[9px] text-[#484f58] font-bold uppercase">New Value:</span>
                                        <pre className="text-emerald-300 bg-emerald-500/5 p-1.5 rounded border border-emerald-500/10 overflow-x-auto">
                                            {typeof op.value === 'object' ? JSON.stringify(op.value, null, 2) : String(op.value)}
                                        </pre>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            );
        } catch (e) {
            return (
                <pre className="text-[10px] text-rose-400 p-2 bg-rose-500/5 rounded border border-rose-500/10">
                    Failed to parse patch: {e instanceof Error ? e.message : 'Unknown error'}
                </pre>
            );
        }
    };

    return (
        <div className="w-full my-6 bg-gradient-to-b from-[#161b22] to-[#0d1117] border border-[#30363d] rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-300 ring-1 ring-white/5">
            {/* Header */}
            <div className="px-6 py-4 border-b border-[#30363d] flex items-center justify-between bg-white/[0.02]">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 shadow-inner">
                        <Zap size={20} fill="currentColor" className="opacity-80" />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-white tracking-tight">{prescription.intent}</h3>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">{prescription.tool_name}</span>
                        </div>
                    </div>
                </div>
                <div className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${riskColors[prescription.risk_level] || riskColors.LOW}`}>
                    {prescription.risk_level} RISK
                </div>
            </div>

            {/* Content */}
            <div className={`p-6 space-y-5 ${status === 'dismissed' ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                <div className="flex gap-3">
                    <div className="mt-1">
                        <Sparkles size={16} className="text-blue-400/70" />
                    </div>
                    <p className="text-sm text-slate-300 leading-relaxed font-medium">
                        {prescription.reasoning}
                    </p>
                </div>

                {/* Arguments Preview */}
                <div className="bg-[#0a0c10]/60 rounded-xl p-4 border border-[#30363d]/50">
                    <div className="flex items-center gap-2 mb-3">
                        <Terminal size={12} className="text-slate-500" />
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Arguments</span>
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                        {Object.entries(prescription.arguments).map(([key, val]) => (
                            <div key={key} className="flex items-center justify-between py-1 border-b border-white/5 last:border-0">
                                <span className="text-[11px] font-mono text-slate-500">{key}</span>
                                <span className="text-[11px] font-mono text-blue-300/90 truncate max-w-[200px]">{JSON.stringify(val)}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Action Buttons */}
                {status === 'idle' && (
                    <div className="flex flex-col gap-3">
                        {isPatch && (
                            <button
                                onClick={() => setIsPreviewOpen(!isPreviewOpen)}
                                className={`w-full py-2.5 flex items-center justify-center gap-2 rounded-xl text-xs font-bold transition-all border ${isPreviewOpen
                                    ? 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                                    : 'bg-[#21262d] border-[#30363d] text-slate-400 hover:text-white hover:border-[#444c56]'
                                    }`}
                            >
                                {isPreviewOpen ? <EyeOff size={16} /> : <Eye size={16} />}
                                {isPreviewOpen ? '隐藏修复预览' : '预览修复方案'}
                            </button>
                        )}

                        {isPreviewOpen && isPatch && (
                            <div className="bg-[#0a0c10]/40 rounded-xl p-4 border border-blue-500/20 animate-in fade-in slide-in-from-top-2 duration-300">
                                <DiffViewer patch={patchData} />
                            </div>
                        )}

                        <div className="flex gap-3">
                            <button
                                onClick={async () => {
                                    setStatus('dismissed');
                                    await fetch('/api/remediation/dismiss', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            ...prescription,
                                            conversation_id: conversationId,
                                            cluster_id: clusterId
                                        }),
                                    });
                                }}
                                className="flex-shrink-0 px-4 py-3.5 bg-[#21262d] hover:bg-[#30363d] text-slate-400 hover:text-rose-400 rounded-xl transition-all border border-[#30363d] active:scale-[0.98]"
                                title="拒绝执行并结束"
                            >
                                <X size={20} />
                            </button>
                            <button
                                onClick={handleExecute}
                                disabled={isPatch && !isPreviewOpen}
                                className={`group flex-1 py-3.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all shadow-lg active:scale-[0.98] border ${isPatch && !isPreviewOpen
                                    ? 'bg-[#21262d] text-slate-500 border-[#30363d] cursor-not-allowed grayscale'
                                    : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white border-blue-400/20 shadow-blue-500/20'
                                    }`}
                            >
                                {isPatch && !isPreviewOpen ? '请先预览方案' : '执行修复操作'}
                                <ChevronRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
                            </button>
                        </div>
                    </div>
                )}

                {status === 'loading' && (
                    <div className="w-full py-3.5 bg-[#21262d] text-slate-400 rounded-xl text-sm font-bold flex items-center justify-center gap-3 border border-[#30363d]">
                        <Loader2 size={18} className="animate-spin text-blue-500" />
                        正在执行中...
                    </div>
                )}

                {/* Success State */}
                {status === 'success' && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-400">
                        <div className="w-full py-3.5 bg-emerald-500/10 text-emerald-400 rounded-xl text-sm font-bold flex items-center justify-center gap-2 border border-emerald-500/20 shadow-lg shadow-emerald-500/5">
                            <Check size={18} />
                            操作执行成功
                        </div>
                        <div className="bg-[#0a0c10] border border-emerald-500/20 rounded-xl p-4 font-mono text-[11px] text-emerald-200/80 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-emerald-500/20">
                            {result || "操作成功完成，集群状态已更新。"}
                        </div>
                    </div>
                )}

                {/* Error State */}
                {status === 'error' && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-400">
                        <div className="w-full py-3.5 bg-rose-500/10 text-rose-400 rounded-xl text-sm font-bold flex items-center justify-center gap-2 border border-rose-500/20 shadow-lg shadow-rose-500/5">
                            <X size={18} />
                            操作执行失败
                        </div>
                        <div className="bg-[#0a0c10] border border-rose-500/20 rounded-xl p-4 font-mono text-[11px] text-rose-300/80 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-rose-500/20">
                            {result || "发生未知错误，请重试或检查集群连通性。"}
                        </div>
                        <button
                            onClick={() => setStatus('idle')}
                            className="w-full py-2.5 text-[11px] font-bold text-slate-400 hover:text-white transition-colors uppercase tracking-widest"
                        >
                            重试执行
                        </button>
                    </div>
                )}

                {/* Dismissed State */}
                {status === 'dismissed' && (
                    <div className="w-full py-3 bg-[#21262d]/50 text-slate-500 rounded-xl text-[11px] font-bold flex items-center justify-center gap-2 border border-[#30363d]/50 italic">
                        该方案已被拒绝，会话已结束
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 bg-black/20 border-t border-[#30363d] flex items-center gap-2">
                <ShieldAlert size={12} className="text-slate-500" />
                <span className="text-[10px] text-slate-500 font-medium">Auto-generated by Kure Expert System • Human Approval Required</span>
            </div>
        </div>
    );
};

export default RemediationCard;
