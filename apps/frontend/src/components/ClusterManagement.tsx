import React, { useState, useEffect } from 'react';
import { X, Plus, Server, Trash2, ShieldCheck, Loader2, Info } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface Cluster {
    id: number;
    name: string;
    description?: string;
}

interface ClusterManagementProps {
    isOpen: boolean;
    onClose: () => void;
    onClusterAdded?: () => void;
}

const ClusterManagement: React.FC<ClusterManagementProps> = ({ isOpen, onClose, onClusterAdded }) => {
    const [clusters, setClusters] = useState<Cluster[]>([]);
    const [isAdding, setIsAdding] = useState(false);
    const [loading, setLoading] = useState(false);

    // New cluster form state
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [kubeconfig, setKubeconfig] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            fetchClusters();
        }
    }, [isOpen]);

    const fetchClusters = async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/clusters');
            const data = await response.json();
            setClusters(data);
        } catch (error) {
            console.error('Failed to fetch clusters:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleAddCluster = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);

        try {
            const response = await fetch('/api/clusters', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description, kubeconfig }),
            });

            if (response.ok) {
                setName('');
                setDescription('');
                setKubeconfig('');
                setIsAdding(false);
                fetchClusters();
                if (onClusterAdded) onClusterAdded();
            } else {
                const data = await response.json();
                setError(data.detail || '添加失败');
            }
        } catch (err) {
            setError('网络错误，请稍后重试');
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteCluster = async (id: number) => {
        if (!confirm('确定要删除该集群吗？关联的 MCP 服务将停止。')) return;

        try {
            await fetch(`/api/clusters/${id}`, { method: 'DELETE' });
            fetchClusters();
        } catch (err) {
            console.error('Delete failed:', err);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

            <div className="relative w-full max-w-2xl bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="px-6 py-4 border-b border-[#30363d] flex items-center justify-between bg-white/[0.02]">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400">
                            <Server size={20} />
                        </div>
                        <div>
                            <h2 className="text-sm font-bold text-white">集群管理</h2>
                            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-mono">Multi-Cluster Management Center</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 text-slate-500 hover:text-white transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-white/10">
                    {!isAdding ? (
                        <>
                            <div className="grid grid-cols-1 gap-3">
                                {clusters.map((cluster) => (
                                    <div key={cluster.id} className="group flex items-center justify-between p-4 bg-[#161b22] border border-[#30363d] rounded-xl hover:border-blue-500/50 transition-all">
                                        <div className="flex items-center gap-4">
                                            <div className="p-2 rounded-lg bg-slate-800 text-slate-400">
                                                <Server size={16} />
                                            </div>
                                            <div>
                                                <h3 className="text-sm font-semibold text-white">{cluster.name}</h3>
                                                <p className="text-xs text-slate-500">{cluster.description || '无描述'}</p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleDeleteCluster(cluster.id)}
                                            className="p-2 text-slate-600 hover:text-rose-400 transition-colors opacity-0 group-hover:opacity-100"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                ))}
                                {clusters.length === 0 && !loading && (
                                    <div className="text-center py-12 border-2 border-dashed border-[#30363d] rounded-2xl">
                                        <Server size={32} className="mx-auto text-slate-700 mb-3 opacity-20" />
                                        <p className="text-sm text-slate-500 italic">暂无集群配置，立即添加一个吧</p>
                                    </div>
                                )}
                            </div>
                            <Button
                                onClick={() => setIsAdding(true)}
                                className="w-full py-6 border-dashed border-2 border-[#30363d] bg-transparent hover:bg-white/5 text-slate-400 hover:text-white transition-all flex items-center justify-center gap-2"
                            >
                                <Plus size={18} />
                                <span>添加新 Kubernetes 集群</span>
                            </Button>
                        </>
                    ) : (
                        <form onSubmit={handleAddCluster} className="space-y-4 animate-in slide-in-from-right-4 duration-300">
                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">集群名称</label>
                                <Input
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="例如：Production-HK"
                                    required
                                    className="bg-[#0d1117] border-[#30363d] focus:border-blue-500/50 h-10"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">描述 (可选)</label>
                                <Input
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder="例如：香港可用区生产集群"
                                    className="bg-[#0d1117] border-[#30363d] focus:border-blue-500/50 h-10"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1 flex items-center justify-between">
                                    KUBECONFIG 内容
                                    <span className="flex items-center gap-1 text-emerald-500/70 lowercase normal-case font-medium">
                                        <ShieldCheck size={10} />
                                        端到端加密存储
                                    </span>
                                </label>
                                <div className="bg-blue-500/5 border border-blue-500/10 rounded-lg p-2.5 mb-2">
                                    <p className="text-[10px] text-blue-400 font-medium mb-1">如何获取？</p>
                                    <div className="font-mono text-[9px] text-slate-500 space-y-1">
                                        <p>• 本地：<code className="bg-white/5 px-1 rounded">cat ~/.kube/config</code></p>
                                        <p>• Orbstack/Docker Desktop：通常位于上述路径</p>
                                        <p>• 云平台：使用 <code className="bg-white/5 px-1 rounded">az aks get-credentials</code> 或 <code className="bg-white/5 px-1 rounded">gcloud container clusters get-credentials</code></p>
                                    </div>
                                </div>
                                <textarea
                                    value={kubeconfig}
                                    onChange={(e) => setKubeconfig(e.target.value)}
                                    placeholder="粘贴您的 kubeconfig 内容..."
                                    required
                                    className="w-full min-h-[160px] p-4 bg-[#0d1117] border border-[#30363d] rounded-xl text-xs font-mono text-slate-300 focus:outline-none focus:border-blue-500/50 transition-all scrollbar-thin scrollbar-thumb-white/10"
                                />
                            </div>

                            {error && (
                                <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center gap-3 text-rose-400 text-xs">
                                    <X size={14} />
                                    {error}
                                </div>
                            )}

                            <div className="flex gap-3 pt-4">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => setIsAdding(false)}
                                    className="flex-1 text-slate-400 hover:text-white"
                                >
                                    取消
                                </Button>
                                <Button
                                    type="submit"
                                    disabled={loading}
                                    className="flex-[2] bg-blue-600 hover:bg-blue-500 text-white font-bold flex items-center justify-center gap-2"
                                >
                                    {loading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                                    开始集成
                                </Button>
                            </div>
                        </form>
                    )}
                </div>

                {/* Footer Tip */}
                <div className="px-6 py-4 bg-black/20 border-t border-[#30363d] flex items-start gap-3">
                    <div className="mt-0.5 text-blue-400">
                        <Info size={14} />
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
                        Kure 将为每个集群启动独立的 MCP 隔离环境。Kubeconfig 内容将经过 Fernet 对称加密后持久化至数据库，解密仅发生在内存并写入临时挂载点。
                    </p>
                </div>
            </div>
        </div>
    );
};

export default ClusterManagement;
