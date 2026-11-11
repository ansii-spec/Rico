"use client";

import { useState, useCallback, useRef } from "react";
import { ReceiptData } from "@/components/dashboard/ReceiptDialog";
import { ApprovalRequest } from "@/components/dashboard/ApprovalDialog";
import { Mandate } from "@/components/dashboard/types";
import type { SavingsAdvisoryData } from "@/lib/savings/types";

export interface ExecutionStep {
  step: string;
  status: "done" | "running" | "waiting";
  detail?: string;
}

export interface ThoughtProcess {
  summary: string;
  steps: ExecutionStep[];
}

export interface StatusPill {
  step: string;
  state: "loading" | "success" | "warning";
}

export interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  text: string;
  timestamp: string;
  thoughtProcess?: ThoughtProcess;
  statusPill?: StatusPill;
  receipt?: ReceiptData;
  savingsAdvisory?: SavingsAdvisoryData;
}

export interface UsePayAgentChatOptions {
  api?: string;
  initialMessages?: ChatMessage[];
  strictMode?: boolean;
  mandates?: Mandate[];
  onReceiptCaptured?: (receipt: ReceiptData) => void;
  onApprovalRequired?: (approval: ApprovalRequest) => void;
  onFinish?: (message: ChatMessage) => void;
  onError?: (error: Error) => void;
}

export interface UsePayAgentChatReturn {
  messages: ChatMessage[];
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  handleInputChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => void;
  handleSubmit: (e?: React.FormEvent) => void;
  sendMessage: (content: string) => Promise<void>;
  isLoading: boolean;
  stop: () => void;
  reload: () => Promise<void>;
  clearChat: () => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  error: Error | null;
}

export function usePayAgentChat({
  api = "/api/chat",
  initialMessages = [],
  strictMode = false,
  mandates = [],
  onReceiptCaptured,
  onApprovalRequired,
  onFinish,
  onError,
}: UsePayAgentChatOptions = {}): UsePayAgentChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const lastUserPromptRef = useRef<string>("");

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }, []);

  const clearChat = useCallback(() => {
    stop();
    setMessages([]);
    setError(null);
  }, [stop]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setInput(e.target.value);
    },
    []
  );

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || isLoading) return;

      lastUserPromptRef.current = trimmed;
      setError(null);

      const userMsg: ChatMessage = {
        id: `msg-user-${Date.now()}`,
        sender: "user",
        text: trimmed,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      };

      const assistantMsgId = `msg-agent-${Date.now()}`;
      const initialAssistantMsg: ChatMessage = {
        id: assistantMsgId,
        sender: "assistant",
        text: "",
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        thoughtProcess: {
          summary: "Autonomous Reasoning...",
          steps: [],
        },
      };

      setMessages((prev) => [...prev, userMsg, initialAssistantMsg]);
      setIsLoading(true);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const response = await fetch(api, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: trimmed,
            strictMode,
            mandates,
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedText = "";
        const currentSteps: ExecutionStep[] = [];
        let finalReceipt: ReceiptData | undefined;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;

            const jsonStr = line.slice(6);
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);

              if (event.type === "token" && event.text) {
                accumulatedText += event.text;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, text: accumulatedText }
                      : m
                  )
                );
              } else if (event.type === "step" && event.step) {
                const stepObj = event.step as ExecutionStep;
                const existingIdx = currentSteps.findIndex(
                  (s) => s.step === stepObj.step
                );
                if (existingIdx >= 0) {
                  currentSteps[existingIdx] = stepObj;
                } else {
                  currentSteps.push(stepObj);
                }

                // If running a browser check, reflect in status pill
                const isBrowsing = stepObj.step.toLowerCase().includes("browsing") ||
                  stepObj.step.toLowerCase().includes("price") ||
                  stepObj.step.toLowerCase().includes("merchant");

                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          thoughtProcess: {
                            summary: `Autonomous Reasoning (${currentSteps.length} step${
                              currentSteps.length === 1 ? "" : "s"
                            })`,
                            steps: [...currentSteps],
                          },
                          statusPill: isBrowsing
                            ? {
                                step: stepObj.detail || stepObj.step,
                                state: stepObj.status === "done" ? "success" : "loading",
                              }
                            : m.statusPill,
                        }
                      : m
                  )
                );
              } else if (event.type === "thought" && event.thought) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          thoughtProcess: event.thought,
                        }
                      : m
                  )
                );
              } else if (event.type === "receipt" && event.receipt) {
                const receiptData = event.receipt as ReceiptData;
                finalReceipt = receiptData;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          receipt: receiptData,
                          statusPill: {
                            step: `Payment captured: ${receiptData.orderId}`,
                            state: "success",
                          },
                        }
                      : m
                  )
                );

                if (onReceiptCaptured) {
                  onReceiptCaptured(receiptData);
                }
              } else if (event.type === "savings_advisory" && event.advisory) {
                const advData = event.advisory as SavingsAdvisoryData;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          savingsAdvisory: advData,
                        }
                      : m
                  )
                );
              } else if (event.type === "payment_confirmation" && event.quote && onApprovalRequired) {
                // The server prepared a quote; nothing is charged until the user confirms it.
                const q = event.quote as {
                  mandateId: string;
                  service: string;
                  amount: number;
                  currency: string;
                  budgetCeiling: number;
                  periodLabel: string;
                  confirmToken: string;
                };
                onApprovalRequired({
                  id: `confirm-${Date.now()}`,
                  service: q.service,
                  detectedPrice: q.amount,
                  budgetCeiling: q.budgetCeiling,
                  currency: q.currency,
                  reason: "Please confirm this payment. Nothing has been charged yet.",
                  confirmToken: q.confirmToken,
                  mandateId: q.mandateId,
                  periodLabel: q.periodLabel,
                });
              } else if (event.type === "done" && event.text && !accumulatedText) {
                accumulatedText = event.text;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, text: accumulatedText }
                      : m
                  )
                );
              } else if (event.type === "error" && event.error) {
                throw new Error(event.error);
              }
            } catch (pErr) {
              // Skip a malformed line, but surface server errors to the user.
              if (!(pErr instanceof SyntaxError)) throw pErr;
              console.warn("SSE parse error:", pErr);
            }
          }
        }

        const completedMsg: ChatMessage = {
          id: assistantMsgId,
          sender: "assistant",
          text: accumulatedText || "Execution finished.",
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          thoughtProcess: {
            summary: `Autonomous Reasoning (${currentSteps.length} steps)`,
            steps: currentSteps,
          },
          receipt: finalReceipt,
        };

        if (onFinish) {
          onFinish(completedMsg);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          console.log("Stream aborted by user");
          return;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        if (onError) onError(e);

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  text: `⚠️ Agent Error: ${e.message}`,
                }
              : m
          )
        );
      } finally {
        setIsLoading(false);
        abortControllerRef.current = null;
      }
    },
    [
      api,
      isLoading,
      strictMode,
      mandates,
      onReceiptCaptured,
      onApprovalRequired,
      onFinish,
      onError,
    ]
  );

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (!input.trim() || isLoading) return;
      const text = input;
      setInput("");
      sendMessage(text);
    },
    [input, isLoading, sendMessage]
  );

  const reload = useCallback(async () => {
    if (lastUserPromptRef.current && !isLoading) {
      await sendMessage(lastUserPromptRef.current);
    }
  }, [isLoading, sendMessage]);

  return {
    messages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    sendMessage,
    isLoading,
    stop,
    reload,
    clearChat,
    setMessages,
    error,
  };
}
