import React, { useState } from 'react';
import {
    Zap,
    Check,
    X,
    Loader2,
    ShieldAlert,
    Terminal,
    Sparkles,
    ChevronRight
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

                {/* Action Button */}
                {status === 'idle' && (
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
                            className="group flex-1 py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-500/20 active:scale-[0.98] border border-blue-400/20"
                        >
                            执行修复操作
                            <ChevronRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
                        </button>
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
