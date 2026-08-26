import { useEffect, useState } from "react";
import { api } from "../services/api";
import type { AiTemplateId, ChatMessage, Preferences } from "../types";

interface AiInsightsPanelProps {
  outputDir: string;
  title: string;
  prefs: Preferences | null;
  onOpenSettings: () => void;
}

const TEMPLATES: { id: AiTemplateId; title: string; icon: string; desc: string }[] = [
  {
    id: "summary",
    title: "Resumo Executivo",
    icon: "📝",
    desc: "Visão geral, tópicos centrais e conclusões estruturadas em Markdown.",
  },
  {
    id: "actions",
    title: "Plano de Ação & Tarefas",
    icon: "🎯",
    desc: "Decisões tomadas, lista de tarefas acionáveis e responsáveis.",
  },
  {
    id: "chapters",
    title: "Capítulos do YouTube",
    icon: "📑",
    desc: "Minutagem com timestamps reais (ex: 00:00 Introdução) e resumos.",
  },
  {
    id: "clean",
    title: "Transcrição Limpa",
    icon: "🧹",
    desc: "Converte fala espontânea em artigo fluído sem vícios de linguagem.",
  },
  {
    id: "chat",
    title: "Pergunte ao Áudio",
    icon: "💬",
    desc: "Converse e faça perguntas livres sobre o conteúdo falado.",
  },
];

export function AiInsightsPanel({
  outputDir,
  title,
  prefs,
  onOpenSettings,
}: AiInsightsPanelProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<AiTemplateId>("summary");
  const [customPrompt, setCustomPrompt] = useState("");
  const [insightContent, setInsightContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Chat State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // Carregar insights salvos anteriormente
  useEffect(() => {
    api
      .listSavedInsights(outputDir)
      .then((saved) => {
        const found = saved.find(([id]) => id === selectedTemplate);
        if (found) {
          setInsightContent(found[2]);
        }
      })
      .catch(() => {});
  }, [outputDir, selectedTemplate]);

  const activeProvider = prefs?.ai?.provider || "ollama";
  const activeModelName =
    activeProvider === "ollama"
      ? prefs?.ai?.ollama_model || "llama3.2:latest"
      : activeProvider === "gemini"
      ? (prefs?.ai?.gemini_model === "gemini-1.5-pro" || prefs?.ai?.gemini_model === "gemini-2.5-pro"
          ? "gemini-3.1-pro-preview"
          : (!prefs?.ai?.gemini_model || prefs?.ai?.gemini_model === "gemini-1.5-flash" || prefs?.ai?.gemini_model === "gemini-2.0-flash" || prefs?.ai?.gemini_model === "gemini-2.5-flash"
              ? "gemini-3.7-flash"
              : prefs.ai.gemini_model))
      : activeProvider === "openai"
      ? prefs?.ai?.openai_model || "gpt-4o-mini"
      : prefs?.ai?.groq_model || "llama-3.3-70b-versatile";

  const handleGenerate = async () => {
    if (selectedTemplate === "chat") return;
    setLoading(true);
    setError(null);
    setCopied(false);

    try {
      const result = await api.generateAiInsight(
        outputDir,
        selectedTemplate,
        customPrompt.trim() ? customPrompt : null
      );
      setInsightContent(result);
      setLoading(false);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const q = chatInput.trim();
    if (!q || chatLoading) return;

    const userMsg: ChatMessage = { role: "user", content: q };
    const newHistory = [...chatMessages, userMsg];
    setChatMessages(newHistory);
    setChatInput("");
    setChatLoading(true);
    setError(null);

    try {
      const formattedHistory: Array<[string, string]> = [];
      for (let i = 0; i < chatMessages.length; i += 2) {
        if (chatMessages[i] && chatMessages[i + 1]) {
          formattedHistory.push([chatMessages[i].content, chatMessages[i + 1].content]);
        }
      }

      const answer = await api.askTranscriptAi(outputDir, q, formattedHistory);

      setChatMessages([...newHistory, { role: "assistant", content: answer }]);
      setChatLoading(false);
    } catch (err) {
      setError(`Erro no chat: ${err}`);
      setChatLoading(false);
    }
  };

  const copyInsight = async () => {
    if (!insightContent) return;
    try {
      await navigator.clipboard.writeText(insightContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch (err) {
      setError(String(err));
    }
  };

  const openInFinder = async () => {
    try {
      await api.openInFinder(outputDir);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="ai-panel-container">
      {/* Topo do Painel de IA */}
      <div className="ai-panel-header">
        <div className="ai-provider-badge-row">
          <span className="ai-provider-pill">
            <span className="provider-dot" />
            <b>Provedor IA:</b> {activeProvider.toUpperCase()} ({activeModelName})
          </span>
          <button type="button" className="small-button secondary ai-settings-link" onClick={onOpenSettings}>
            ⚙ Configurar IA
          </button>
        </div>
      </div>

      {error && (
        <div className="notice error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Grid de Templates */}
      <div className="ai-templates-grid">
        {TEMPLATES.map((tmpl) => (
          <button
            key={tmpl.id}
            type="button"
            className={`ai-template-card ${selectedTemplate === tmpl.id ? "active-template" : ""}`}
            onClick={() => {
              setSelectedTemplate(tmpl.id);
              setError(null);
            }}
          >
            <div className="template-top">
              <span className="template-icon">{tmpl.icon}</span>
              <strong>{tmpl.title}</strong>
            </div>
            <p className="template-desc">{tmpl.desc}</p>
          </button>
        ))}
      </div>

      {/* MODO CHAT INTERATIVO */}
      {selectedTemplate === "chat" ? (
        <div className="ai-chat-section">
          <div className="ai-chat-thread">
            {chatMessages.length === 0 ? (
              <div className="ai-chat-empty">
                <span className="chat-empty-icon">💬</span>
                <h4>Pergunte qualquer coisa sobre este áudio</h4>
                <p className="muted">
                  A IA responderá fundamentada estritamente no conteúdo falado nesta transcrição.
                </p>
                <div className="chat-suggestions">
                  {[
                    "Qual a ideia principal?",
                    "Quais foram as decisões tomadas?",
                    "Houve algum prazo mencionado?",
                  ].map((sug) => (
                    <button
                      key={sug}
                      type="button"
                      className="chat-sug-pill"
                      onClick={() => {
                        setChatInput(sug);
                      }}
                    >
                      💡 {sug}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              chatMessages.map((msg, idx) => (
                <div key={idx} className={`chat-bubble-row ${msg.role}`}>
                  <div className={`chat-bubble ${msg.role}`}>
                    <strong>{msg.role === "user" ? "Você" : "Assistente IA"}</strong>
                    <p>{msg.content}</p>
                  </div>
                </div>
              ))
            )}

            {chatLoading && (
              <div className="chat-bubble-row assistant">
                <div className="chat-bubble assistant typing">
                  <span>Pensando e consultando transcrição...</span>
                </div>
              </div>
            )}
          </div>

          <form className="ai-chat-input-row" onSubmit={handleSendMessage}>
            <input
              className="chat-text-input"
              placeholder="Digite sua pergunta sobre a transcrição..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              disabled={chatLoading}
            />
            <button type="submit" className="primary" disabled={!chatInput.trim() || chatLoading}>
              {chatLoading ? "..." : "Enviar"}
            </button>
          </form>
        </div>
      ) : (
        /* MODO TEMPLATE GERADOR */
        <div className="ai-generator-section">
          <div className="generator-actions-row">
            <button
              type="button"
              className="primary generate-btn"
              onClick={handleGenerate}
              disabled={loading}
            >
              {loading ? (
                <>⏳ Processando com IA ({activeModelName})...</>
              ) : (
                <>✨ Gerar {TEMPLATES.find((t) => t.id === selectedTemplate)?.title}</>
              )}
            </button>

            {insightContent && (
              <div className="generator-right-actions">
                <button
                  type="button"
                  className={`small-button secondary ${copied ? "success" : ""}`}
                  onClick={copyInsight}
                >
                  {copied ? "✓ Markdown copiado!" : "📋 Copiar Markdown"}
                </button>
                <button type="button" className="small-button secondary" onClick={openInFinder}>
                  📁 Abrir pasta
                </button>
              </div>
            )}
          </div>

          {/* Área de exibição do insight gerado */}
          <div className="ai-output-box">
            {loading ? (
              <div className="ai-loading-state">
                <div className="ai-pulse-dot" />
                <p>Analisando transcrição e gerando com {activeProvider.toUpperCase()}...</p>
                <span className="muted">Isso pode levar de alguns segundos dependendo do tamanho do áudio.</span>
              </div>
            ) : insightContent ? (
              <pre className="ai-markdown-preview">{insightContent}</pre>
            ) : (
              <div className="ai-empty-output">
                <p>Clique em <b>"Gerar {TEMPLATES.find((t) => t.id === selectedTemplate)?.title}"</b> acima para processar este áudio com IA.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
