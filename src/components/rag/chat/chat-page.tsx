"use client";

import ReactMarkdown from "react-markdown";
import { motion } from "framer-motion";
import {
  Bug,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Github,
  Loader2,
  Lock,
  MessageSquareText,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  SendHorizontal,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHAT_SUGGESTIONS } from "@/lib/rag/mock-data";
import type {
  ChatMessage,
  Citation,
  Language,
  RetrievalDebug,
  SourceChunk,
} from "@/lib/rag/types";
import { useNavStore } from "@/lib/rag/store";
import { useRepos } from "@/lib/api/hooks";
import {
  apiChatConfig,
  apiDeleteChatSession,
  apiGetChatSession,
  apiRenameChatSession,
  formatServerTime,
  loadChatSessions,
  streamChat,
  useChatSessions,
  type ApiChatMessage,
  type ApiRetrievalDebug,
  type ApiSource,
} from "@/lib/api/chat";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { MessageSkeleton } from "@/components/rag/shared/skeletons";
import { SourcePanel } from "./source-panel";
import { RetrievalDebugPanel } from "./retrieval-debug";
import { SessionSidebar } from "./session-sidebar";
import { MessageHistory } from "./message-history";
import { MessageEditor } from "./message-editor";

type ContentPart =
  | { type: "text"; value: string }
  | { type: "cite"; index: number };

const LANGUAGE_SET = new Set<string>([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
]);

function parseCitations(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  const regex = /\[(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: "cite", index: parseInt(match[1], 10) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ type: "text", value: content.slice(lastIndex) });
  }
  return parts;
}

/**
 * Format a chat message timestamp ("YYYY-MM-DD HH:mm:ss") into a short label
 * for display in the message header. Returns "HH:mm" when the message was
 * sent today, otherwise "MM-DD HH:mm" so cross-day messages stay oriented.
 */
function formatTimestamp(ts: string): string {
  if (!ts || ts.length < 16) return ts ?? "";
  const msgDate = ts.slice(0, 10); // YYYY-MM-DD
  const time = ts.slice(11, 16); // HH:mm
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (msgDate === today) return time;
  return `${ts.slice(5, 7)}-${ts.slice(8, 10)} ${time}`;
}

/** 后端 SourceOut → 前端 SourceChunk（引用角标、来源面板都读这个结构）。 */
function toSourceChunk(source: ApiSource): SourceChunk {
  return {
    id: String(source.chunk_id),
    chunkId: String(source.chunk_id),
    moduleId: source.module_id === null ? "" : String(source.module_id),
    repoId: String(source.repo_id),
    repoName: source.repo_name,
    fileId: String(source.file_id),
    filePath: source.file_path,
    language: (LANGUAGE_SET.has(source.language ?? "")
      ? source.language
      : "unknown") as Language,
    startLine: source.start_line,
    endLine: source.end_line,
    content: source.content,
    chunkType: source.chunk_type as SourceChunk["chunkType"],
    tokenCount: Math.max(1, Math.round(source.content.length / 3.2)),
    score: source.score,
  };
}

function toRetrievalDebug(
  sources: ApiSource[],
  debug: ApiRetrievalDebug,
  query: string,
): RetrievalDebug {
  return {
    query,
    topK: sources.length,
    // 本期不做重排，展示分即融合后的检索分
    reranked: false,
    rerankModel: "",
    latencyMs: debug.took_ms,
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    results: sources.map((source) => ({
      chunk: toSourceChunk(source),
      score: source.score,
      rerankedScore: source.score,
    })),
  };
}

function toChatMessage(message: ApiChatMessage): ChatMessage {
  return {
    id: String(message.id),
    role: message.role,
    content: message.content,
    citations: message.citations?.map((source) => ({
      index: source.index,
      chunk: toSourceChunk(source),
    })),
    timestamp: formatServerTime(message.created_at),
  };
}

function MessageContent({
  message,
  onCite,
}: {
  message: ChatMessage;
  onCite: (i: number) => void;
}) {
  const parts = useMemo(
    () => parseCitations(message.content),
    [message.content],
  );
  return (
    <div className="prose-chat">
      {parts.map((p, i) =>
        p.type === "text" ? (
          <ReactMarkdown key={i}>{p.value}</ReactMarkdown>
        ) : (
          <button
            key={i}
            type="button"
            className="citation-badge"
            onClick={() => onCite(p.index)}
            aria-label={`查看引用 ${p.index}`}
          >
            {p.index}
          </button>
        ),
      )}
    </div>
  );
}

export function ChatPage() {
  const { sessions, loading: sessionsLoading } = useChatSessions();
  const activeSessionId = useNavStore((s) => s.activeSessionId);
  const setActiveSession = useNavStore((s) => s.setActiveSession);
  const openModule = useNavStore((s) => s.openModule);
  const sourcePanelOpen = useNavStore((s) => s.sourcePanelOpen);
  const activeCitationIndex = useNavStore((s) => s.activeCitationIndex);
  const setCitation = useNavStore((s) => s.setCitation);
  const setSourcePanelOpen = useNavStore((s) => s.setSourcePanelOpen);
  const rewriteMode = useNavStore((s) => s.rewriteMode);
  const { repos } = useRepos();

  const [draftRepoId, setDraftRepoId] = useState("all");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
    null,
  );
  const [showDebug, setShowDebug] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const skipLoadRef = useRef<string | null>(null);
  const validatedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId],
  );
  const isNewSession = !activeSession;

  const repoLabel = activeSession
    ? activeSession.repoName ?? "所有仓库"
    : draftRepoId === "all"
      ? "所有仓库"
      : repos.find((repo) => repo.id === draftRepoId)?.name ?? "指定仓库";

  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i];
    }
    return null;
  }, [messages]);

  const activeCitations = useMemo(
    () => lastAssistant?.citations ?? [],
    [lastAssistant],
  );

  // 读取后端 LLM 配置状态：未配置时在对话顶部明确提示，避免用户误以为在调用模型
  useEffect(() => {
    let cancelled = false;
    apiChatConfig()
      .then((config) => {
        if (!cancelled) setLlmConfigured(config.llm_configured);
      })
      .catch(() => {
        if (!cancelled) setLlmConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 第一次拿到服务端会话列表时校正本地持久化的 activeSessionId：
  // 旧版本 localStorage 里可能是 mock 的 `sess-1`，服务端不存在。
  useEffect(() => {
    if (validatedRef.current || sessions.length === 0) return;
    validatedRef.current = true;
    const current = useNavStore.getState().activeSessionId;
    if (!current || !sessions.some((session) => session.id === current)) {
      setActiveSession(sessions[0].id);
    }
  }, [sessions, setActiveSession]);

  // 切换会话时加载历史消息；刚由 SSE 创建的会话跳过（本地已有完整消息）。
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    if (skipLoadRef.current === activeSessionId) {
      skipLoadRef.current = null;
      return;
    }
    const numericId = Number(activeSessionId);
    if (!Number.isFinite(numericId)) return;

    let cancelled = false;
    setMessagesLoading(true);
    apiGetChatSession(numericId)
      .then((detail) => {
        if (!cancelled) setMessages(detail.messages.map(toChatMessage));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "加载会话失败");
        }
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamingMessageId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleCreateSession = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveSession(null);
    setMessages([]);
    setDraftRepoId("all");
    setInput("");
    setMobileOpen(false);
  }, [setActiveSession]);

  const handleSelectSession = useCallback(
    (id: string) => {
      if (id === activeSessionId) {
        setMobileOpen(false);
        return;
      }
      abortRef.current?.abort();
      setActiveSession(id);
      setMobileOpen(false);
    },
    [activeSessionId, setActiveSession],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await apiDeleteChatSession(Number(id));
        const remaining = sessions.filter((session) => session.id !== id);
        if (activeSessionId === id) {
          setActiveSession(remaining[0]?.id ?? null);
        }
        await loadChatSessions(true);
        toast.success("已删除会话");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "删除会话失败");
      }
    },
    [activeSessionId, sessions, setActiveSession],
  );

  const handleRenameSession = useCallback(async (id: string, title: string) => {
    try {
      await apiRenameChatSession(Number(id), title);
      await loadChatSessions(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重命名失败");
    }
  }, []);

  const handleJumpToCode = useCallback(
    (chunk: SourceChunk) => {
      if (!chunk.moduleId) {
        toast.error("该切片没有所属模块（fixed 基线切片无法跳转）");
        return;
      }
      openModule(chunk.moduleId, {
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
    },
    [openModule],
  );

  const patchMessage = useCallback(
    (id: string, patch: Partial<ChatMessage>) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === id ? { ...message, ...patch } : message,
        ),
      );
    },
    [],
  );

  const appendToMessage = useCallback((id: string, text: string) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id
          ? { ...message, content: message.content + text }
          : message,
      ),
    );
  }, []);

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      const draftId = `a-${Date.now()}`;
      const userMessage: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: stamp,
      };
      const draftMessage: ChatMessage = {
        id: draftId,
        role: "assistant",
        content: "",
        timestamp: stamp,
      };

      // 发给后端的 history 不包含本次问题（后端会自己追加）
      const history = messages.slice(-6).map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const sessionIdForRequest = activeSessionId
        ? Number(activeSessionId)
        : null;
      const repoIdsForRequest =
        activeSessionId || draftRepoId === "all"
          ? null
          : [Number(draftRepoId)];

      setMessages((prev) => [...prev, userMessage, draftMessage]);
      setInput("");
      setStreaming(true);
      setStreamingMessageId(draftId);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat(
          {
            message: trimmed,
            session_id: sessionIdForRequest,
            repo_ids: repoIdsForRequest,
            history,
            rewrite_mode: rewriteMode,
          },
          {
            onSession: (event) => {
              const createdId = String(event.session_id);
              // 新会话：本地消息已经完整，切换后不要再拉一次
              skipLoadRef.current = createdId;
              setActiveSession(createdId);
              void loadChatSessions(true);
            },
            onSources: (event) => {
              patchMessage(draftId, {
                citations: event.sources.map((source) => ({
                  index: source.index,
                  chunk: toSourceChunk(source),
                })),
                retrieval: toRetrievalDebug(
                  event.sources,
                  event.retrieval,
                  trimmed,
                ),
              });
            },
            onDelta: (event) => appendToMessage(draftId, event.text),
            onDone: (event) => {
              patchMessage(draftId, {
                tokens: event.usage?.completion_tokens,
              });
              if (event.citation_warning) {
                toast.warning("回答中的部分引用编号超出检索来源范围");
              }
            },
            onError: (event) => toast.error(event.message || "生成失败"),
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          // 用户主动停止：保留已生成的部分内容
        } else {
          toast.error(error instanceof Error ? error.message : "生成失败");
          setMessages((prev) =>
            prev.filter(
              (message) =>
                message.id !== draftId || message.content.length > 0,
            ),
          );
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        setStreamingMessageId(null);
        void loadChatSessions(true);
      }
    },
    [
      activeSessionId,
      appendToMessage,
      draftRepoId,
      messages,
      patchMessage,
      rewriteMode,
      setActiveSession,
      streaming,
    ],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    toast.info("已停止生成");
  }, []);

  return (
    <div className="flex h-full">
      {/* sidebar (desktop) */}
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        loading={sessionsLoading}
        onCreate={handleCreateSession}
        onSelect={handleSelectSession}
        onDelete={handleDeleteSession}
        onRename={handleRenameSession}
      />

      {/* chat column */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* top bar */}
        <div className="flex items-center gap-3 border-b border-border bg-card/60 px-4 py-3 backdrop-blur-md md:px-6">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="会话列表"
                title="会话列表"
              >
                <MessageSquareText className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-72 gap-0 p-0 [&>button:last-child]:hidden"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>会话列表</SheetTitle>
              </SheetHeader>
              <SessionSidebar
                className="!flex w-full !border-r-0"
                sessions={sessions}
                activeSessionId={activeSessionId}
                loading={sessionsLoading}
                onCreate={handleCreateSession}
                onSelect={handleSelectSession}
                onDelete={handleDeleteSession}
                onRename={handleRenameSession}
                onSessionChange={() => setMobileOpen(false)}
              />
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 items-center gap-2">
            <MessageSquareText className="size-4 shrink-0 text-brand" />
            <h1 className="truncate text-[15px] font-semibold">
              {activeSession?.title ?? "新对话"}
            </h1>
          </div>

          {activeSession ? (
            <span
              className="hidden items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11px] sm:inline-flex"
              title="仓库范围在会话创建后不可更改"
            >
              <Github className="size-3 text-muted-foreground" />
              <span className="max-w-[140px] truncate font-medium">{repoLabel}</span>
              <Lock className="size-3 text-muted-foreground" />
              <span className="text-muted-foreground">已锁定</span>
            </span>
          ) : (
            <div className="flex items-center gap-1.5">
              <Github className="hidden size-3.5 text-muted-foreground sm:block" />
              <Select
                value={draftRepoId}
                onValueChange={setDraftRepoId}
                disabled={streaming || repos.length === 0}
              >
                <SelectTrigger
                  className="h-8 w-[150px] rounded-md border-border bg-card text-[12px] shadow-none sm:w-[180px]"
                  aria-label="选择仓库范围"
                >
                  <SelectValue placeholder="选择仓库" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">所有仓库</SelectItem>
                  {repos.map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                首次提问后锁定
              </span>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleCreateSession}>
              <Plus className="size-4" />
              <span className="hidden sm:inline">新会话</span>
            </Button>
            <Button
              variant={showDebug ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setShowDebug((value) => !value)}
            >
              <Bug className="size-4" />
              <span className="hidden sm:inline">检索调试</span>
            </Button>
          </div>
        </div>

        {/* LLM 未配置提示：避免用户误以为在调用真实模型 */}
        {llmConfigured === false && (
          <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-800 md:px-6">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              后端未配置大模型（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），当前无法生成回答。
              请在 .env 中填写真实密钥并重启后端；配置状态见 <code>/api/chat/config</code>。
            </span>
          </div>
        )}

        {/* inline debug for the last assistant message */}
        {showDebug && lastAssistant?.retrieval && (
          <div className="border-b border-border bg-muted/30 px-4 py-3 md:px-6">
            <div className="mx-auto max-w-3xl">
              <RetrievalDebugPanel
                debug={lastAssistant.retrieval}
                onSelectResult={handleJumpToCode}
              />
            </div>
          </div>
        )}

        {/* messages */}
        <div
          className="scrollbar-thin flex-1 overflow-y-auto px-4 py-6 md:px-8"
          role="log"
          aria-live="polite"
          aria-label="对话消息"
        >
          <div className="mx-auto max-w-3xl space-y-5">
            {messagesLoading ? (
              <>
                <MessageSkeleton />
                <MessageSkeleton />
              </>
            ) : (
              <>
                {messages.length === 0 && (
                  <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
                    <Sparkles className="size-8 text-brand/60" />
                    <p className="text-sm">
                      {isNewSession
                        ? `开始向 CodeRAG 提问 · 范围：${repoLabel}`
                        : "开始向 CodeRAG 提问吧"}
                    </p>
                    {isNewSession && (
                      <p className="text-[12px] text-muted-foreground/80">
                        仓库范围在首次提问后锁定
                      </p>
                    )}
                  </div>
                )}
                {messages.map((message, index) => (
                  <motion.div
                    key={message.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                  >
                    <MessageItem
                      message={message}
                      isLast={index === messages.length - 1}
                      isStreaming={streamingMessageId === message.id}
                      onCite={(i) => setCitation(i)}
                      onOpenSources={() => setSourcePanelOpen(true)}
                    />
                  </motion.div>
                ))}
                {streaming && !streamingMessageId && <TypingIndicator />}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* suggestions + input */}
        <div className="border-t border-border bg-card/60 px-4 py-3 backdrop-blur-md md:px-8">
          <div className="mx-auto max-w-3xl space-y-2.5">
            {!streaming && (lastAssistant || isNewSession) && (
              <div className="flex flex-wrap gap-1.5">
                {CHAT_SUGGESTIONS.slice(0, 3).map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setInput(suggestion)}
                    className="rounded-full border border-border bg-card px-3 py-1 text-[12px] text-muted-foreground transition-colors hover:border-brand/40 hover:bg-brand-soft/30 hover:text-brand-soft-foreground"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-card">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend(input);
                  }
                }}
                placeholder="向 CodeRAG 提问，Enter 发送 / Shift+Enter 换行"
                aria-label="提问输入框"
                className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm shadow-none focus-visible:ring-0"
                rows={1}
              />
              {streaming ? (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={handleStop}
                  className="size-9 rounded-lg border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label="停止生成"
                >
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void handleSend(input)}
                  disabled={!input.trim()}
                  className="size-9 rounded-lg bg-brand text-brand-foreground hover:bg-brand/90"
                  aria-label="发送"
                >
                  <SendHorizontal className="size-4" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {sessionsLoading && <Loader2 className="size-3 animate-spin" />}
              <span>
                改写方案：
                {rewriteMode === "none"
                  ? "不改写"
                  : rewriteMode === "llm"
                    ? "模型改写"
                    : "规则改写"}
                · 可在设置中修改
              </span>
            </div>
          </div>
        </div>

        <SourcePanel
          open={sourcePanelOpen}
          onClose={() => setSourcePanelOpen(false)}
          citations={activeCitations}
          activeIndex={activeCitationIndex}
          onSelect={(i) => setCitation(i)}
          onJumpToCode={handleJumpToCode}
        />
      </div>
    </div>
  );
}

function MessageItem({
  message,
  isLast,
  isStreaming,
  isStopped,
  isEditing,
  canEdit,
  canRetry,
  canResume,
  onCite,
  onOpenSources,
  onRetry,
  retryDisabled,
  onResume,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  message: ChatMessage;
  isLast?: boolean;
  isStreaming?: boolean;
  isStopped?: boolean;
  isEditing?: boolean;
  canEdit?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
  onCite: (i: number) => void;
  onOpenSources: () => void;
  onRetry?: () => void;
  retryDisabled?: boolean;
  onResume?: () => void;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  onSaveEdit?: (newContent: string) => void;
}) {
  const [debugOpen, setDebugOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      toast.success("已复制到剪贴板");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败");
    }
  }, [message.content]);

  if (message.role === "user") {
    if (isEditing && onSaveEdit && onCancelEdit) {
      return (
        <div className="flex justify-end">
          <div className="w-[80%] max-w-[80%]">
            <MessageEditor
              message={message}
              onSave={onSaveEdit}
              onCancel={onCancelEdit}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-end">
        <div className="user-bubble group relative max-w-[80%] rounded-2xl rounded-br-sm bg-brand px-4 py-2.5 text-sm text-brand-foreground shadow-card">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
          <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-brand-foreground opacity-60 transition-opacity group-hover:opacity-100">
            {message.edited && <span className="italic">已编辑</span>}
            <span>{message.timestamp.slice(11, 16)}</span>
          </div>
          <div className="absolute -right-2 -top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 rounded-full border border-border bg-card text-muted-foreground shadow-card hover:text-foreground"
              onClick={handleCopy}
              aria-label="复制消息"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </Button>
            {canEdit && onStartEdit && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 rounded-full border border-border bg-card text-muted-foreground shadow-card hover:text-brand"
                onClick={onStartEdit}
                aria-label="编辑消息"
              >
                <Pencil className="size-3" />
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="assistant-card rounded-2xl border border-border bg-card p-4 shadow-card">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex size-7 items-center justify-center rounded-full bg-brand text-brand-foreground">
          <Sparkles className="size-4" />
        </div>
        <span className="text-[13px] font-semibold">CodeRAG</span>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {formatTimestamp(message.timestamp)}
          </span>
          {message.tokens && !isStreaming && (
            <span className="border-l border-border pl-2">
              {message.tokens} tokens
            </span>
          )}
          {isStreaming && (
            <span className="border-l border-border pl-2 text-muted-foreground">
              生成中…
            </span>
          )}
        </div>
      </div>

      <div className={cn(isStreaming && "min-h-[2rem]")}>
        {isStreaming && !message.content ? (
          <div
            className="flex items-center gap-1.5 px-1 py-2"
            role="status"
            aria-label="正在生成回复"
          >
            <span className="size-2 animate-pulse rounded-full bg-brand/60 [animation-delay:-0.3s]" />
            <span className="size-2 animate-pulse rounded-full bg-brand/60 [animation-delay:-0.15s]" />
            <span className="size-2 animate-pulse rounded-full bg-brand/60" />
          </div>
        ) : (
          <>
            <MessageContent message={message} onCite={onCite} />
            {isStreaming && (
              <span
                className="ml-0.5 inline-block h-[1.1em] w-[2px] animate-pulse self-center align-middle bg-brand"
                aria-hidden
              />
            )}
          </>
        )}
      </div>

      {isStopped && (
        <div className="mt-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-400">
            <Square className="size-2.5 fill-current" />
            已停止生成
          </span>
          {canResume && onResume && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px] text-brand hover:bg-brand-soft hover:text-brand-soft-foreground"
              onClick={onResume}
              aria-label="继续生成"
            >
              <Play className="size-3" />
              继续生成
            </Button>
          )}
        </div>
      )}

      {!isStreaming && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-[12px] text-muted-foreground">
          {message.citations && message.citations.length > 0 && (
            <>
              <span>
                来源{" "}
                <span className="font-semibold text-foreground tabular-nums">
                  {message.citations.length}
                </span>{" "}
                条
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[12px] text-brand hover:bg-brand-soft hover:text-brand-soft-foreground"
                onClick={onOpenSources}
              >
                查看来源
              </Button>
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
              onClick={handleCopy}
              aria-label="复制消息"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              <span>{copied ? "已复制" : "复制"}</span>
            </Button>
            {isLast && onRetry && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[12px] text-brand hover:bg-brand-soft hover:text-brand-soft-foreground"
                onClick={onRetry}
                disabled={retryDisabled}
                aria-label="重新生成"
              >
                <RefreshCw className="size-3.5" />
                <span>重新生成</span>
              </Button>
            )}
          </div>
        </div>
      )}

      {message.retrieval && !isStreaming && (
        <Collapsible open={debugOpen} onOpenChange={setDebugOpen} className="mt-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent"
            >
              <Bug className="size-3.5" />
              检索调试 · {message.retrieval.latencyMs}ms
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform duration-200",
                  debugOpen && "rotate-180",
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <RetrievalDebugPanel debug={message.retrieval} />
          </CollapsibleContent>
        </Collapsible>
      )}

      {message.versions && message.versions.length > 0 && !isStreaming && (
        <div className="mt-2">
          <MessageHistory message={message} />
        </div>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div
      className="rounded-2xl border border-border bg-card p-4 shadow-card"
      role="status"
      aria-label="正在生成回复"
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="flex size-7 items-center justify-center rounded-full bg-brand text-brand-foreground">
          <Sparkles className="size-4" />
        </div>
        <span className="text-[13px] font-semibold">CodeRAG</span>
      </div>
      <div className="flex items-center gap-1.5 px-1 py-2">
        <span className="size-2 animate-pulse rounded-full bg-brand/60 [animation-delay:-0.3s]" />
        <span className="size-2 animate-pulse rounded-full bg-brand/60 [animation-delay:-0.15s]" />
        <span className="size-2 animate-pulse rounded-full bg-brand/60" />
      </div>
    </div>
  );
}
