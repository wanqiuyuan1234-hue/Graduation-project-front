"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Github,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ChatSession } from "@/lib/rag/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SessionSidebarProps {
  className?: string;
  sessions: ChatSession[];
  activeSessionId: string | null;
  loading?: boolean;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  /** Optional callback fired after the active session changes (e.g. to close a mobile sheet). */
  onSessionChange?: () => void;
}

// Case-insensitive highlight of the first occurrence of `q` inside `text`.
function HighlightText({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-brand-soft px-0.5 text-brand-soft-foreground">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

/**
 * 会话列表：数据全部来自后端 `/api/chat/sessions`，组件只负责展示与事件上抛。
 *
 * 搜索仅匹配标题——消息正文不在列表接口里返回，避免为了搜索把每个会话的
 * 全文都拉到前端；需要找正文时进入会话后使用浏览器内查找。
 */
export function SessionSidebar({
  className,
  sessions,
  activeSessionId,
  loading = false,
  onCreate,
  onSelect,
  onDelete,
  onRename,
  onSessionChange,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const q = query.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      q
        ? sessions.filter((session) => session.title.toLowerCase().includes(q))
        : sessions,
    [sessions, q],
  );

  function handleSelect(id: string) {
    onSelect(id);
    onSessionChange?.();
  }

  function startRename(id: string, currentTitle: string) {
    setEditingId(id);
    setDraftTitle(currentTitle);
  }

  function commitRename(id: string) {
    const next = draftTitle.trim();
    if (next) onRename(id, next);
    setEditingId(null);
    setDraftTitle("");
  }

  function cancelRename() {
    setEditingId(null);
    setDraftTitle("");
  }

  return (
    <div
      className={cn(
        "hidden w-64 shrink-0 flex-col border-r border-border bg-sidebar lg:flex",
        className,
      )}
    >
      {/* header */}
      <div className="flex h-16 items-center gap-2 border-b border-border px-4">
        <MessageSquareText className="size-4 shrink-0 text-brand" />
        <h2 className="text-[14px] font-semibold">会话</h2>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7 text-muted-foreground transition-transform duration-200 hover:scale-105 hover:bg-accent hover:text-foreground"
          onClick={onCreate}
          aria-label="新建会话"
          title="新建会话"
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {/* search */}
      <div className="px-3 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话标题"
            className="h-8 rounded-md border-border bg-card pl-7 text-[12px] shadow-none focus-visible:ring-1 focus-visible:ring-brand/40"
            aria-label="搜索会话标题"
          />
        </div>
      </div>

      {/* list */}
      <div className="scrollbar-thin flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {filtered.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-1.5 text-muted-foreground">
            <Search className="size-5 opacity-40" />
            <p className="text-[12px]">{q ? "未匹配到会话" : "暂无会话"}</p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {filtered.map((session) => {
              const isActive = session.id === activeSessionId;
              const isEditing = editingId === session.id;

              return (
                <motion.div
                  key={session.id}
                  layout
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className={cn(
                    "group relative w-full rounded-lg border border-transparent px-2.5 py-2 text-left transition-all duration-200 ease-out",
                    isActive
                      ? "bg-brand-soft text-brand-soft-foreground ring-1 ring-brand/20"
                      : "hover:bg-accent hover:translate-x-0.5",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-0 top-2 bottom-2 w-0.5 origin-top rounded-full bg-brand transition-transform duration-200 ease-out",
                      isActive ? "scale-y-100" : "scale-y-0",
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => !isEditing && handleSelect(session.id)}
                    className="block w-full text-left"
                    aria-current={isActive ? "true" : undefined}
                  >
                    {isEditing ? (
                      <Input
                        value={draftTitle}
                        autoFocus
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename(session.id);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                        onBlur={() => commitRename(session.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-7 rounded-md border-border bg-card text-[13px] shadow-none focus-visible:ring-1 focus-visible:ring-brand/40"
                      />
                    ) : (
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">
                          <HighlightText text={session.title} q={q} />
                        </p>
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className="inline-flex min-w-0 items-center gap-0.5">
                            <Github className="size-3 shrink-0" />
                            <span className="truncate">
                              {session.repoName ?? "所有仓库"}
                            </span>
                          </span>
                          <span aria-hidden>·</span>
                          <span className="shrink-0 tabular-nums">
                            {session.messageCount ?? session.messages.length} 条
                          </span>
                        </div>
                      </div>
                    )}
                  </button>

                  {!isEditing && (
                    <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:bg-card hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(session.id, session.title);
                        }}
                        aria-label="重命名会话"
                        title="重命名"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:bg-card hover:text-rose-500"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(session.id);
                        }}
                        aria-label="删除会话"
                        title="删除"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* footer */}
      <div className="border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
        共 <span className="tabular-nums font-medium text-foreground">{sessions.length}</span> 个会话
      </div>
    </div>
  );
}
