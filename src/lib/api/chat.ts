/**
 * 对话接口：会话 CRUD、SSE 流式问答与会话列表轻量缓存。
 *
 * 会话持久化在后端（chat_session / chat_message），前端只缓存列表，
 * 进入某个会话时再拉取历史消息，避免一次性加载全部会话内容。
 */

import { useEffect, useSyncExternalStore } from "react";
import { API_BASE, ApiError, apiDelete, apiGet, apiPatch, apiPost } from "./client";
import type { ChatSession, RewriteMode } from "@/lib/rag/types";

export interface ApiSource {
  index: number;
  chunk_id: number;
  module_id: number | null;
  chunk_type: string;
  name: string | null;
  repo_id: number;
  repo_name: string;
  file_id: number;
  file_path: string;
  language: string | null;
  start_line: number;
  end_line: number;
  score: number;
  content: string;
}

export interface ApiRetrievalDebug {
  vector_hits: number;
  keyword_hits: number;
  filtered: number;
  truncated: number;
  took_ms: number;
  strategy: string;
}

export interface ApiChatSession {
  id: number;
  title: string;
  repo_id: number | null;
  repo_name: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface ApiChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  citations: ApiSource[];
  created_at: string;
}

export interface ApiChatSessionDetail {
  session: ApiChatSession;
  messages: ApiChatMessage[];
}

export interface ApiChatConfig {
  llm_configured: boolean;
  llm_model: string | null;
  default_rewrite_mode: RewriteMode;
  top_k: number;
  max_concurrency: number;
}

export interface ChatStreamRequest {
  message: string;
  session_id?: number | null;
  repo_ids?: number[] | null;
  history?: { role: "user" | "assistant"; content: string }[];
  top_k?: number;
  rewrite_mode?: RewriteMode;
}

export interface ChatStreamHandlers {
  onSession?: (event: {
    session_id: number;
    title: string;
    repo_id: number | null;
    repo_ids: number[] | null;
    created: boolean;
    rewrite_mode: string;
  }) => void;
  onSources?: (event: {
    sources: ApiSource[];
    retrieval: ApiRetrievalDebug;
  }) => void;
  onDelta?: (event: { text: string }) => void;
  onDone?: (event: {
    finish_reason: string;
    latency_ms: number;
    usage: { prompt_tokens: number; completion_tokens: number };
    rewrite_mode: string;
    citation_warning: boolean;
  }) => void;
  onError?: (event: { code: string; message: string }) => void;
}

/** 2026-11-16T12:00:00+08:00 → 2026-11-16 12:00 */
export function formatServerTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export async function apiChatConfig(): Promise<ApiChatConfig> {
  return apiGet<ApiChatConfig>("/api/chat/config");
}

export async function apiListChatSessions(): Promise<{ items: ApiChatSession[] }> {
  return apiGet<{ items: ApiChatSession[] }>("/api/chat/sessions");
}

export async function apiGetChatSession(id: number): Promise<ApiChatSessionDetail> {
  return apiGet<ApiChatSessionDetail>(`/api/chat/sessions/${id}`);
}

export async function apiRenameChatSession(
  id: number,
  title: string,
): Promise<ApiChatSession> {
  const item = await apiPatch<ApiChatSession>(`/api/chat/sessions/${id}`, {
    title,
  });
  // 用服务端返回值直接更新共享缓存，避免刷新列表的请求早于 PATCH 结束导致旧标题回写
  upsertSession(item);
  return item;
}

export async function apiDeleteChatSession(id: number): Promise<{ deleted: number }> {
  return apiDelete<{ deleted: number }>(`/api/chat/sessions/${id}`);
}

function toChatSession(item: ApiChatSession): ChatSession {
  return {
    id: String(item.id),
    title: item.title,
    repoId: item.repo_id === null ? "" : String(item.repo_id),
    repoName: item.repo_name ?? undefined,
    messages: [],
    messageCount: item.message_count,
    createdAt: formatServerTime(item.created_at),
    updatedAt: item.updated_at,
  };
}

/** 用单条服务端结果更新共享缓存（重命名等即时反馈，不等待整表刷新）。 */
function upsertSession(item: ApiChatSession) {
  const next = toChatSession(item);
  const exists = sessionState.sessions.some((session) => session.id === next.id);
  emit({
    sessions: exists
      ? sessionState.sessions.map((session) =>
          session.id === next.id
            ? { ...session, title: next.title, updatedAt: next.updatedAt }
            : session,
        )
      : [next, ...sessionState.sessions],
  });
}

// ---------------------------------------------------------------------------
// 会话列表缓存：sidebar / 命令面板 / 设置页共用一份数据
// ---------------------------------------------------------------------------

interface SessionState {
  sessions: ChatSession[];
  loading: boolean;
  error: string | null;
}

let sessionState: SessionState = { sessions: [], loading: false, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function emit(next: Partial<SessionState>) {
  sessionState = { ...sessionState, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadChatSessions(force = false): Promise<void> {
  if (inflight) {
    // 强刷不能复用在“重命名/发送之前”发出的在途请求，否则会把旧标题写回缓存。
    // 等它结束后再发起一次真正的新请求。
    return force ? inflight.then(() => loadChatSessions(true)) : inflight;
  }
  if (sessionState.sessions.length > 0 && !force) return Promise.resolve();

  emit({ loading: true, error: null });
  inflight = apiListChatSessions()
    .then(({ items }) => {
      emit({ sessions: items.map(toChatSession), loading: false });
    })
    .catch((error: unknown) => {
      emit({
        loading: false,
        error: error instanceof Error ? error.message : "加载会话失败",
      });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useChatSessions(): SessionState {
  const state = useSyncExternalStore(
    subscribe,
    () => sessionState,
    () => sessionState,
  );
  useEffect(() => {
    void loadChatSessions();
  }, []);
  return state;
}

/** 设置页“清空所有会话”：逐条删除服务端会话。 */
export async function clearAllChatSessions(): Promise<void> {
  const { items } = await apiListChatSessions();
  await Promise.all(items.map((item) => apiDeleteChatSession(item.id)));
  await loadChatSessions(true);
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function dispatchEvent(raw: string, handlers: ChatStreamHandlers) {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;

  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }

  switch (event) {
    case "session":
      handlers.onSession?.(payload as Parameters<NonNullable<ChatStreamHandlers["onSession"]>>[0]);
      break;
    case "sources":
      handlers.onSources?.(payload as Parameters<NonNullable<ChatStreamHandlers["onSources"]>>[0]);
      break;
    case "delta":
      handlers.onDelta?.(payload as { text: string });
      break;
    case "done":
      handlers.onDone?.(payload as Parameters<NonNullable<ChatStreamHandlers["onDone"]>>[0]);
      break;
    case "error":
      handlers.onError?.(payload as { code: string; message: string });
      break;
    default:
      break;
  }
}

/** 发起 SSE 问答；调用方通过 AbortSignal 实现“停止生成”。 */
export async function streamChat(
  body: ChatStreamRequest,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(`无法连接后端 ${API_BASE}`, 0);
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      if (payload?.detail) detail = String(payload.detail);
    } catch {
      // 忽略非 JSON 错误体
    }
    throw new ApiError(detail || `请求失败（${response.status}）`, response.status);
  }
  if (!response.body) throw new ApiError("后端未返回流式响应", 500);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim()) dispatchEvent(part, handlers);
    }
  }
  if (buffer.trim()) dispatchEvent(buffer, handlers);
}
