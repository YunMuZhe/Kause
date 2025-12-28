import React, { useState, useEffect, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Bot, Terminal, Loader2, CheckCircle2, Search, History, Sparkles } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import PlaybookCard from './components/PlaybookCard';
import ChatSidebar from './components/layout/ChatSidebar';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  type?: 'text' | 'widget' | 'status';
  playbookId?: string;
  initialInputs?: any;
  rationale?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  statusType?: 'thinking' | 'tool_call' | 'tool_result';
  toolName?: string;
  toolSummary?: string;
  title?: string;
  args?: Record<string, any>;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<number | null>(null);
  const [historyTrigger, setHistoryTrigger] = useState(0);
  const [includeHistory, setIncludeHistory] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, [messages]);

  // Load history when conversation changes
  useEffect(() => {
    if (currentConversationId) {
      loadConversationHistory(currentConversationId);
    } else {
      setMessages([]);
    }
  }, [currentConversationId]);

  const loadConversationHistory = async (id: number) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/conversations/${id}`);
      const data = await response.json();

      const formattedMessages: Message[] = [];
      data.forEach((m: any) => {
        if (m.type === 'widget') {
          const content = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;

          if (content.reply) {
            formattedMessages.push({ role: m.role as any, content: content.reply, type: 'text' });
          }

          const widgets = content.widgets || [{
            playbook_id: content.playbook_id,
            initial_inputs: content.initial_inputs
          }];

          widgets.forEach((w: any) => {
            formattedMessages.push({
              role: m.role as any,
              content: '',
              type: 'widget',
              playbookId: w.playbook_id || w.id,
              initialInputs: w.initial_inputs || w.inputs || w.args || {},
              title: w.title,
              args: w.args || w.initial_inputs || {},
              rationale: w.rationale || content.rationale,
              riskLevel: w.risk_level || content.risk_level
            });
          });
        } else {
          formattedMessages.push({
            role: m.role as any,
            content: m.content,
            type: 'text'
          });
        }
      });

      setMessages(formattedMessages);
    } catch (error) {
      console.error('Failed to load history:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg: Message = { role: 'user', content: input, type: 'text' };
    setMessages(prev => [...prev, userMsg]);
    const userInput = input;
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userInput,
          conversation_id: currentConversationId,
          include_history: includeHistory
        }),
      });

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      let statusMessages: Message[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              switch (data.type) {
                case 'thinking':
                  // Update or add thinking status
                  setMessages(prev => {
                    const filtered = prev.filter(m => m.type !== 'status' || m.statusType !== 'thinking');
                    return [...filtered, {
                      role: 'assistant',
                      content: data.message,
                      type: 'status',
                      statusType: 'thinking'
                    }];
                  });
                  break;

                case 'tool_call':
                  // Add tool call status
                  statusMessages.push({
                    role: 'assistant',
                    content: `正在调用 ${data.tool}...`,
                    type: 'status',
                    statusType: 'tool_call',
                    toolName: data.tool
                  });
                  setMessages(prev => {
                    const filtered = prev.filter(m => m.type !== 'status' || m.statusType !== 'thinking');
                    return [...filtered, ...statusMessages];
                  });
                  break;

                case 'tool_result':
                  // Update the last tool_call status to tool_result
                  statusMessages = statusMessages.map(s =>
                    s.statusType === 'tool_call' && s.toolName === data.tool
                      ? { ...s, statusType: 'tool_result' as const, toolSummary: data.summary, content: `${data.tool}: ${data.summary}` }
                      : s
                  );
                  setMessages(prev => {
                    const filtered = prev.filter(m => m.type !== 'status');
                    return [...filtered, ...statusMessages];
                  });
                  break;

                case 'content':
                  assistantContent += data.delta;
                  setMessages(prev => {
                    // Remove status messages and add/update content message
                    const filtered = prev.filter(m => m.type !== 'status');
                    const lastMsg = filtered[filtered.length - 1];

                    // Keep tool results as part of the message display
                    const toolResultMsgs = statusMessages.filter(s => s.statusType === 'tool_result');

                    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.type === 'text') {
                      return [
                        ...filtered.slice(0, -1),
                        ...toolResultMsgs,
                        { ...lastMsg, content: assistantContent }
                      ];
                    } else {
                      return [
                        ...filtered,
                        ...toolResultMsgs,
                        { role: 'assistant', content: assistantContent, type: 'text' }
                      ];
                    }
                  });
                  break;

                case 'widget':
                  setMessages(prev => {
                    const filtered = prev.filter(m => m.type !== 'status');
                    return [...filtered, {
                      role: 'assistant',
                      content: '',
                      type: 'widget',
                      playbookId: data.data.playbook_id,
                      initialInputs: data.data.initial_inputs || data.data.args || {},
                      title: data.data.title,
                      args: data.data.args || data.data.initial_inputs || {},
                      rationale: data.data.rationale,
                      riskLevel: data.data.risk_level
                    }];
                  });
                  break;

                case 'done':
                  if (!currentConversationId && data.conversation_id) {
                    setCurrentConversationId(data.conversation_id);
                    setHistoryTrigger(prev => prev + 1);
                  }
                  // Clean up any remaining status messages
                  setMessages(prev => prev.filter(m => m.type !== 'status' || m.statusType === 'tool_result'));
                  break;

                case 'error':
                  setMessages(prev => [...prev.filter(m => m.type !== 'status'), {
                    role: 'assistant',
                    content: `错误: ${data.message}`,
                    type: 'text'
                  }]);
                  break;
              }
            } catch (parseError) {
              console.error('Failed to parse SSE data:', parseError);
            }
          }
        }
      }
    } catch (error) {
      console.error('Fetch error:', error);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '抱歉，服务出现异常。请确保后端 API 已启动并在 8000 端口运行。',
        type: 'text'
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const renderStatusMessage = (m: Message) => {
    if (m.statusType === 'thinking') {
      return (
        <div className="flex items-center gap-2 text-[#8b949e] text-sm">
          <Loader2 size={14} className="animate-spin" />
          <span>{m.content}</span>
        </div>
      );
    }
    if (m.statusType === 'tool_call') {
      return (
        <div className="flex items-center gap-2 text-blue-400 text-sm">
          <Search size={14} className="animate-pulse" />
          <span>{m.content}</span>
        </div>
      );
    }
    if (m.statusType === 'tool_result') {
      return (
        <div className="flex items-center gap-2 text-green-400 text-sm">
          <CheckCircle2 size={14} />
          <span>{m.content}</span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex h-screen w-full bg-[#0a0c10] text-[#e6edf3] font-sans selection:bg-blue-500/30 overflow-hidden">
      <ChatSidebar
        currentConversationId={currentConversationId}
        onSelectConversation={(id) => setCurrentConversationId(id)}
        refreshTrigger={historyTrigger}
      />

      <main className="flex-1 flex flex-col min-w-0 bg-gradient-to-b from-[#0d1117] to-[#0a0c10]">
        <header className="h-14 border-b border-[#30363d] flex items-center justify-between px-6 bg-[#0d1117]/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
            <h1 className="text-sm font-semibold tracking-tight uppercase opacity-90">
              {currentConversationId ? 'Conversation Session' : 'K8s Cluster Copilot'}
            </h1>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono opacity-50">
            <span className="hidden sm:inline">PROMPT ENGINE: GPT-4o-V.2</span>
            <div className="w-[1px] h-3 bg-[#30363d]" />
            <span>K8SQL-Viper</span>
          </div>
        </header>

        <ScrollArea ref={scrollAreaRef} className="flex-1 p-6 sm:p-10">
          <div className="max-w-4xl mx-auto space-y-10 pb-12">
            {messages.length === 0 && !isLoading && (
              <div className="h-[60vh] flex flex-col items-center justify-center text-center space-y-6">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center shadow-2xl shadow-blue-500/20 mb-4">
                  <Terminal size={32} className="text-white" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold tracking-tight text-white">欢迎使用智能排障助手</h2>
                  <p className="text-[#8b949e] max-w-sm mx-auto leading-relaxed">
                    我可以帮助你查询集群状态、分析资源瓶颈，并自动执行深度故障诊断流程。
                  </p>
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex gap-4 sm:gap-6 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
              >
                {/* Avatar */}
                <div className={`flex-shrink-0 w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shadow-lg transform transition-transform duration-200 hover:scale-105 ${m.role === 'user'
                  ? 'bg-gradient-to-br from-[#1f6feb] to-[#0969da] text-white shadow-blue-500/20'
                  : 'bg-[#161b22] border border-[#30363d] text-[#58a6ff] shadow-black/40'
                  }`}>
                  {m.role === 'user' ? <Terminal size={18} /> : <Bot size={20} />}
                </div>

                {/* Message Content */}
                <div className={`flex flex-col gap-2 min-w-0 ${m.role === 'user' ? 'items-end' : 'items-start'} ${m.type === 'widget' ? 'w-full' : 'max-w-full sm:max-w-[85%]'}`}>
                  {/* Bubble */}
                  <div className={`px-4 py-3 sm:px-6 sm:py-3.5 rounded-2xl relative ${m.role === 'user'
                    ? 'bg-gradient-to-br from-[#0969da] to-[#1f6feb] text-white shadow-xl shadow-blue-900/20 rounded-tr-sm'
                    : 'bg-[#161b22] border border-[#30363d] shadow-lg rounded-tl-sm'
                    } ${m.type === 'widget' ? 'w-full !p-0 !bg-transparent !border-none !shadow-none' : 'max-w-full overflow-hidden'} ${m.type === 'status' ? '!py-2 !px-4 !bg-transparent !border-none !shadow-none ring-1 ring-[#30363d]' : ''}`}>

                    {/* User message subtle glow */}
                    {m.role === 'user' && (
                      <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}

                    {m.type === 'widget' ? (
                      <div className="w-full">
                        <PlaybookCard
                          key={`widget-${i}`}
                          playbookId={m.playbookId || ''}
                          title={m.title || '智能修复剧本'}
                          args={m.args || m.initialInputs || {}}
                          rationale={m.rationale || '建议执行此排障流程以恢复服务。'}
                        />
                      </div>
                    ) : m.type === 'status' ? (
                      renderStatusMessage(m)
                    ) : (
                      <div className={`prose prose-invert prose-sm sm:prose-base max-w-full break-words overflow-x-auto scrollbar-thin scrollbar-thumb-white/10 ${m.role === 'user' ? 'prose-p:text-blue-50' : 'text-[#c9d1d9]'}`}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {m.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>

                  {/* Optional: Add timestamp or role label here if needed */}
                </div>
              </div>
            ))}

          </div>
        </ScrollArea>

        <div className="p-4 sm:p-8 bg-gradient-to-t from-[#0a0c10] via-[#0a0c10] to-transparent sticky bottom-0">
          <form onSubmit={handleSubmit} className="max-w-4xl mx-auto relative group">
            {/* Context Control Toggle */}
            <div className="flex items-center justify-end mb-2 px-1">
              <button
                type="button"
                onClick={() => setIncludeHistory(!includeHistory)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${includeHistory
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  }`}
              >
                {includeHistory ? (
                  <>
                    <History size={12} />
                    <span>连续对话</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={12} />
                    <span>独立问答</span>
                  </>
                )}
              </button>
              {!includeHistory && (
                <span className="ml-2 text-xs text-amber-500/70">
                  (不携带历史上下文)
                </span>
              )}
            </div>
            <div className={`relative flex items-center bg-[#161b22]/90 backdrop-blur-xl border rounded-2xl shadow-2xl focus-within:ring-2 focus-within:ring-blue-500/20 transition-all p-1.5 ${!includeHistory ? 'border-amber-500/30' : 'border-[#30363d] focus-within:border-blue-500/50'
              }`}>
              <div className={`pl-4 transition-colors ${input.trim() ? 'text-blue-500' : 'text-[#8b949e]'}`}>
                <Terminal size={18} />
              </div>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="询问集群状态或输入排障指令..."
                className="flex-1 border-none focus-visible:ring-0 bg-transparent text-sm sm:text-base py-6 px-4 h-auto placeholder-[#484f58] text-[#c9d1d9]"
                disabled={isLoading}
              />
              <Button
                type="submit"
                size="icon"
                disabled={isLoading || !input.trim()}
                className={`mr-1 h-10 w-10 sm:h-12 sm:w-12 rounded-xl transition-all active:scale-95 ${input.trim()
                  ? 'bg-gradient-to-br from-[#1f6feb] to-[#0969da] text-white shadow-lg shadow-blue-500/20 hover:brightness-110'
                  : 'bg-[#21262d] text-[#484f58]'}`}
              >
                {isLoading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <Send size={18} />
                )}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
};

export default App;
