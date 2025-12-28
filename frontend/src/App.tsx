import React, { useState, useEffect, useRef } from 'react';
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ScrollArea } from "./components/ui/scroll-area";
import { Send, Bot, Terminal, Loader2, CheckCircle2, Search, History, Sparkles, ChevronRight } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import RemediationCard, { Prescription } from './components/RemediationCard';
import ChatSidebar from './components/layout/ChatSidebar';
import ClusterSelector from './components/ClusterSelector';
import ClusterManagement from './components/ClusterManagement';

interface Message {
  id?: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  type?: 'text' | 'widget' | 'status' | 'remediation_result';
  playbookId?: string;
  initialInputs?: any;
  rationale?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  statusType?: 'thinking' | 'tool_call' | 'tool_result';
  toolName?: string;
  toolSummary?: string;
  title?: string;
  args?: Record<string, any>;
  result?: string;
  isError?: boolean;
  initialStatus?: 'idle' | 'loading' | 'success' | 'error' | 'dismissed';
  initialResult?: string | null;
  prescription?: Prescription;
  clusterId?: number; // Context tracking
  conversationId?: number;
}

const StatusMessage: React.FC<{ m: Message }> = ({ m }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (m.statusType === 'thinking') {
    return (
      <div className="flex items-center gap-2 text-[#8b949e] text-[13px] py-1.5 px-2">
        <Loader2 size={13} className="animate-spin text-blue-500/60" />
        <span>{m.content}</span>
      </div>
    );
  }

  const hasDetails = (m.args && Object.keys(m.args).length > 0) || m.result;

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <div
        className={`flex items-center justify-between gap-3 px-3 py-2 rounded-xl transition-colors ${hasDetails ? 'cursor-pointer hover:bg-white/5' : ''} group`}
        onClick={() => hasDetails && setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <div className={`p-1 rounded-md ${m.statusType === 'tool_call' ? 'text-blue-400/80' : 'text-emerald-400/80'}`}>
            {m.statusType === 'tool_call' ? <Search size={14} /> : <CheckCircle2 size={14} />}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[#c9d1d9] font-medium">{m.content}</span>
            {m.toolName && <span className="text-[10px] font-mono text-[#8b949e] uppercase bg-[#30363d]/30 px-1.5 py-0.5 rounded-md">{m.toolName}</span>}
          </div>
        </div>
        {hasDetails && (
          <ChevronRight
            size={14}
            className={`text-[#8b949e] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
          />
        )}
      </div>

      {isExpanded && (
        <div className="ml-7 space-y-3 pb-2 animate-in slide-in-from-top-1 duration-200">
          {m.args && Object.keys(m.args).length > 0 && (
            <div className="space-y-1">
              <span className="text-[9px] font-bold text-[#8b949e] uppercase tracking-widest pl-1">Parameters</span>
              <pre className="text-[11px] font-mono bg-[#0d1117] p-2.5 rounded-lg text-blue-300 overflow-x-auto border border-[#30363d]/50">
                {JSON.stringify(m.args, null, 2)}
              </pre>
            </div>
          )}
          {m.result && (
            <div className="space-y-1">
              <span className="text-[9px] font-bold text-[#8b949e] uppercase tracking-widest pl-1">Output</span>
              <pre className="text-[11px] font-mono bg-[#0d1117] p-3 rounded-lg text-[#c9d1d9] border border-[#30363d]/50 max-h-60 overflow-y-auto scrollbar-thin scrollbar-thumb-white/5 leading-relaxed">
                {m.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ThinkingBlock: React.FC<{ items: Message[] }> = ({ items }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="w-full max-w-2xl px-4 sm:px-6">
      <div
        className="flex items-center gap-2.5 text-[#8b949e] hover:text-[#c9d1d9] transition-colors cursor-pointer group select-none py-1.5"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex-shrink-0 text-blue-400/80">
          <Sparkles size={16} />
        </div>
        <span className="text-[13px] font-medium tracking-wide">Show thinking</span>
        <ChevronRight size={13} className={`transition-transform duration-200 ml-1 ${isExpanded ? 'rotate-90' : ''}`} />
      </div>

      {isExpanded && (
        <div className="mt-1 ml-2 pl-4 border-l border-[#30363d] space-y-1 animate-in fade-in slide-in-from-top-1 duration-300">
          {items.map((item, idx) => (
            <StatusMessage key={idx} m={item} />
          ))}
        </div>
      )}
    </div>
  );
};

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<number | null>(null);
  const [historyTrigger, setHistoryTrigger] = useState(0);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [currentClusterId, setCurrentClusterId] = useState<number | null>(null);
  const [isClusterModalOpen, setIsClusterModalOpen] = useState(false);
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
            formattedMessages.push({ id: m.id, role: m.role as any, content: content.reply, type: 'text' });
          }

          const widgets = content.widgets || [{
            playbook_id: content.playbook_id,
            initial_inputs: content.initial_inputs
          }];

          widgets.forEach((w: any) => {
            formattedMessages.push({
              id: m.id, // Share ID for widgets from same message? Or maybe generated? Using m.id is better than nothing, but duplicates might exist if multiple widgets.
              role: m.role as any,
              content: '',
              type: 'widget',
              playbookId: w.playbook_id || w.id,
              initialInputs: w.initial_inputs || w.inputs || w.args || {},
              title: w.title,
              args: w.args || w.initial_inputs || {},
              rationale: w.rationale || content.rationale,
              riskLevel: w.risk_level || content.risk_level,
              clusterId: m.cluster_id
            });
          });
        } else if (m.type === 'status') {
          try {
            const statusContent = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
            formattedMessages.push({
              role: m.role as any,
              content: statusContent.toolName || 'Tool Call',
              type: 'status',
              statusType: statusContent.statusType,
              toolName: statusContent.toolName,
              args: statusContent.arguments,
              result: statusContent.result,
              isError: statusContent.is_error,
              clusterId: m.cluster_id
            });
          } catch (e) {
            // Fallback for legacy status messages
            formattedMessages.push({
              id: m.id,
              role: m.role as any,
              content: m.content,
              type: 'status',
              clusterId: m.cluster_id
            });
          }
        } else if (m.type === 'remediation_result') {
          try {
            const execContent = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
            const targetIntent = execContent.intent;

            // Find the matching prescription to update its status
            for (let j = formattedMessages.length - 1; j >= 0; j--) {
              const prev = formattedMessages[j];
              if (prev.role === 'assistant' && prev.content && prev.content.includes('<prescription>')) {
                // Parse the intent from the prescription to verify a match
                try {
                  const match = prev.content.match(/<prescription>([\s\S]*?)<\/prescription>/);
                  if (match) {
                    const prescription = JSON.parse(match[1]);
                    if (prescription.intent === targetIntent) {
                      prev.initialStatus = execContent.dismissed ? 'dismissed' : (execContent.success ? 'success' : 'error');
                      prev.initialResult = execContent.output;
                      break;
                    }
                  }
                } catch (pe) {
                  // If parsing fails for one, continue to the next
                }
              }
            }
          } catch (e) {
            console.error('Failed to parse remediation result:', e);
          }
        } else {
          formattedMessages.push({
            id: m.id,
            role: m.role as any,
            content: m.content,
            type: 'text',
            clusterId: m.cluster_id,
            conversationId: id
          });

          // Auto-select cluster based on the latest conversation history if not set
          if (!currentClusterId && m.cluster_id) {
            setCurrentClusterId(m.cluster_id);
          }
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

    if (!currentClusterId) {
      alert("请先选择或配置一个集群环境。");
      setIsClusterModalOpen(true);
      return;
    }

    const userMsg: Message = { role: 'user', content: input, type: 'text', clusterId: currentClusterId };
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
          cluster_id: currentClusterId, // Explicit cluster context
          include_history: includeHistory
        }),
      });

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';

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

                case 'status':
                  setMessages(prev => {
                    // Try to update an existing status message if it's a result for a pending call
                    if (data.statusType === 'tool_result') {
                      const lastMsg = prev[prev.length - 1];
                      if (lastMsg && lastMsg.statusType === 'tool_call' && lastMsg.toolName === data.toolName) {
                        return [
                          ...prev.slice(0, -1),
                          {
                            ...lastMsg,
                            statusType: 'tool_result',
                            result: data.result,
                            content: data.content
                          }
                        ];
                      }
                    }

                    const filtered = prev.filter(m => m.type !== 'status' || m.statusType === 'tool_call' || m.statusType === 'tool_result');
                    return [...filtered, {
                      role: 'assistant',
                      content: data.content,
                      type: 'status',
                      statusType: data.statusType || 'tool_call',
                      toolName: data.toolName,
                      args: data.arguments,
                      result: data.result
                    }];
                  });
                  break;

                case 'assistant':
                  assistantContent += data.content;
                  setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];

                    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.type === 'text') {
                      return [
                        ...prev.slice(0, -1),
                        { ...lastMsg, content: assistantContent }
                      ];
                    } else {
                      return [
                        ...prev,
                        { role: 'assistant', content: assistantContent, type: 'text' }
                      ];
                    }
                  });
                  break;

                case 'done':
                  if (!currentConversationId && data.conversation_id) {
                    setCurrentConversationId(data.conversation_id);
                    setHistoryTrigger(prev => prev + 1);
                  }
                  // Do NOT filter out status messages here, otherwise thinking block disappears
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


  return (
    <div className="flex h-screen w-full bg-[#0a0c10] text-[#e6edf3] font-sans selection:bg-blue-500/30 overflow-hidden">
      <ChatSidebar
        currentConversationId={currentConversationId}
        onSelectConversation={(id) => setCurrentConversationId(id)}
        onOpenClusterManagement={() => setIsClusterModalOpen(true)}
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
          <div className="flex items-center gap-4 text-xs font-mono">
            <ClusterSelector
              currentClusterId={currentClusterId}
              onSelectCluster={(id) => setCurrentClusterId(id)}
              onAddCluster={() => setIsClusterModalOpen(true)}
            />
            <div className="w-[1px] h-3 bg-[#30363d]" />
            <span className="hidden sm:inline opacity-50 uppercase">K8SQL-Viper Engine</span>
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
                  <h2 className="text-2xl font-bold tracking-tight text-white">欢迎使用 Kure 智能排障侦探</h2>
                  <p className="text-[#8b949e] max-w-sm mx-auto leading-relaxed">
                    我会通过实时工具调用来深度调查您的集群问题，并为您提供精准的“治疗方案”卡片。
                  </p>
                </div>
              </div>
            )}

            {(() => {
              const consolidated = [];
              let pendingThinking = [];

              for (let i = 0; i < messages.length; i++) {
                const m = messages[i];
                if (m.type === 'status') {
                  // Try to parse if it's a JSON string
                  let parsed = m;
                  if (typeof m.content === 'string' && m.content.startsWith('{')) {
                    try {
                      const data = JSON.parse(m.content);
                      parsed = { ...m, ...data };
                    } catch (e) {
                      // Keep as is
                    }
                  }
                  pendingThinking.push(parsed);
                } else if (m.role === 'assistant') {
                  // Merge any pending thinking into this assistant message
                  consolidated.push({
                    ...m,
                    thinkingSteps: pendingThinking.length > 0 ? [...pendingThinking] : undefined
                  });
                  pendingThinking = [];
                } else {
                  // If we have thinking steps but no assistant message follow-up immediately
                  // (e.g. streaming or final state before response), flush them
                  if (pendingThinking.length > 0) {
                    consolidated.push({
                      role: 'assistant',
                      type: 'thinking_only',
                      thinkingSteps: [...pendingThinking],
                      content: ''
                    });
                    pendingThinking = [];
                  }
                  consolidated.push(m);
                }
              }
              // Flush remaining
              if (pendingThinking.length > 0) {
                consolidated.push({
                  role: 'assistant',
                  type: 'thinking_only',
                  thinkingSteps: pendingThinking,
                  content: ''
                });
              }

              return consolidated.map((m: any, i) => {
                const prescriptionRegex = /<prescription>([\s\S]*?)<\/prescription>/;
                const match = m.content.match(prescriptionRegex);
                let displayContent = m.content;
                let prescriptionData: Prescription | null = null;
                let isStreamingPrescription = false;

                if (match) {
                  try {
                    prescriptionData = JSON.parse(match[1].trim());
                    displayContent = m.content.replace(prescriptionRegex, '').trim();
                  } catch (e) {
                    displayContent = m.content.split('<prescription>')[0].trim();
                    isStreamingPrescription = true;
                  }
                } else if (m.content.includes('<prescription>')) {
                  displayContent = m.content.split('<prescription>')[0].trim();
                  isStreamingPrescription = true;
                }

                return (
                  <div
                    key={m.id || i}
                    className={`flex gap-4 sm:gap-6 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
                  >
                    {/* Avatar */}
                    <div className={`flex-shrink-0 w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shadow-lg transform transition-transform duration-200 hover:scale-105 ${m.role === 'user'
                      ? 'bg-gradient-to-br from-[#1f6feb] to-[#0969da] text-white shadow-blue-500/20'
                      : 'bg-[#161b22] border border-[#30363d] text-[#58a6ff] shadow-black/40'
                      }`}>
                      {m.role === 'user' ? <Terminal size={18} /> : <Bot size={20} />}
                    </div>

                    {/* Content Area */}
                    <div className={`flex flex-col gap-2 min-w-0 ${m.role === 'user' ? 'items-end' : 'items-start'} ${m.type === 'widget' || prescriptionData ? 'w-full' : 'max-w-full sm:max-w-[85%]'}`}>

                      {/* Unified Bubble for Assistant (Thinking + Text) */}
                      <div className={`flex flex-col w-full ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                        {/* Thinking Block inside the same vertical space */}
                        {m.thinkingSteps && (
                          <div className="w-full mb-1">
                            <ThinkingBlock items={m.thinkingSteps} />
                          </div>
                        )}

                        {displayContent && (
                          <div className={`px-4 py-3 sm:px-6 sm:py-3.5 rounded-2xl relative ${m.role === 'user'
                            ? 'bg-gradient-to-br from-[#0969da] to-[#1f6feb] text-white shadow-xl shadow-blue-900/20 rounded-tr-sm'
                            : 'bg-transparent text-[#c9d1d9]'
                            } ${m.type === 'widget' ? 'w-full !p-0 !bg-transparent !border-none !shadow-none' : 'max-w-full overflow-hidden'}`}>

                            {/* User message sparkle/glow if needed */}
                            {m.role === 'user' && (
                              <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                            )}

                            <div className={`prose prose-invert prose-sm sm:prose-base max-w-full break-words overflow-x-auto scrollbar-thin scrollbar-thumb-white/10 ${m.role === 'user' ? 'prose-p:text-blue-50 flex items-center min-h-[1.5rem]' : 'text-[#c9d1d9]'}`}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {displayContent}
                              </ReactMarkdown>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Prescription Card */}
                      {prescriptionData && (
                        <div className="w-full max-w-2xl px-1">
                          <RemediationCard
                            prescription={prescriptionData}
                            clusterId={m.clusterId || currentClusterId || undefined}
                            conversationId={currentConversationId || undefined}
                            initialStatus={m.initialStatus}
                            initialResult={m.initialResult}
                          />
                        </div>
                      )}

                      {/* Streaming Prescription Placeholder */}
                      {isStreamingPrescription && (
                        <div className="w-full max-w-md mt-2 ml-1 p-4 border border-blue-500/20 rounded-2xl bg-blue-500/5 backdrop-blur-sm animate-pulse flex items-center gap-3">
                          <Loader2 size={16} className="text-blue-500 animate-spin" />
                          <span className="text-[11px] text-blue-400 font-bold uppercase tracking-wider">专家系统正在生成治疗方案...</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              });
            })()}

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

      {/* Cluster Management Modal */}
      <ClusterManagement
        isOpen={isClusterModalOpen}
        onClose={() => setIsClusterModalOpen(false)}
        onClusterAdded={() => setHistoryTrigger(prev => prev + 1)} // Refresh list if needed (though Selector does it)
      />
    </div>
  );
};

export default App;
