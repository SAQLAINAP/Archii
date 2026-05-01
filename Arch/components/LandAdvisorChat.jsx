"use client";
import { useState, useRef, useEffect, useCallback } from "react";

// ─── Quick-start chips shown on first open ────────────────────────────────────
const QUICK_CHIPS = [
  "What should I do after buying land?",
  "How do I get building plan approval?",
  "Which documents do I need for construction?",
  "Who should I hire first — architect or engineer?",
  "How long does BBMP approval take?",
  "What is EC / encumbrance certificate?",
];

// ─── Tiny markdown-ish renderer (bold, numbered lists, bullets) ───────────────
function MsgContent({ text }) {
  const lines = text.split("\n");
  return (
    <div style={{ lineHeight: 1.55 }}>
      {lines.map((line, i) => {
        // numbered list
        if (/^\d+\.\s/.test(line)) {
          const content = line.replace(/^\d+\.\s/, "");
          return (
            <div key={i} style={{ display: "flex", gap: 6, marginTop: 3 }}>
              <span style={{ color: "#4488FF", minWidth: 16, fontWeight: 700 }}>
                {line.match(/^(\d+)/)[1]}.
              </span>
              <span dangerouslySetInnerHTML={{ __html: boldify(content) }} />
            </div>
          );
        }
        // bullet
        if (/^[-*•]\s/.test(line)) {
          const content = line.replace(/^[-*•]\s/, "");
          return (
            <div key={i} style={{ display: "flex", gap: 6, marginTop: 3 }}>
              <span style={{ color: "#44DD88", minWidth: 10 }}>·</span>
              <span dangerouslySetInnerHTML={{ __html: boldify(content) }} />
            </div>
          );
        }
        // heading-like line (starts with ##)
        if (/^#{1,3}\s/.test(line)) {
          const content = line.replace(/^#{1,3}\s/, "");
          return <div key={i} style={{ fontWeight: 700, color: "#CCC", marginTop: 8, marginBottom: 2 }}>{content}</div>;
        }
        // blank line → small gap
        if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
        return (
          <div key={i} dangerouslySetInnerHTML={{ __html: boldify(line) }} />
        );
      })}
    </div>
  );
}
function boldify(str) {
  return str
    .replace(/\*\*(.+?)\*\*/g, "<strong style='color:#E8E8F4'>$1</strong>")
    .replace(/`(.+?)`/g, "<code style='background:#1A1A2A;padding:1px 4px;border-radius:3px;font-size:0.9em'>$1</code>");
}

// ─── Pulsing dots for loading ─────────────────────────────────────────────────
function TypingDots() {
  return (
    <div style={{ display: "flex", gap: 4, padding: "4px 0" }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: 6, height: 6, borderRadius: "50%", background: "#4488FF",
          animation: `dotPulse 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function LandAdvisorChat() {
  const [open,     setOpen]     = useState(false);
  const [messages, setMessages] = useState([]);
  const [input,    setInput]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [hasCity,  setHasCity]  = useState(false);
  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const abortRef   = useRef(null);

  // Scroll to bottom whenever messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  // Simple city mention detection — marks context so LLM doesn't re-ask
  const CITY_HINTS = /bengaluru|bangalore|bangalore|mumbai|delhi|hyderabad|chennai|pune|kolkata|ahmedabad|surat|jaipur|noida|gurgaon|gurugram|faridabad|kochi|coimbatore|mysuru|mysore|nagpur|lucknow|indore|bhopal|vizag|visakhapatnam|patna|chandigarh|vadodara|rajkot/i;
  function detectCity(text) {
    return CITY_HINTS.test(text);
  }

  const sendMessage = useCallback(async (text) => {
    const trimmed = (text || input).trim();
    if (!trimmed || loading) return;
    setInput("");

    if (detectCity(trimmed)) setHasCity(true);

    const userMsg   = { role: "user", content: trimmed };
    const newMsgs   = [...messages, userMsg];
    const assistantPlaceholder = { role: "assistant", content: "" };

    setMessages([...newMsgs, assistantPlaceholder]);
    setLoading(true);

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/land-advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMsgs }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`API error ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += dec.decode(value, { stream: true });
        // Update the last (assistant) message in place
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: accumulated };
          return updated;
        });
      }
      if (detectCity(accumulated)) setHasCity(true);
    } catch (e) {
      if (e.name !== "AbortError") {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Sorry, something went wrong. Please try again.",
          };
          return updated;
        });
      }
    } finally {
      setLoading(false);
    }
  }, [input, messages, loading]);

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const reset = () => { setMessages([]); setHasCity(false); setInput(""); };

  const isEmpty = messages.length === 0;

  return (
    <>
      {/* ── Keyframes ── */}
      <style>{`
        @keyframes dotPulse {
          0%,80%,100% { transform: scale(0.7); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        @keyframes chatSlideUp {
          from { opacity:0; transform: translateY(20px) scale(0.97); }
          to   { opacity:1; transform: translateY(0) scale(1); }
        }
        @keyframes bubblePop {
          0%   { transform: scale(0.5); opacity:0; }
          70%  { transform: scale(1.08); }
          100% { transform: scale(1); opacity:1; }
        }
        .chat-input:focus { outline: none; border-color: #4488FF !important; }
        .chip-btn:hover   { background: rgba(68,136,255,0.18) !important; border-color: #4488FF !important; color: #88AAFF !important; }
        .send-btn:hover   { background: #3377EE !important; }
        .close-btn:hover  { color: #EEE !important; }
      `}</style>

      {/* ── Floating bubble ── */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Land Advisor — Ask anything about buying & building"
          style={{
            position: "fixed", bottom: 28, right: 28, zIndex: 9999,
            width: 58, height: 58, borderRadius: "50%",
            background: "linear-gradient(135deg,#1A2A5A,#1A3A5A)",
            border: "1.5px solid #4488FF",
            boxShadow: "0 4px 24px rgba(68,136,255,0.35), 0 1px 6px rgba(0,0,0,0.5)",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            animation: "bubblePop 0.4s ease both",
            transition: "transform 0.15s, box-shadow 0.15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; e.currentTarget.style.boxShadow = "0 6px 30px rgba(68,136,255,0.5)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 4px 24px rgba(68,136,255,0.35)"; }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M3 9.5C3 6.46 5.46 4 8.5 4h7C18.54 4 21 6.46 21 9.5v4c0 3.04-2.46 5.5-5.5 5.5H13l-4 3v-3H8.5C5.46 18 3 15.54 3 13.5v-4z"
              fill="#4488FF" opacity="0.18" stroke="#4488FF" strokeWidth="1.5" strokeLinejoin="round"/>
            <circle cx="8.5" cy="11.5" r="1" fill="#4488FF"/>
            <circle cx="12"  cy="11.5" r="1" fill="#4488FF"/>
            <circle cx="15.5" cy="11.5" r="1" fill="#4488FF"/>
          </svg>
          {/* Unread dot when fresh */}
          {isEmpty && (
            <div style={{
              position:"absolute", top:6, right:6,
              width:10, height:10, borderRadius:"50%",
              background:"#44DD88", border:"1.5px solid #080814",
            }}/>
          )}
        </button>
      )}

      {/* ── Chat panel ── */}
      {open && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 9999,
          width: 380, height: 560,
          background: "#0A0A18",
          border: "1px solid #1E2040",
          borderRadius: 16,
          boxShadow: "0 12px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(68,136,255,0.12)",
          display: "flex", flexDirection: "column",
          animation: "chatSlideUp 0.22s ease both",
          overflow: "hidden",
        }}>

          {/* Header */}
          <div style={{
            padding: "12px 16px", display: "flex", alignItems: "center", gap: 10,
            borderBottom: "1px solid #1A1A30",
            background: "linear-gradient(135deg,#0D0D20,#0A1228)",
            flexShrink: 0,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: "50%",
              background: "linear-gradient(135deg,#1A2A5A,#1A3A5A)",
              border: "1px solid #4488FF44",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M3 12l9-9 9 9" stroke="#4488FF" strokeWidth="2" strokeLinecap="round"/>
                <path d="M5 10v9a1 1 0 001 1h4v-5h4v5h4a1 1 0 001-1v-9" stroke="#4488FF" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#E8E8F4", fontFamily: "monospace", letterSpacing: "0.04em" }}>
                Land Advisor
              </div>
              <div style={{ fontSize: 9, color: "#44DD88", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width:5, height:5, borderRadius:"50%", background:"#44DD88" }}/>
                Powered by Gemini · Web Search
              </div>
            </div>
            {messages.length > 0 && (
              <button className="close-btn" onClick={reset} title="Clear chat" style={{
                background:"none", border:"none", color:"#444", cursor:"pointer",
                fontSize:11, fontFamily:"monospace", padding:"2px 6px",
                transition:"color 0.15s",
              }}>clear</button>
            )}
            <button className="close-btn" onClick={() => setOpen(false)} style={{
              background:"none", border:"none", color:"#444", cursor:"pointer",
              fontSize:18, lineHeight:1, padding:"0 2px",
              transition:"color 0.15s",
            }}>×</button>
          </div>

          {/* Messages area */}
          <div style={{
            flex: 1, overflowY: "auto", padding: "14px 14px 0",
            scrollbarWidth: "thin", scrollbarColor: "#1A1A30 transparent",
          }}>
            {isEmpty ? (
              // Welcome state
              <div style={{ paddingBottom: 12 }}>
                <div style={{
                  background: "rgba(68,136,255,0.08)", borderRadius: 10,
                  padding: "12px 14px", marginBottom: 14,
                  border: "1px solid rgba(68,136,255,0.15)",
                }}>
                  <p style={{ margin:0, fontSize:12, color:"#AABBD0", lineHeight:1.5, fontFamily:"monospace" }}>
                    👋 Hi! I can help you navigate <strong style={{color:"#E8E8F4"}}>land purchase, building approvals, legal steps</strong>, and construction planning in India.
                  </p>
                </div>
                <div style={{ fontSize:10, color:"#333", fontFamily:"monospace", marginBottom:8, letterSpacing:"0.05em" }}>
                  QUICK QUESTIONS
                </div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {QUICK_CHIPS.map(chip => (
                    <button key={chip} className="chip-btn" onClick={() => sendMessage(chip)} style={{
                      background:"rgba(255,255,255,0.03)",
                      border:"1px solid #1E2040",
                      borderRadius:20, padding:"5px 10px",
                      color:"#7788AA", fontSize:10, cursor:"pointer",
                      fontFamily:"monospace", transition:"all 0.15s",
                      textAlign:"left",
                    }}>
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} style={{
                  marginBottom: 12,
                  display:"flex",
                  flexDirection: m.role === "user" ? "row-reverse" : "row",
                  gap: 8, alignItems: "flex-start",
                }}>
                  {/* Avatar */}
                  <div style={{
                    width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                    background: m.role === "user" ? "#1A2850" : "#0D1A30",
                    border: `1px solid ${m.role === "user" ? "#4488FF44" : "#44DD8844"}`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize: 11,
                  }}>
                    {m.role === "user" ? "U" : "A"}
                  </div>
                  {/* Bubble */}
                  <div style={{
                    maxWidth: "82%",
                    background: m.role === "user" ? "rgba(68,136,255,0.12)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${m.role === "user" ? "rgba(68,136,255,0.25)" : "#1A1A2A"}`,
                    borderRadius: m.role === "user" ? "12px 4px 12px 12px" : "4px 12px 12px 12px",
                    padding: "8px 12px",
                    fontSize: 11.5, color: "#C8D0E0",
                    fontFamily: "monospace", lineHeight: 1.5,
                  }}>
                    {m.content === "" && loading && i === messages.length - 1
                      ? <TypingDots />
                      : <MsgContent text={m.content} />
                    }
                  </div>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          {/* City context hint */}
          {!hasCity && messages.length > 0 && !loading && (
            <div style={{
              margin:"6px 14px 0",
              padding:"5px 10px",
              background:"rgba(240,224,64,0.06)",
              border:"1px solid rgba(240,224,64,0.18)",
              borderRadius:6, fontSize:10, color:"#B0A050", fontFamily:"monospace",
            }}>
              💡 Mention your city for location-specific approvals & fees
            </div>
          )}

          {/* Input row */}
          <div style={{
            padding: "10px 12px 14px", flexShrink: 0,
            borderTop: "1px solid #1A1A30",
          }}>
            <div style={{ display:"flex", gap:8, alignItems:"flex-end" }}>
              <textarea
                ref={inputRef}
                className="chat-input"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask about land purchase, approvals, legalities…"
                rows={2}
                disabled={loading}
                style={{
                  flex:1, background:"#0D0D1E", border:"1px solid #1E2040",
                  borderRadius:8, padding:"8px 10px",
                  color:"#D0D8E8", fontSize:11, fontFamily:"monospace",
                  resize:"none", lineHeight:1.5,
                  transition:"border-color 0.2s",
                  opacity: loading ? 0.5 : 1,
                }}
              />
              <button
                className="send-btn"
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
                style={{
                  width:36, height:36, borderRadius:8, flexShrink:0,
                  background: !input.trim() || loading ? "#111" : "#4488FF",
                  border: "none", cursor: !input.trim() || loading ? "default" : "pointer",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  transition:"background 0.15s",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M22 2L11 13" stroke={!input.trim() || loading ? "#333" : "#FFF"} strokeWidth="2" strokeLinecap="round"/>
                  <path d="M22 2L15 22l-4-9-9-4 20-7z" stroke={!input.trim() || loading ? "#333" : "#FFF"} strokeWidth="2" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div style={{ fontSize:9, color:"#222", fontFamily:"monospace", marginTop:5, textAlign:"center" }}>
              ArchiAI Land Advisor · Gemini + Web Search
            </div>
          </div>
        </div>
      )}
    </>
  );
}
