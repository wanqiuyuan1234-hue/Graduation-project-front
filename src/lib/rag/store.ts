import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { RewriteMode, ViewId } from "./types";

const THEME_STORAGE_KEY = "coderag-theme";
const NAV_STORAGE_KEY = "coderag-nav";

// Initialize theme synchronously from localStorage on the client to avoid
// the [theme] effect clobbering the persisted value on mount. Guarded for SSR.
// NOTE: `theme` is intentionally NOT persisted via zustand persist — it is
// managed separately by app-header's effect + the inline no-FOUC script in
// layout.tsx, so we exclude it here to avoid a double-source-of-truth.
function getInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
  } catch {
    // ignore storage errors
  }
  return "light";
}

interface NavState {
  view: ViewId;
  activeModuleId: string | null;
  // optional line range to highlight in detail view (from chat source jump)
  detailHighlight: { startLine: number; endLine: number } | null;
  activeRepoId: string;
  // chat state：会话本身持久化在后端，这里只保存“当前打开的会话 id”
  activeSessionId: string | null;
  activeCitationIndex: number | null;
  sourcePanelOpen: boolean;
  // theme
  theme: "light" | "dark";
  // streaming token emission speed (1=slowest, 5=fastest). Persisted so the
  // user's preference survives refresh.
  streamSpeed: number;
  // 多轮提问改写方案（前端偏好，随每次对话请求发送）
  rewriteMode: RewriteMode;
  // navigate
  go: (view: ViewId) => void;
  openModule: (moduleId: string, highlight?: { startLine: number; endLine: number } | null) => void;
  openRepo: (repoId: string, view?: ViewId) => void;
  /** 只切换当前仓库，不改变当前视图（供后端仓库列表校正旧的 mock id）。 */
  setActiveRepoId: (repoId: string) => void;
  openChatWithSession: (sessionId: string) => void;
  setActiveSession: (id: string | null) => void;
  setCitation: (index: number | null) => void;
  setSourcePanelOpen: (open: boolean) => void;
  toggleTheme: () => void;
  setTheme: (t: "light" | "dark") => void;
  setStreamSpeed: (speed: number) => void;
  setRewriteMode: (mode: RewriteMode) => void;
}

export const useNavStore = create<NavState>()(
  persist(
    (set) => ({
      view: "modules",
      activeModuleId: null,
      detailHighlight: null,
      activeRepoId: "",
      activeSessionId: null,
      activeCitationIndex: null,
      sourcePanelOpen: false,
      theme: getInitialTheme(),
      streamSpeed: 3,
      rewriteMode: "rule",
      go: (view) => set({ view }),
      openModule: (moduleId, highlight = null) =>
        set({
          view: "detail",
          activeModuleId: moduleId,
          detailHighlight: highlight,
          activeCitationIndex: null,
          sourcePanelOpen: false,
        }),
      openRepo: (repoId, view = "knowledge") => set({ activeRepoId: repoId, view }),
      setActiveRepoId: (repoId) => set({ activeRepoId: repoId }),
      openChatWithSession: (sessionId) => set({ view: "chat", activeSessionId: sessionId }),
      setActiveSession: (id) =>
        set({ activeSessionId: id, activeCitationIndex: null, sourcePanelOpen: false }),
      setCitation: (index) => set({ activeCitationIndex: index, sourcePanelOpen: index !== null }),
      setSourcePanelOpen: (open) => set({ sourcePanelOpen: open }),
      toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
      setTheme: (t) => set({ theme: t }),
      setStreamSpeed: (speed) => set({ streamSpeed: Math.min(5, Math.max(1, Math.round(speed))) }),
      setRewriteMode: (mode) => set({ rewriteMode: mode }),
    }),
    {
      name: NAV_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 2,
      // 只持久化真正的用户偏好；会话消息全部来自后端，不再写 localStorage。
      partialize: (state) => ({
        activeSessionId: state.activeSessionId,
        activeRepoId: state.activeRepoId,
        streamSpeed: state.streamSpeed,
        rewriteMode: state.rewriteMode,
      }),
      // v1 曾把 mock 会话写进 localStorage；升级时丢弃旧字段，避免把
      // `sess-1` 之类的假 id 带到服务端会话时代。
      migrate: (persisted) => {
        const old = (persisted ?? {}) as Partial<NavState>;
        return {
          activeSessionId: null,
          activeRepoId: old.activeRepoId ?? "",
          streamSpeed: old.streamSpeed ?? 3,
          rewriteMode: old.rewriteMode ?? "rule",
        } as unknown as NavState;
      },
    },
  ),
);
