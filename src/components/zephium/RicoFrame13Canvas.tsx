"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  ArrowUp,
  Loader2,
  PanelLeft,
  SquarePen,
  Plus,
  Columns2,
  User,
  ShieldCheck,
  ShieldAlert,
  Search,
  Plug,
  Globe,
  CreditCard,
  Sparkles,
  MessageSquare,
} from "lucide-react";
import { Mandate, Transaction, AuditLog } from "@/components/dashboard/types";
import { ReceiptData } from "@/components/dashboard/ReceiptDialog";
import { ApprovalRequest } from "@/components/dashboard/ApprovalDialog";
import { ChatMessage } from "@/lib/chat/use-payagent-chat";
import { ChatMessageRenderer } from "@/components/chat/ChatMessageRenderer";
import { WorkSurface, WorkSurfaceTab } from "@/components/dashboard/WorkSurface";
import { useAuth } from "@/lib/auth/AuthContext";

function ProfileMenu({ collapsed }: { collapsed: boolean }) {
  const { user, session, isAuthenticated, isLoading, openAuthPrompt, logout } =
    useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleClick = () => {
    if (isLoading) return;
    if (isAuthenticated) setMenuOpen((open) => !open);
    else openAuthPrompt();
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    await logout();
    window.location.reload();
  };

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={handleClick}
        title={
          isAuthenticated && user ? `Signed in as ${user.email}` : "Sign in"
        }
        aria-label={isAuthenticated ? "Account menu" : "Sign in"}
        className={`w-full h-9 rounded-lg flex items-center gap-2.5 text-xs font-medium text-[#0F172A] hover:bg-[#E1ECF8] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40 ${
          collapsed ? "justify-center px-0" : "px-2.5"
        }`}
      >
        <span
          className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 ${
            isAuthenticated
              ? "bg-[#0F172A] text-white"
              : "bg-white border border-[#C8D9EE] text-[#334155]"
          }`}
        >
          {isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : isAuthenticated && user ? (
            user.email.charAt(0).toUpperCase()
          ) : (
            <User className="w-3.5 h-3.5" />
          )}
        </span>
        {!collapsed && (
          <span className="truncate text-left flex-1">
            {isAuthenticated && user ? user.email : "Sign in"}
          </span>
        )}
      </button>

      {menuOpen && isAuthenticated && user && (
        <div className="absolute left-0 bottom-11 z-50 w-56 rounded-xl border border-[#DCE7F3] bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.1)]">
          <p className="text-[11px] text-[#7B8BA1] m-0">Signed in as</p>
          <p
            className="text-xs font-medium text-[#0F172A] truncate m-0 mt-0.5"
            title={user.email}
          >
            {user.email}
          </p>
          {session?.isSimulated && (
            <p className="mt-2 mb-0 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
              Demo session: mock payments only
            </p>
          )}
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="mt-3 w-full h-8 rounded-lg bg-[#0F172A] text-white text-xs font-medium hover:bg-[#1E293B] disabled:opacity-60 flex items-center justify-center gap-2 transition-colors duration-150"
          >
            {loggingOut && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export interface RicoFrame13CanvasProps {
  mandates: Mandate[];
  transactions: Transaction[];
  auditLogs: AuditLog[];
  messages: ChatMessage[];
  chatInput: string;
  onChatInputChange: (val: string) => void;
  onSendMessage: (val: string) => void;
  onClearChat: () => void;
  isChatLoading: boolean;
  onTriggerMandate: (id: string) => void;
  onViewReceipt: (receipt: ReceiptData) => void;
  onCreateMandateClick: () => void;
  strictMode: boolean;
  onToggleStrictMode: () => void;
  approvalRequest: ApprovalRequest | null;
  onApproveApproval: (fundingSource?: "PAYPAL" | "BACKUP_CARD") => void;
  onRejectApproval: () => void;
  onDeployPlanMandate: (service: string, price: number, planName: string) => void;
  onOpenCommandPalette?: () => void;
  onRefreshData?: () => void;
}

export function RicoFrame13Canvas({
  mandates,
  transactions,
  auditLogs,
  messages,
  chatInput,
  onChatInputChange,
  onSendMessage,
  onClearChat,
  isChatLoading,
  onTriggerMandate,
  onViewReceipt,
  onCreateMandateClick,
  strictMode,
  onToggleStrictMode,
  approvalRequest,
  onApproveApproval,
  onRejectApproval,
  onDeployPlanMandate,
  onOpenCommandPalette,
  onRefreshData,
}: RicoFrame13CanvasProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSplitView, setIsSplitView] = useState(false);
  const [activeWorkspaceTab, setActiveWorkspaceTab] =
    useState<WorkSurfaceTab>("mandates");
  const [activeView, setActiveView] = useState<"chat" | "workspace">("chat");
  const [activeThread, setActiveThread] = useState<string>("today-1");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isChatLoading]);

  useEffect(() => {
    if (activeView === "chat") {
      textareaRef.current?.focus();
    }
  }, [activeView]);

  const handleOpenWorkspaceTab = (tab: WorkSurfaceTab) => {
    setActiveWorkspaceTab(tab);
    if (!isSplitView) {
      setActiveView("workspace");
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim() || isChatLoading) return;
    onSendMessage(chatInput.trim());
    onChatInputChange("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const quickPrompts = [
    {
      label: "Set a Netflix rule ($20 cap)",
      prompt: "Pay Netflix $15.99 on the 5th, max $20",
    },
    {
      label: "Check Spotify live pricing",
      prompt: "What's the price of Spotify Premium",
    },
    {
      label: "Find startup & student credits",
      prompt: "Scan persona savings for Notion, PostHog, and Stripe deals",
    },
    {
      label: "Compare Netflix and Spotify",
      prompt: "Compare Netflix and Spotify",
    },
  ];

  const navItems: Array<{
    id: string;
    label: string;
    icon: React.ReactNode;
    isActive: boolean;
    onClick: () => void;
  }> = [
    {
      id: "nav-chat",
      label: "Chat",
      icon: <MessageSquare className="w-4 h-4 shrink-0" />,
      isActive: activeView === "chat" && !isSplitView,
      onClick: () => setActiveView("chat"),
    },
    {
      id: "nav-rules",
      label: "Spending rules",
      icon: <CreditCard className="w-4 h-4 shrink-0" />,
      isActive:
        activeView === "workspace" &&
        (activeWorkspaceTab === "mandates" ||
          activeWorkspaceTab === "transactions" ||
          activeWorkspaceTab === "audit"),
      onClick: () => handleOpenWorkspaceTab("mandates"),
    },
    {
      id: "nav-connectors",
      label: "Connectors & skills",
      icon: <Plug className="w-4 h-4 shrink-0" />,
      isActive:
        activeView === "workspace" &&
        (activeWorkspaceTab === "mcp-connect" ||
          activeWorkspaceTab === "skills"),
      onClick: () => handleOpenWorkspaceTab("mcp-connect"),
    },
    {
      id: "nav-browser",
      label: "Browser & sentinel",
      icon: <Globe className="w-4 h-4 shrink-0" />,
      isActive:
        activeView === "workspace" &&
        (activeWorkspaceTab === "viewport" ||
          activeWorkspaceTab === "sentinel"),
      onClick: () => handleOpenWorkspaceTab("viewport"),
    },
    {
      id: "nav-automations",
      label: "Automations",
      icon: <Sparkles className="w-4 h-4 shrink-0" />,
      isActive:
        activeView === "workspace" &&
        (activeWorkspaceTab === "savings" ||
          activeWorkspaceTab === "invoices" ||
          activeWorkspaceTab === "watchdog" ||
          activeWorkspaceTab === "guardrails"),
      onClick: () => handleOpenWorkspaceTab("savings"),
    },
  ];

  const renderComposer = (centered: boolean) => (
    <form
      onSubmit={handleSubmit}
      className={`w-full rounded-2xl bg-white border border-[#D4E2F2] focus-within:border-[#93B8E8] shadow-[0_4px_20px_rgba(15,23,42,0.05)] transition-colors duration-150 ${
        centered ? "p-3.5" : "p-3"
      }`}
    >
      <textarea
        ref={textareaRef}
        value={chatInput}
        onChange={(e) => onChatInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={centered ? 2 : 1}
        aria-label="Message Rico"
        placeholder="Ask Rico anything, set a spending rule, or check live pricing..."
        className="w-full resize-none text-[14px] text-[#0F172A] placeholder-[#8A99AD] outline-none border-none bg-transparent leading-relaxed min-h-[28px] max-h-[140px]"
      />

      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCreateMandateClick}
            title="New spending rule"
            className="h-7 px-2.5 rounded-lg text-xs font-medium text-[#52637A] hover:text-[#0F172A] hover:bg-[#F2F6FC] flex items-center gap-1 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Rule</span>
          </button>

          <button
            type="button"
            onClick={() => handleOpenWorkspaceTab("mcp-connect")}
            title="MCP Connectors"
            className="h-7 px-2.5 rounded-lg text-xs font-medium text-[#52637A] hover:text-[#0F172A] hover:bg-[#F2F6FC] flex items-center gap-1 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40"
          >
            <Plug className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Connectors</span>
          </button>

          <button
            type="button"
            onClick={() => handleOpenWorkspaceTab("viewport")}
            title="Open live browser viewport"
            className="h-7 px-2.5 rounded-lg text-xs font-medium text-[#52637A] hover:text-[#0F172A] hover:bg-[#F2F6FC] flex items-center gap-1 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40"
          >
            <Globe className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Browser</span>
          </button>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="text-[11px] text-[#7B8BA1] font-medium select-none hidden sm:inline">
            Gemini
          </span>

          <button
            type="submit"
            disabled={!chatInput.trim() && !isChatLoading}
            aria-label="Send message"
            className={`w-8 h-8 flex items-center justify-center rounded-xl transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40 ${
              chatInput.trim() && !isChatLoading
                ? "bg-[#0F172A] text-white hover:bg-[#1E293B] cursor-pointer"
                : "bg-[#E2EAF4] text-[#94A3B8] cursor-not-allowed"
            }`}
          >
            {isChatLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
            ) : (
              <ArrowUp className="w-4 h-4 stroke-[2.2]" />
            )}
          </button>
        </div>
      </div>
    </form>
  );

  return (
    <div className="w-screen h-screen flex flex-row bg-[#F5F8FC] text-[#0F172A] overflow-hidden font-[Inter,system-ui,sans-serif]">
      {/* Unified Claude-Style Collapsible Sidebar */}
      <aside
        aria-label="Workspace navigation"
        className={`h-full shrink-0 flex flex-col justify-between bg-[#EDF3FA] border-r border-[#DCE7F3] select-none transition-[width] duration-200 ease-out ${
          isSidebarOpen ? "w-[252px] p-3" : "w-[56px] py-3 px-2 items-center"
        }`}
      >
        <div className="w-full flex flex-col gap-3 min-h-0 flex-1">
          {/* Brand Row + Collapse Toggle */}
          <div
            className={`flex items-center ${
              isSidebarOpen ? "justify-between px-1" : "justify-center"
            }`}
          >
            {isSidebarOpen && (
              <button
                type="button"
                onClick={() => setActiveView("chat")}
                className="flex items-center gap-2 text-left focus-visible:outline-none"
              >
                <div className="w-6 h-6 bg-[url('/brand-rico-mark-transparent.png')] bg-no-repeat bg-contain bg-center shrink-0" />
                <span className="text-[15px] font-semibold tracking-[-0.02em] text-[#0F172A]">
                  Rico
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsSidebarOpen((v) => !v)}
              title={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              aria-label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[#52637A] hover:text-[#0F172A] hover:bg-[#E1ECF8] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          </div>

          {/* New Chat Primary Action */}
          <button
            type="button"
            onClick={() => {
              onClearChat();
              setActiveView("chat");
            }}
            title="New chat"
            className={`h-9 rounded-lg bg-white hover:bg-[#FAFBFD] border border-[#D8E4F2] text-[#0F172A] text-xs font-medium shadow-[0_1px_2px_rgba(15,23,42,0.03)] flex items-center gap-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40 ${
              isSidebarOpen ? "w-full px-3" : "w-9 justify-center px-0"
            }`}
          >
            <SquarePen className="w-3.5 h-3.5 text-[#334155] shrink-0" />
            {isSidebarOpen && <span>New chat</span>}
          </button>

          {/* Primary Navigation */}
          <nav className="flex flex-col gap-0.5 pt-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={item.onClick}
                title={item.label}
                className={`h-9 rounded-lg text-xs font-medium flex items-center gap-2.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40 ${
                  isSidebarOpen ? "w-full px-2.5" : "w-9 justify-center px-0"
                } ${
                  item.isActive
                    ? "bg-[#DCE9F9] text-[#0F172A]"
                    : "text-[#475569] hover:text-[#0F172A] hover:bg-[#E3EEF9]"
                }`}
              >
                {item.icon}
                {isSidebarOpen && <span className="truncate">{item.label}</span>}
              </button>
            ))}
          </nav>

          {/* Active Spending Rules List (Expanded Mode) */}
          {isSidebarOpen && (
            <div className="pt-3 mt-1 border-t border-[#DCE7F3] flex-1 min-h-0 overflow-y-auto space-y-1">
              <div className="flex items-center justify-between px-2 pb-1">
                <span className="text-[11px] font-medium text-[#64748B]">
                  Active rules
                </span>
                <button
                  type="button"
                  onClick={onCreateMandateClick}
                  title="Add spending rule"
                  className="text-[11px] font-medium text-[#52637A] hover:text-[#0F172A] inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-[#E1ECF8] transition-colors duration-150"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add</span>
                </button>
              </div>

              {mandates.slice(0, 5).map((mandate, idx) => {
                const isSelected = activeThread === `mandate-${idx}`;
                return (
                  <div
                    key={mandate.id}
                    className={`rounded-lg transition-colors duration-150 ${
                      isSelected ? "bg-white/80 border border-[#D8E4F2]" : "hover:bg-[#E3EEF9]/70"
                    }`}
                  >
                    <button
                      type="button"
                      data-testid="sidebar-rule"
                      onClick={() => setActiveThread(`mandate-${idx}`)}
                      className="w-full px-2.5 py-2 flex flex-col gap-0.5 text-left"
                    >
                      <div className="flex items-center justify-between w-full gap-2">
                        <span className="text-xs text-[#0F172A] font-medium truncate">
                          {mandate.service}
                        </span>
                        <span className="text-[11px] font-mono tabular-nums text-[#52637A] shrink-0">
                          ${mandate.budgetCeiling.toFixed(0)}
                        </span>
                      </div>
                      <span className="text-[10.5px] text-[#7B8BA1] truncate">
                        {mandate.recurrence}
                      </span>
                    </button>

                    {isSelected && (
                      <div className="flex justify-end px-2.5 pb-2">
                        <button
                          type="button"
                          data-testid="sidebar-run-now"
                          onClick={() => onTriggerMandate(mandate.id)}
                          className="h-6 px-2.5 rounded-md bg-[#0F172A] text-white text-[10.5px] font-medium hover:bg-[#1E293B] transition-colors duration-150"
                          title={`Review and confirm a payment for ${mandate.service}`}
                        >
                          Run now
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Sidebar Bottom Controls */}
        <div className="w-full pt-2.5 border-t border-[#DCE7F3] flex flex-col gap-1">
          {onOpenCommandPalette && (
            <button
              type="button"
              onClick={onOpenCommandPalette}
              title="Search & commands (⌘K)"
              className={`h-8 rounded-lg text-xs text-[#52637A] hover:text-[#0F172A] hover:bg-[#E1ECF8] flex items-center justify-between transition-colors duration-150 ${
                isSidebarOpen ? "w-full px-2.5" : "w-9 justify-center px-0"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Search className="w-3.5 h-3.5 shrink-0" />
                {isSidebarOpen && <span>Search</span>}
              </span>
              {isSidebarOpen && (
                <kbd className="text-[10px] font-mono text-[#7B8BA1]">⌘K</kbd>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onToggleStrictMode}
            title={
              strictMode
                ? "Strict mode: manual approval required"
                : "Autonomous mode: auto-approves within rule cap"
            }
            className={`h-8 rounded-lg text-xs flex items-center gap-2.5 transition-colors duration-150 ${
              isSidebarOpen ? "w-full px-2.5" : "w-9 justify-center px-0"
            } ${
              strictMode
                ? "text-amber-800 bg-amber-100/70 hover:bg-amber-100"
                : "text-[#52637A] hover:text-[#0F172A] hover:bg-[#E1ECF8]"
            }`}
          >
            {strictMode ? (
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            )}
            {isSidebarOpen && (
              <span className="truncate">
                {strictMode ? "Manual approval" : "Autonomous mode"}
              </span>
            )}
          </button>

          <ProfileMenu collapsed={!isSidebarOpen} />
        </div>
      </aside>

      {/* Main Content Stage */}
      <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-[#F5F8FC]">
        {/* Quiet Top Bar */}
        <header className="h-12 px-5 border-b border-[#E2ECF6] bg-[#F5F8FC] flex items-center justify-between shrink-0 select-none">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-xs font-medium text-[#0F172A] truncate">
              {activeView === "chat" || isSplitView
                ? "Ask RICO"
                : navItems.find((n) => n.isActive)?.label || "Workspace"}
            </span>
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-[#7B8BA1]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span>PayPal MCP ready</span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setIsSplitView((prev) => {
                  const next = !prev;
                  if (next) setActiveView("chat");
                  return next;
                });
              }}
              className={`h-8 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40 ${
                isSplitView
                  ? "bg-[#0F172A] text-white border-[#0F172A]"
                  : "bg-white text-[#334155] border-[#DCE7F3] hover:bg-[#FAFBFD]"
              }`}
              title="Toggle side-by-side split view"
            >
              <Columns2 className="w-3.5 h-3.5" />
              <span>{isSplitView ? "Close split" : "Split view"}</span>
            </button>
          </div>
        </header>

        {/* Stage Body */}
        <div className="flex-1 min-h-0 flex flex-row overflow-hidden">
          {/* Chat Pane */}
          {(activeView === "chat" || isSplitView) && (
            <div
              className={`h-full flex flex-col min-w-0 bg-[#F5F8FC] ${
                isSplitView
                  ? "w-1/2 min-w-[380px] border-r border-[#E2ECF6]"
                  : "w-full"
              }`}
            >
              {messages.length === 0 ? (
                /* Claude-style Centered Empty State with Composer in the Middle */
                <div className="flex-1 overflow-y-auto px-4 sm:px-6 flex flex-col items-center justify-center">
                  <div className="w-full max-w-[660px] flex flex-col items-center space-y-6 -mt-6">
                    <div className="flex flex-col items-center text-center space-y-2.5">
                      <div className="w-11 h-11 rounded-2xl bg-white border border-[#DCE7F3] shadow-[0_2px_8px_rgba(15,23,42,0.04)] flex items-center justify-center">
                        <div className="w-6 h-6 bg-[url('/brand-rico-mark-transparent.png')] bg-no-repeat bg-contain bg-center" />
                      </div>
                      <h1 className="m-0 text-2xl sm:text-[28px] font-semibold text-[#0F172A] tracking-[-0.025em]">
                        What can Rico handle for you?
                      </h1>
                    </div>

                    {/* Centered Floating Composer */}
                    {renderComposer(true)}

                    {/* Clean, Quiet Suggestion Pills */}
                    <div className="flex flex-wrap items-center justify-center gap-2 max-w-[620px]">
                      {quickPrompts.map((item) => (
                        <button
                          key={item.label}
                          type="button"
                          onClick={() => onSendMessage(item.prompt)}
                          className="h-8 px-3.5 rounded-full bg-white hover:bg-[#EDF3FA] border border-[#DCE7F3] text-xs text-[#334155] hover:text-[#0F172A] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40"
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                /* Active Conversation Stream + Bottom Composer */
                <>
                  <div className="flex-1 w-full min-h-0 overflow-y-auto px-4 sm:px-6 py-6">
                    <div className="w-full max-w-[720px] mx-auto space-y-6">
                      {messages.map((message) => (
                        <ChatMessageRenderer
                          key={message.id}
                          message={message}
                          onViewReceipt={onViewReceipt}
                          isExpandedDefault={false}
                        />
                      ))}

                      {isChatLoading && (
                        <div className="flex items-center gap-2.5 text-xs text-[#52637A] pl-10">
                          <Loader2 className="w-3.5 h-3.5 text-[#2563EB] animate-spin shrink-0" />
                          <span>Verifying live pricing...</span>
                        </div>
                      )}

                      <div ref={messagesEndRef} />
                    </div>
                  </div>

                  <div className="w-full px-4 sm:px-6 pb-4 pt-2 shrink-0">
                    <div className="w-full max-w-[720px] mx-auto">
                      {renderComposer(false)}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Workspace Pane */}
          {(isSplitView || activeView === "workspace") && (
            <div className="flex-1 h-full min-w-0 overflow-hidden bg-[#F5F8FC]">
              <WorkSurface
                mandates={mandates}
                transactions={transactions}
                auditLogs={auditLogs}
                onTriggerMandate={onTriggerMandate}
                onViewReceipt={onViewReceipt}
                onCreateMandateClick={onCreateMandateClick}
                onDeployPlanMandate={onDeployPlanMandate}
                approvalRequest={approvalRequest}
                onApproveApproval={onApproveApproval}
                onRejectApproval={onRejectApproval}
                onRefreshData={onRefreshData}
                activeTab={activeWorkspaceTab}
                onTabChange={(tab) => setActiveWorkspaceTab(tab)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
