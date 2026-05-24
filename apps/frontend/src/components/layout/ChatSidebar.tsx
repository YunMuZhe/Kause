import React, { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { Separator } from '../ui/separator';
import { PlusCircle, MessageSquare, Clock, Settings } from 'lucide-react';

interface Conversation {
    id: number;
    title: string;
    created_at: string;
}

interface ChatSidebarProps {
    currentConversationId: number | null;
    onSelectConversation: (id: number | null) => void;
    onOpenClusterManagement: () => void;
    refreshTrigger: number;
}

const ChatSidebar: React.FC<ChatSidebarProps> = ({
    currentConversationId,
    onSelectConversation,
    onOpenClusterManagement,
    refreshTrigger
}) => {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        fetchConversations();
    }, [refreshTrigger]);

    const fetchConversations = async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/conversations');
            const data = await response.json();
            setConversations(data);
        } catch (error) {
            console.error('Failed to fetch conversations:', error);
        } finally {
            setLoading(false);
        }
    };

    const formatDate = (dateString: string) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

        if (diffInSeconds < 60) return '刚刚';
        if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} 分钟前`;
        if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} 小时前`;
        return date.toLocaleDateString();
    };

    return (
        <div className="flex flex-col h-full w-64 bg-slate-900 text-white border-r border-slate-800">
            <div className="p-4">
                <Button
                    onClick={() => onSelectConversation(null)}
                    className="w-full flex items-center justify-start gap-2 bg-slate-800 hover:bg-slate-700 text-white border-none"
                >
                    <PlusCircle size={18} />
                    <span>开启新对话</span>
                </Button>
            </div>

            <Separator className="bg-slate-800" />

            <ScrollArea className="flex-1 px-2 py-4">
                <div className="space-y-2">
                    {conversations.map((conv) => (
                        <button
                            key={conv.id}
                            onClick={() => onSelectConversation(conv.id)}
                            className={`w-full group flex flex-col items-start p-3 rounded-lg transition-all text-left ${currentConversationId === conv.id
                                ? 'bg-blue-600/20 border border-blue-500/50'
                                : 'hover:bg-slate-800 border border-transparent'
                                }`}
                        >
                            <div className="flex items-center gap-2 w-full mb-1">
                                <MessageSquare size={14} className={currentConversationId === conv.id ? 'text-blue-400' : 'text-slate-400'} />
                                <span className={`text-sm font-medium truncate flex-1 ${currentConversationId === conv.id ? 'text-white' : 'text-slate-300'
                                    }`}>
                                    {conv.title}
                                </span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px] text-slate-500">
                                <Clock size={10} />
                                <span>{formatDate(conv.created_at)}</span>
                            </div>
                        </button>
                    ))}
                    {loading && conversations.length === 0 && (
                        <div className="p-4 text-center text-slate-500 text-sm italic">
                            加载中...
                        </div>
                    )}
                    {!loading && conversations.length === 0 && (
                        <div className="p-4 text-center text-slate-500 text-sm italic">
                            暂无历史对话
                        </div>
                    )}
                </div>
            </ScrollArea>

            <div className="p-4 bg-slate-950/50 border-t border-slate-800">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold">
                        USER
                    </div>
                    <div className="flex-1 overflow-hidden">
                        <p className="text-xs font-medium truncate">K8s Administrator</p>
                        <p className="text-[10px] text-slate-500 truncate">V1.2.0-MVP</p>
                    </div>
                    <button
                        onClick={onOpenClusterManagement}
                        className="p-2 text-slate-500 hover:text-white hover:bg-slate-800 rounded-lg transition-all"
                        title="集群管理"
                    >
                        <Settings size={18} />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ChatSidebar;
