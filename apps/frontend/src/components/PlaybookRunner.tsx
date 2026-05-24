import React, { useState, useEffect } from 'react';
import { Play, Loader2, CheckCircle2, AlertCircle, RefreshCw, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DynamicForm from './DynamicForm';

interface StepStatus {
    step_id: string;
    name: string;
    status: 'pending' | 'running' | 'success' | 'error';
    message?: string;
}

interface PlaybookRunnerProps {
    playbook: any;
    onClose: () => void;
}

const PlaybookRunner: React.FC<PlaybookRunnerProps> = ({ playbook, onClose }) => {
    const [inputs, setInputs] = useState<Record<string, any>>({});
    const [isRunning, setIsRunning] = useState(false);
    const [steps, setSteps] = useState<StepStatus[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [report, setReport] = useState<string | null>(null);

    useEffect(() => {
        // Initialize inputs with defaults
        const defaults: Record<string, any> = {};
        playbook.inputs.forEach((input: any) => {
            if (input.default) defaults[input.key] = input.default;
        });
        setInputs(defaults);
    }, [playbook]);

    const runPlaybook = async () => {
        setIsRunning(true);
        setSteps([]);
        setLogs([]);
        setReport(null);

        console.log(`Starting playbook: ${playbook.id} with inputs:`, inputs);

        try {
            const response = await fetch(`/api/playbooks/${playbook.id}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(inputs),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                throw new Error(errorData.detail || `Server returned ${response.status}`);
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            if (!reader) return;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');

                // Keep the last partial line in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(trimmedLine.slice(6));
                            handleEvent(data);
                        } catch (e) {
                            console.error("Failed to parse SSE JSON:", trimmedLine, e);
                        }
                    }
                }
            }
        } catch (error: any) {
            console.error("Playbook execution error:", error);
            setLogs(prev => [...prev, `[System Error] ${error.message}`]);
            setSteps(prev => prev.map(s => s.status === 'running' ? { ...s, status: 'error', message: error.message } : s));
        } finally {
            setIsRunning(false);
        }
    };

    const handleEvent = (event: any) => {
        switch (event.type) {
            case 'info':
                setLogs(prev => [...prev, event.message]);
                break;
            case 'step_start':
                setSteps(prev => [...prev, { step_id: event.step_id, name: event.name, status: 'running' }]);
                break;
            case 'step_finish':
                setSteps(prev => prev.map(s =>
                    s.step_id === event.step_id ? { ...s, status: event.status, message: event.message } : s
                ));
                break;
            case 'report':
                setReport(event.content);
                break;
            case 'error':
                setLogs(prev => [...prev, `[ERROR] ${event.message}`]);
                break;
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-900 border-l border-slate-800 animate-in slide-in-from-right duration-300 shadow-2xl">
            {/* Runner Header */}
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/50 backdrop-blur-md sticky top-0 z-10">
                <div className="flex items-center gap-3">
                    <FileText className="text-blue-400" size={20} />
                    <h2 className="font-bold text-lg">{playbook.title}</h2>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-100">
                    ✕
                </button>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="p-6 space-y-8">
                    {/* Inputs Section */}
                    {!isRunning && !report && (
                        <div className="space-y-6">
                            <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                                <p className="text-sm text-slate-400 leading-relaxed italic">
                                    {playbook.description}
                                </p>
                            </div>
                            <DynamicForm
                                fields={playbook.inputs}
                                values={inputs}
                                onChange={(key, val) => setInputs(prev => ({ ...prev, [key]: val }))}
                            />
                            <button
                                onClick={runPlaybook}
                                className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-blue-900/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
                            >
                                <Play size={18} fill="currentColor" />
                                开始自动化诊断
                            </button>
                        </div>
                    )}

                    {/* Execution Progress */}
                    {(isRunning || (steps.length > 0 && !report)) && (
                        <div className="space-y-6">
                            <div className="space-y-4">
                                {steps.map((step, idx) => (
                                    <div key={idx} className="flex items-center gap-4 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                                        <div className="flex-shrink-0">
                                            {step.status === 'running' && <Loader2 size={20} className="text-blue-500 animate-spin" />}
                                            {step.status === 'success' && <CheckCircle2 size={20} className="text-green-500" />}
                                            {step.status === 'error' && <AlertCircle size={20} className="text-red-500" />}
                                        </div>
                                        <div className="flex-1">
                                            <p className={`text-sm font-medium ${step.status === 'running' ? 'text-blue-400' : 'text-slate-200'}`}>
                                                {step.name}
                                            </p>
                                            {step.message && <p className="text-xs text-red-400 mt-1">{step.message}</p>}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Real-time Logs */}
                            <div className="bg-slate-950 rounded-xl p-4 border border-slate-800 font-mono text-xs space-y-1 h-32 overflow-y-auto">
                                {logs.map((log, i) => (
                                    <div key={i} className="text-slate-500 flex gap-2">
                                        <span className="text-slate-700 opacity-50">[{new Date().toLocaleTimeString()}]</span>
                                        <span>{log}</span>
                                    </div>
                                ))}
                                {isRunning && <div className="w-1 h-4 bg-blue-500 animate-pulse inline-block" />}
                            </div>
                        </div>
                    )}

                    {/* Final Report */}
                    {report && (
                        <div className="space-y-6 animate-in fade-in zoom-in duration-500">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-bold uppercase tracking-widest text-slate-500">诊断报告</h3>
                                <button
                                    onClick={() => setReport(null)}
                                    className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                                >
                                    <RefreshCw size={12} /> 重新分析
                                </button>
                            </div>
                            <div className="bg-slate-950/50 border border-slate-800 p-6 rounded-2xl shadow-inner prose prose-invert max-w-none prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-800">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {report}
                                </ReactMarkdown>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PlaybookRunner;
