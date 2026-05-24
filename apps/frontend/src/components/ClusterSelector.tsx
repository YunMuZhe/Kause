import React, { useEffect, useState } from 'react';
import { Database, ChevronDown, Check, Server, Plus } from 'lucide-react';
import { Button } from './ui/button';

export interface Cluster {
    id: number;
    name: string;
    description?: string;
}

interface ClusterSelectorProps {
    currentClusterId: number | null;
    onSelectCluster: (id: number) => void;
    onAddCluster: () => void;
}

const ClusterSelector: React.FC<ClusterSelectorProps> = ({ currentClusterId, onSelectCluster, onAddCluster }) => {
    const [clusters, setClusters] = useState<Cluster[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        fetchClusters();
    }, []);

    const fetchClusters = async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/clusters');
            const data = await response.json();
            setClusters(data);

            // If no cluster selected but we have clusters, auto-select the first one
            if (!currentClusterId && data.length > 0) {
                onSelectCluster(data[0].id);
            }
        } catch (error) {
            console.error('Failed to fetch clusters:', error);
        } finally {
            setLoading(false);
        }
    };

    const currentCluster = clusters.find(c => c.id === currentClusterId);

    return (
        <div className="relative">
            <Button
                variant="outline"
                size="sm"
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 bg-[#161b22] border-[#30363d] text-[#c9d1d9] hover:bg-[#21262d] transition-all"
            >
                <Database size={14} className="text-blue-400" />
                <span className="text-xs font-medium max-w-[100px] truncate">
                    {currentCluster ? currentCluster.name : '选择集群'}
                </span>
                <ChevronDown size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
            </Button>

            {isOpen && (
                <>
                    <div
                        className="fixed inset-0 z-40"
                        onClick={() => setIsOpen(false)}
                    />
                    <div className="absolute top-full mt-2 w-56 bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                        <div className="p-2 border-b border-[#30363d] bg-white/[0.02]">
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-2">集群环境</span>
                        </div>
                        <div className="p-1">
                            {clusters.map((cluster) => (
                                <button
                                    key={cluster.id}
                                    onClick={() => {
                                        onSelectCluster(cluster.id);
                                        setIsOpen(false);
                                    }}
                                    className={`w-full flex items-center justify-between p-2.5 rounded-lg text-left transition-all ${currentClusterId === cluster.id
                                        ? 'bg-blue-600/10 text-blue-400'
                                        : 'text-slate-400 hover:bg-white/5 hover:text-white'
                                        }`}
                                >
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        <Server size={14} className={currentClusterId === cluster.id ? 'text-blue-400' : 'text-slate-500'} />
                                        <div className="flex flex-col overflow-hidden">
                                            <span className="text-xs font-semibold truncate">{cluster.name}</span>
                                            {cluster.description && (
                                                <span className="text-[10px] text-slate-500 truncate">{cluster.description}</span>
                                            )}
                                        </div>
                                    </div>
                                    {currentClusterId === cluster.id && <Check size={14} />}
                                </button>
                            ))}
                            {clusters.length === 0 && !loading && (
                                <div className="p-4 text-center text-xs text-slate-500 italic">
                                    暂无配置集群
                                </div>
                            )}
                        </div>
                        <div className="p-1 border-t border-[#30363d] bg-white/[0.01]">
                            <button
                                onClick={() => {
                                    onAddCluster();
                                    setIsOpen(false);
                                }}
                                className="w-full flex items-center gap-2 p-2.5 rounded-lg text-left text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white transition-all"
                            >
                                <Plus size={14} className="text-blue-400" />
                                <span>添加新集群</span>
                            </button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default ClusterSelector;
