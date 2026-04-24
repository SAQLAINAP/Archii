"use client";
import { useState } from "react";
import { supabase } from "../../lib/supabase";

export default function LoginPage() {
  const [email, setEmail]   = useState("");
  const [sent, setSent]     = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setLoading(false);
    if (err) { setError(err.message); return; }
    setSent(true);
  };

  return (
    <div style={{
      minHeight:"100vh", background:"#080814", display:"flex",
      alignItems:"center", justifyContent:"center",
      fontFamily:"monospace",
    }}>
      <div style={{
        width:360, padding:"32px 28px",
        background:"#0C0C18", border:"2px solid #1A1A28",
        borderRadius:10,
      }}>
        {/* Logo */}
        <div style={{ marginBottom:28 }}>
          <div style={{ display:"flex", alignItems:"baseline", gap:6 }}>
            <span style={{ fontSize:22, color:"#E8E8F4", fontFamily:"Georgia,serif" }}>वास्तु</span>
            <span style={{ fontSize:22, color:"#F0E040", fontFamily:"Georgia,serif", fontWeight:700 }}>AI</span>
          </div>
          <div style={{ fontSize:8, color:"#333", letterSpacing:"0.18em", marginTop:4 }}>ARCHITECTURAL DESIGN PLATFORM</div>
        </div>

        {sent ? (
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:32, marginBottom:16 }}>✉️</div>
            <div style={{ fontSize:13, color:"#DDD", marginBottom:8 }}>Check your inbox</div>
            <div style={{ fontSize:10, color:"#555", lineHeight:1.7 }}>
              We sent a magic link to<br/>
              <span style={{ color:"#4488FF" }}>{email}</span>.<br/>
              Click it to sign in — no password needed.
            </div>
            <button onClick={() => { setSent(false); setEmail(""); }} style={{
              marginTop:20, padding:"7px 18px",
              background:"transparent", border:"1px solid #2A2A3A",
              borderRadius:5, color:"#555", fontSize:9,
              cursor:"pointer", fontFamily:"monospace",
            }}>← Use a different email</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ fontSize:13, color:"#DDD", fontWeight:700, marginBottom:6 }}>Sign in</div>
            <div style={{ fontSize:10, color:"#444", marginBottom:22, lineHeight:1.6 }}>
              We'll send a magic link to your email. No password required.
            </div>

            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:8, color:"#555", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:5 }}>Email address</div>
              <input
                type="email" required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                style={{
                  width:"100%", padding:"10px 12px",
                  background:"#080810", border:"1px solid #2A2A3A",
                  borderRadius:5, color:"#D8D8EC",
                  fontFamily:"monospace", fontSize:11, outline:"none",
                }}
                onFocus={e => e.target.style.borderColor="#4488FF"}
                onBlur={e => e.target.style.borderColor="#2A2A3A"}
              />
            </div>

            {error && (
              <div style={{ fontSize:9, color:"#FF5544", marginBottom:12 }}>{error}</div>
            )}

            <button type="submit" disabled={loading} style={{
              width:"100%", padding:"11px",
              background: loading ? "#0A0A14" : "linear-gradient(135deg,#0E2040,#061830)",
              border:"2px solid #4488FF",
              borderRadius:6, color:"#4488FF",
              fontSize:11, fontWeight:900, cursor: loading ? "not-allowed" : "pointer",
              letterSpacing:"0.1em", textTransform:"uppercase",
              fontFamily:"monospace", transition:"all 0.2s",
            }}>
              {loading ? "Sending…" : "Send Magic Link"}
            </button>

            <div style={{ textAlign:"center", marginTop:18, fontSize:9, color:"#333" }}>
              <a href="/app" style={{ color:"#444", textDecoration:"none" }}>← Back to Studio</a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
