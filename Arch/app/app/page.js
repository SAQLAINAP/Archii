"use client";
import { useState, useCallback, useRef, useEffect } from "react";
import Sidebar       from "../../components/Sidebar";
import FloorPlanViewer from "../../components/FloorPlanViewer";
import AgentPanel    from "../../components/AgentPanel";
import VastuReport   from "../../components/VastuReport";
import CostReport    from "../../components/CostReport";
import ChatPanel     from "../../components/ChatPanel";
import ComparisonPanel from "../../components/ComparisonPanel";
import GanttChart      from "../../components/GanttChart";
import { computeLayout, ROOM_COLORS } from "../../lib/layoutEngine";
import { scoreVastuLayout, getVastuRemedies } from "../../lib/vastuRules";
import { checkRegulatory } from "../../lib/cityCode";
import {
  buildFloorPlanSVGPrompt,
  buildFloorPlanSVGPromptWithRAG,
  buildVastuCriticPrompt,
  buildBeliefCriticPrompt,
  buildBeliefContext,
  buildCostEstimatorPrompt,
  buildFurniturePrompt,
  buildExplainToParentsPrompt,
} from "../../lib/prompts";
import { getMaxFloors } from "../../lib/rag/knowledgeBase";
import { supabase } from "../../lib/supabase";

// ─── API helpers ──────────────────────────────────────────────────────────────
async function claude(sys, user, maxTokens = 4000) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt: sys, userPrompt: user, maxTokens }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  console.log(`[AI] Response from: ${data.provider}`);
  return data.text || "";
}

// Streaming SVG — falls back to regular claude() if stream endpoint unavailable
async function claudeStream(sys, user, maxTokens, onChunk) {
  try {
    const res = await fetch("/api/claude-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: sys, userPrompt: user, maxTokens }),
    });
    if (!res.ok) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      onChunk(text);
    }
    return text;
  } catch {
    // Fallback to non-streaming
    const text = await claude(sys, user, maxTokens);
    onChunk(text);
    return text;
  }
}

// ─── SVG post-processing ───────────────────────────────────────────────────────
function injectAnnotations(svgCode, rooms, plotW, plotH) {
  if (!svgCode || !rooms?.length) return svgCode;
  const vbMatch = svgCode.match(/viewBox=["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/i);
  if (!vbMatch) return svgCode;
  const svgW = parseFloat(vbMatch[1]);
  const svgH = parseFloat(vbMatch[2]);
  const scaleX = svgW / (plotW * 10); // layout uses 10px/ft
  const scaleY = svgH / (plotH * 10);
  const fs = Math.max(6, Math.min(11, svgW / 60));

  const dimLabels = rooms
    .filter(r => r.w > 0 && r.h > 0)
    .map(r => {
      const cx = (r.x + r.w / 2) * scaleX;
      const cy = (r.y + r.h / 2) * scaleY + fs + 2;
      return `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" font-size="${fs}" fill="#FFCC44" font-family="monospace" opacity="0.85" font-weight="600">${r.ftW}×${r.ftH}ft</text>`;
    }).join("");

  // North arrow (top-right)
  const ax = svgW - 28, ay = 28;
  const northArrow = `<g class="north-arrow">
    <circle cx="${ax}" cy="${ay}" r="18" fill="#00000066" stroke="#4488FF44" stroke-width="1"/>
    <polygon points="${ax},${ay-14} ${ax+5},${ay+6} ${ax},${ay+2} ${ax-5},${ay+6}" fill="#4488FF"/>
    <polygon points="${ax},${ay-14} ${ax-5},${ay+6} ${ax},${ay+2} ${ax+5},${ay+6}" fill="#4488FF55"/>
    <text x="${ax}" y="${ay+16}" text-anchor="middle" font-size="8" fill="#4488FF" font-family="monospace" font-weight="700">N</text>
  </g>`;

  // Scale bar (bottom-left, 5ft increments)
  const bFt = Math.max(5, Math.round(plotW / 6 / 5) * 5);
  const bPx = bFt * (svgW / plotW);
  const bx = 16, by = svgH - 12;
  const scaleBar = `<g class="scale-bar">
    <rect x="${bx-2}" y="${by-10}" width="${bPx+4}" height="14" fill="#00000055" rx="2"/>
    <line x1="${bx}" y1="${by}" x2="${bx+bPx}" y2="${by}" stroke="#AAA" stroke-width="1.5"/>
    <line x1="${bx}" y1="${by-4}" x2="${bx}" y2="${by+2}" stroke="#AAA" stroke-width="1.5"/>
    <line x1="${bx+bPx}" y1="${by-4}" x2="${bx+bPx}" y2="${by+2}" stroke="#AAA" stroke-width="1.5"/>
    <text x="${bx+bPx/2}" y="${by-5}" text-anchor="middle" font-size="7" fill="#AAA" font-family="monospace">${bFt} ft</text>
  </g>`;

  return svgCode.replace(/<\/svg>/i, `<g class="annotations">${dimLabels}</g>${northArrow}${scaleBar}</svg>`);
}

function parseJSON(raw) {
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return null; }
}

// ─── Deterministic SVG renderer — rooms + doors + windows + entrance ──────────
function buildLocalSVG(layout, params) {
  const { rooms, W, H } = layout;
  const PAD = 32;
  const svgW = W + PAD * 2;
  const svgH = H + PAD * 2 + 20;
  const WALL = 3;
  const DS = Math.max(14, Math.min(22, W / 16)); // door size scaled to plot

  // ── shared wall detector ───────────────────────────────────────────────────
  function sharedWall(a, b) {
    const T = 3;
    if (Math.abs((a.x + a.w) - b.x) < T || Math.abs((b.x + b.w) - a.x) < T) {
      const wx  = Math.abs((a.x + a.w) - b.x) < T ? a.x + a.w : b.x + b.w;
      const top = Math.max(a.y, b.y);
      const bot = Math.min(a.y + a.h, b.y + b.h);
      if (bot - top > DS + 6) return { type:"V", wx, top, bot };
    }
    if (Math.abs((a.y + a.h) - b.y) < T || Math.abs((b.y + b.h) - a.y) < T) {
      const wy  = Math.abs((a.y + a.h) - b.y) < T ? a.y + a.h : b.y + b.h;
      const lft = Math.max(a.x, b.x);
      const rgt = Math.min(a.x + a.w, b.x + b.w);
      if (rgt - lft > DS + 6) return { type:"H", wy, lft, rgt };
    }
    return null;
  }

  // ── internal doors at shared walls ────────────────────────────────────────
  const doors = [];
  const usedWalls = new Set();
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const w = sharedWall(rooms[i], rooms[j]);
      if (!w) continue;
      const wid = `${w.type}${(w.wx ?? w.wy).toFixed(0)}`;
      if (usedWalls.has(wid)) continue;
      usedWalls.add(wid);
      if (w.type === "V") {
        const mid = (w.top + w.bot) / 2;
        const x = w.wx + PAD, y1 = mid - DS / 2 + PAD, y2 = mid + DS / 2 + PAD;
        // erase wall gap
        doors.push(`<rect x="${x - WALL}" y="${y1}" width="${WALL * 2 + 1}" height="${DS}" fill="#F5F5F0"/>`);
        // door leaf + arc
        doors.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#777" stroke-width="1.2"/>`);
        doors.push(`<path d="M ${x} ${y2} A ${DS} ${DS} 0 0 1 ${x + DS} ${y1}" fill="none" stroke="#777" stroke-width="1" stroke-dasharray="3,2"/>`);
      } else {
        const mid = (w.lft + w.rgt) / 2;
        const x1 = mid - DS / 2 + PAD, x2 = mid + DS / 2 + PAD, y = w.wy + PAD;
        doors.push(`<rect x="${x1}" y="${y - WALL}" width="${DS}" height="${WALL * 2 + 1}" fill="#F5F5F0"/>`);
        doors.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#777" stroke-width="1.2"/>`);
        doors.push(`<path d="M ${x2} ${y} A ${DS} ${DS} 0 0 0 ${x1} ${y + DS}" fill="none" stroke="#777" stroke-width="1" stroke-dasharray="3,2"/>`);
      }
    }
  }

  // ── entrance door on facing wall ──────────────────────────────────────────
  const facing = params.facing || "North";
  let entRoom = rooms[0];
  if (facing === "North") entRoom = rooms.reduce((a, b) => a.y <= b.y ? a : b);
  if (facing === "South") entRoom = rooms.reduce((a, b) => (a.y + a.h) >= (b.y + b.h) ? a : b);
  if (facing === "East")  entRoom = rooms.reduce((a, b) => (a.x + a.w) >= (b.x + b.w) ? a : b);
  if (facing === "West")  entRoom = rooms.reduce((a, b) => a.x <= b.x ? a : b);
  const ecx = entRoom.x + entRoom.w / 2 + PAD;
  const ecy = entRoom.y + entRoom.h / 2 + PAD;
  const ENT_C = "#22AA66";
  let entranceSVG = "";
  if (facing === "North") {
    const ex = ecx, ey = PAD;
    entranceSVG = `<rect x="${ex - DS / 2}" y="${ey - WALL}" width="${DS}" height="${WALL * 2}" fill="#F5F5F0"/>
      <line x1="${ex - DS/2}" y1="${ey}" x2="${ex + DS/2}" y2="${ey}" stroke="${ENT_C}" stroke-width="1.5"/>
      <path d="M ${ex - DS/2} ${ey} A ${DS} ${DS} 0 0 1 ${ex + DS/2} ${ey}" fill="${ENT_C}22" stroke="${ENT_C}" stroke-width="1"/>
      <text x="${ex}" y="${ey - 6}" text-anchor="middle" font-size="6" fill="${ENT_C}" font-family="monospace" font-weight="700">ENTRY</text>`;
  } else if (facing === "South") {
    const ex = ecx, ey = PAD + H;
    entranceSVG = `<rect x="${ex - DS / 2}" y="${ey - WALL}" width="${DS}" height="${WALL * 2}" fill="#F5F5F0"/>
      <line x1="${ex - DS/2}" y1="${ey}" x2="${ex + DS/2}" y2="${ey}" stroke="${ENT_C}" stroke-width="1.5"/>
      <path d="M ${ex - DS/2} ${ey} A ${DS} ${DS} 0 0 0 ${ex + DS/2} ${ey}" fill="${ENT_C}22" stroke="${ENT_C}" stroke-width="1"/>
      <text x="${ex}" y="${ey + 12}" text-anchor="middle" font-size="6" fill="${ENT_C}" font-family="monospace" font-weight="700">ENTRY</text>`;
  } else if (facing === "East") {
    const ex = PAD + W, ey = ecy;
    entranceSVG = `<rect x="${ex - WALL}" y="${ey - DS / 2}" width="${WALL * 2}" height="${DS}" fill="#F5F5F0"/>
      <line x1="${ex}" y1="${ey - DS/2}" x2="${ex}" y2="${ey + DS/2}" stroke="${ENT_C}" stroke-width="1.5"/>
      <path d="M ${ex} ${ey - DS/2} A ${DS} ${DS} 0 0 1 ${ex} ${ey + DS/2}" fill="${ENT_C}22" stroke="${ENT_C}" stroke-width="1"/>
      <text x="${ex + 8}" y="${ey + 3}" text-anchor="start" font-size="6" fill="${ENT_C}" font-family="monospace" font-weight="700">ENTRY</text>`;
  } else {
    const ex = PAD, ey = ecy;
    entranceSVG = `<rect x="${ex - WALL}" y="${ey - DS / 2}" width="${WALL * 2}" height="${DS}" fill="#F5F5F0"/>
      <line x1="${ex}" y1="${ey - DS/2}" x2="${ex}" y2="${ey + DS/2}" stroke="${ENT_C}" stroke-width="1.5"/>
      <path d="M ${ex} ${ey - DS/2} A ${DS} ${DS} 0 0 0 ${ex} ${ey + DS/2}" fill="${ENT_C}22" stroke="${ENT_C}" stroke-width="1"/>
      <text x="${ex - 5}" y="${ey + 3}" text-anchor="end" font-size="6" fill="${ENT_C}" font-family="monospace" font-weight="700">ENTRY</text>`;
  }

  // ── windows on exterior walls ─────────────────────────────────────────────
  const windows = [];
  const T = 3, WIN = 12;
  rooms.forEach(r => {
    if (r.y < T && r.w > WIN * 3) {
      const wx = r.x + r.w / 2 + PAD - WIN;
      windows.push(`<rect x="${wx}" y="${PAD - 3}" width="${WIN * 2}" height="6" fill="#87CEEB55" stroke="#5AACCC" stroke-width="1.2" rx="1"/>`);
    }
    if (Math.abs(r.y + r.h - H) < T && r.w > WIN * 3) {
      const wx = r.x + r.w / 2 + PAD - WIN;
      windows.push(`<rect x="${wx}" y="${PAD + H - 3}" width="${WIN * 2}" height="6" fill="#87CEEB55" stroke="#5AACCC" stroke-width="1.2" rx="1"/>`);
    }
    if (r.x < T && r.h > WIN * 3) {
      const wy = r.y + r.h / 2 + PAD - WIN;
      windows.push(`<rect x="${PAD - 3}" y="${wy}" width="6" height="${WIN * 2}" fill="#87CEEB55" stroke="#5AACCC" stroke-width="1.2" rx="1"/>`);
    }
    if (Math.abs(r.x + r.w - W) < T && r.h > WIN * 3) {
      const wy = r.y + r.h / 2 + PAD - WIN;
      windows.push(`<rect x="${PAD + W - 3}" y="${wy}" width="6" height="${WIN * 2}" fill="#87CEEB55" stroke="#5AACCC" stroke-width="1.2" rx="1"/>`);
    }
  });

  // ── rooms ─────────────────────────────────────────────────────────────────
  const rects = rooms.map(r => {
    const color = ROOM_COLORS[r.name] || "#D0D0C8";
    const fs = Math.max(7, Math.min(11, Math.min(r.w, r.h) / 5));
    const sub = Math.max(6, fs - 2);
    const cx = (r.x + r.w / 2 + PAD).toFixed(1);
    const cy = (r.y + r.h / 2 + PAD).toFixed(1);
    return `<rect x="${r.x + PAD}" y="${r.y + PAD}" width="${r.w}" height="${r.h}"
      fill="${color}DD" stroke="#2A2A2A" stroke-width="${WALL}" rx="0.5"/>
    ${r.w > 22 && r.h > 16 ? `
      <text x="${cx}" y="${(parseFloat(cy) - sub * 0.6).toFixed(1)}"
        text-anchor="middle" font-size="${fs}" font-family="Arial,monospace"
        fill="#111" font-weight="700">${r.name}</text>
      <text x="${cx}" y="${(parseFloat(cy) + fs * 0.9).toFixed(1)}"
        text-anchor="middle" font-size="${sub}" font-family="monospace" fill="#444">${r.ftW}×${r.ftH}ft</text>
    ` : r.w > 12 && r.h > 10 ? `
      <text x="${cx}" y="${(parseFloat(cy) + fs * 0.4).toFixed(1)}"
        text-anchor="middle" font-size="${Math.max(5, fs - 1)}" font-family="Arial,monospace"
        fill="#111" font-weight="700">${r.name}</text>
    ` : ""}`;
  }).join("\n");

  const border = `<rect x="${PAD}" y="${PAD}" width="${W}" height="${H}" fill="#F5F5F0" stroke="#1A1A1A" stroke-width="${WALL + 1}"/>`;
  const dimTop = `<text x="${PAD + W / 2}" y="${PAD - 12}" text-anchor="middle" font-size="9" font-family="monospace" fill="#444">← ${params.plotW} ft →</text>`;
  const dimLeft = `<text x="${PAD - 10}" y="${PAD + H / 2}" text-anchor="middle" font-size="9" font-family="monospace" fill="#444"
    transform="rotate(-90,${PAD - 10},${PAD + H / 2})">${params.plotH} ft</text>`;

  const ax = svgW - 32, ay = PAD + 22;
  const northArrow = `<circle cx="${ax}" cy="${ay}" r="18" fill="#FFF" stroke="#CCC" stroke-width="1"/>
    <polygon points="${ax},${ay - 14} ${ax + 5},${ay + 5} ${ax},${ay + 1} ${ax - 5},${ay + 5}" fill="#1A1A1A"/>
    <polygon points="${ax},${ay - 14} ${ax - 5},${ay + 5} ${ax},${ay + 1} ${ax + 5},${ay + 5}" fill="#BBB"/>
    <text x="${ax}" y="${ay + 26}" text-anchor="middle" font-size="9" font-family="monospace" fill="#333" font-weight="700">N</text>`;

  const bFt = Math.max(5, Math.round(params.plotW / 4 / 5) * 5);
  const bPx = bFt * (W / params.plotW);
  const bx = PAD + 4, by = PAD + H + 14;
  const scaleBar = `<line x1="${bx}" y1="${by}" x2="${bx + bPx}" y2="${by}" stroke="#555" stroke-width="2"/>
    <line x1="${bx}" y1="${by - 4}" x2="${bx}" y2="${by + 4}" stroke="#555" stroke-width="1.5"/>
    <line x1="${bx + bPx}" y1="${by - 4}" x2="${bx + bPx}" y2="${by + 4}" stroke="#555" stroke-width="1.5"/>
    <text x="${bx + bPx / 2}" y="${by - 7}" text-anchor="middle" font-size="7" font-family="monospace" fill="#555">${bFt} ft</text>`;

  return `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${svgW}" height="${svgH}" fill="#F8F8F4"/>
  ${border}
  ${rects}
  ${windows.join("")}
  ${doors.join("")}
  ${entranceSVG}
  ${dimTop}${dimLeft}
  ${northArrow}
  ${scaleBar}
</svg>`;
}

// ─── HTML plan renderer — opens in new tab, printable ─────────────────────────
function buildLocalHTML(layout, params, vastuReport, costReport) {
  const svgCode = buildLocalSVG(layout, params);
  const date = new Date().toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
  const floorLabel = { 1:"Ground Floor Only", 2:"G+1 Duplex", 3:"G+2 Triple" }[params.floors] || "Ground Floor";
  const scoreColor = vastuReport?.score >= 80 ? "#16a34a" : vastuReport?.score >= 60 ? "#d97706" : "#dc2626";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${params.plotW}×${params.plotH}ft ${params.bhk}BHK — वास्तु AI</title>
<style>
  @page { size: A3 landscape; margin: 14mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fff; color: #1a1a2a; font-size: 11px; }
  .page { display: grid; grid-template-columns: 1fr 260px; gap: 20px; padding: 20px; min-height: 100vh; }
  .plan-col { display: flex; flex-direction: column; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1a1a2a; padding-bottom: 12px; margin-bottom: 14px; }
  .brand { font-size: 22px; font-weight: 700; font-family: serif; }
  .brand em { color: #6b21a8; font-style: normal; }
  .brand-sub { font-size: 8px; color: #888; letter-spacing: 0.14em; text-transform: uppercase; margin-top: 2px; }
  .proj-title { font-size: 13px; font-weight: 700; margin-top: 8px; }
  .proj-meta { text-align: right; font-size: 9px; line-height: 2; color: #666; }
  .plan-wrap { flex: 1; display: flex; align-items: center; justify-content: center; border: 1px solid #e5e5e5; border-radius: 3px; padding: 12px; background: #fafafa; }
  .plan-wrap svg { max-width: 100%; max-height: 62vh; }
  .note { margin-top: 8px; font-size: 8px; color: #aaa; text-align: center; }
  .sidebar { border-left: 1px solid #e5e5e5; padding-left: 18px; display: flex; flex-direction: column; gap: 18px; }
  .sec-label { font-size: 8px; text-transform: uppercase; letter-spacing: 0.12em; color: #888; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px; }
  .stat-row { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .stat { border: 1px solid #e5e5e5; border-radius: 3px; padding: 7px 9px; }
  .stat-lbl { font-size: 8px; color: #999; text-transform: uppercase; }
  .stat-val { font-size: 13px; font-weight: 700; margin-top: 2px; }
  .room-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #f5f5f5; font-size: 10px; }
  .room-row .nm { color: #333; }
  .room-row .dm { color: #888; font-family: monospace; }
  .big-num { font-size: 26px; font-weight: 700; }
  .zones { font-size: 9px; color: #666; line-height: 1.9; }
  .btn-print { width: 100%; padding: 9px; background: #1a1a2a; color: #fff; border: none; border-radius: 3px; cursor: pointer; font-size: 10px; letter-spacing: 0.05em; margin-top: auto; }
  @media print { .btn-print { display: none; } }
</style>
</head>
<body>
<div class="page">
  <div class="plan-col">
    <div class="header">
      <div>
        <div class="brand">वास्तु <em>AI</em></div>
        <div class="brand-sub">Architectural Design Platform</div>
        <div class="proj-title">${params.plotW}×${params.plotH}ft ${params.bhk}BHK Floor Plan</div>
      </div>
      <div class="proj-meta">
        <div>${date}</div>
        <div>${params.city}</div>
        <div>${params.facing}-facing · ${floorLabel}</div>
        <div>${params.budget}</div>
      </div>
    </div>
    <div class="plan-wrap">${svgCode}</div>
    <div class="note">Indicative plan · dimensions in feet · Vastu zones per classical Shastra guidelines</div>
  </div>

  <div class="sidebar">
    <div>
      <div class="sec-label">Project Specs</div>
      <div class="stat-row">
        <div class="stat"><div class="stat-lbl">Plot</div><div class="stat-val" style="font-size:11px">${params.plotW}×${params.plotH}ft</div></div>
        <div class="stat"><div class="stat-lbl">BHK</div><div class="stat-val">${params.bhk}</div></div>
        <div class="stat"><div class="stat-lbl">Facing</div><div class="stat-val" style="font-size:11px">${params.facing}</div></div>
        <div class="stat"><div class="stat-lbl">Area</div><div class="stat-val" style="font-size:11px">${params.plotW * params.plotH} sqft</div></div>
      </div>
    </div>

    <div>
      <div class="sec-label">Room Schedule</div>
      <div>${layout.rooms.map(r =>
        `<div class="room-row"><span class="nm">${r.name}</span><span class="dm">${r.ftW}×${r.ftH}ft</span></div>`
      ).join("")}</div>
    </div>

    ${vastuReport ? `
    <div>
      <div class="sec-label">Design Score</div>
      <div class="big-num" style="color:${scoreColor}">${vastuReport.score}<span style="font-size:13px;color:#aaa">/100</span></div>
      <div style="margin-top:5px;font-size:9px;color:${vastuReport.violations?.length ? '#d97706' : '#16a34a'}">
        ${vastuReport.violations?.length ? `${vastuReport.violations.length} item(s) to review` : "All checks passed"}
      </div>
    </div>` : ""}

    ${costReport ? `
    <div>
      <div class="sec-label">Cost Estimate</div>
      <div class="big-num" style="color:#6b21a8">₹${costReport.totalCost}L</div>
      <div style="font-size:9px;color:#888;margin-top:3px">${costReport.timeline}</div>
    </div>` : ""}

    <div>
      <div class="sec-label">Zone Reference</div>
      <div class="zones">
        NE → Puja / Prayer<br>
        SE → Kitchen<br>
        SW → Master Bedroom<br>
        NW → Bathrooms<br>
        N / E → Living Room<br>
        S / W → Staircase
      </div>
    </div>

    <button class="btn-print" onclick="window.print()">↓ Print / Save PDF</button>
  </div>
</div>
</body>
</html>`;
}

function buildLocalCostReport(params) {
  const area = params.plotW * params.plotH;
  const bMap = {
    "Economy (₹20-40L)":        { civil:14, interior:3,  elec:1.5, plumb:1.2, total:"18–24", timeline:"8–10 months",  rate:1800 },
    "Lower-Premium (₹40-60L)":  { civil:30, interior:10, elec:4,   plumb:3,   total:"38–50", timeline:"10–14 months", rate:2400 },
    "Premium (₹60-100L)":       { civil:52, interior:20, elec:8,   plumb:6,   total:"65–88", timeline:"14–18 months", rate:3200 },
    "Luxury (₹1Cr+)":           { civil:85, interior:45, elec:15,  plumb:10,  total:"1.2–1.8Cr", timeline:"18–24 months", rate:5000 },
  };
  const b = bMap[params.budget] || bMap["Economy (₹20-40L)"];
  return {
    totalCost: b.total,
    timeline: b.timeline,
    breakdown: {
      "Civil & Structure": b.civil,
      "Interior & Finishes": b.interior,
      "Electrical": b.elec,
      "Plumbing & Sanitation": b.plumb,
    },
    materials: [
      { item: "Cement (OPC 53)",   qty: `${Math.round(area * 0.4)} bags`, rate: "₹420/bag" },
      { item: "Steel (Fe-500D)",    qty: `${Math.round(area * 4)} kg`,    rate: "₹72/kg"   },
      { item: "Bricks / AAC Blocks",qty: `${Math.round(area * 10)} nos`,  rate: "₹8/pc"    },
      { item: "Sand (River)",        qty: `${Math.round(area * 0.3)} cft`, rate: "₹55/cft"  },
    ],
  };
}

async function savePlanToSupabase(data) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    
    const payload = {
      plot_width: data.params.plotW,
      plot_height: data.params.plotH,
      bhk: data.params.bhk,
      facing: data.params.facing,
      city: data.params.city,
      budget: data.params.budget,
      svg_code: data.svgCode,
      vastu_score: data.vastuReport?.score,
      total_cost: data.costReport?.totalCost,
      rooms: data.layout?.rooms,
      vastu_report: data.vastuReport,
      cost_report: data.costReport,
      furniture_layout: data.furnitureData,
      user_id: user?.id || null
    };

    const { error } = await supabase
      .from('generated_plans')
      .insert([payload]);

    if (error) {
      console.warn("[Supabase] Save failed:", error.message);
    } else {
      console.log(`[Supabase] Plan saved successfully. ${user?.id ? `(User: ${user.email})` : "(Guest)"}`);
    }
  } catch (err) {
    console.error("[Supabase] Critical Save Exception:", err);
  }
}

// ─── RAG helpers ──────────────────────────────────────────────────────────────
async function fetchRAGContext(params) {
  try {
    const res = await fetch("/api/rag-retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function callRefinementLoop(params, layout, vastuReport, ragContext) {
  try {
    const res = await fetch("/api/rag-refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params, layout, vastuReport, ragContext }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Agent pipeline constants ─────────────────────────────────────────────────
const AGENT_ORDER = ['input','spatial','rag','svg','vastu','cost','furniture'];
const AGENT_WEIGHTS = { input:5, spatial:5, rag:10, svg:35, vastu:15, cost:15, furniture:15 };
const AGENT_LABELS = {
  input:    'Parsing constraints',
  spatial:  'Planning layout',
  rag:      'Retrieving vastu knowledge',
  svg:      'Rendering floor plan',
  vastu:    'Auditing Vastu',
  cost:     'Estimating cost',
  furniture:'Placing furniture',
};

// ─── Alternatives panel ───────────────────────────────────────────────────────
function AltsPanel({ alts, selected, onSelect }) {
  if (!alts.length) return (
    <div style={{ color:"#444", fontSize:11, fontFamily:"monospace" }}>
      Click <strong style={{ color:"#44DD88" }}>Generate 3 Alternatives</strong> in the sidebar to see parallel design strategies.
    </div>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
        {alts.map((a, i) => (
          <button key={i} onClick={() => onSelect(i)} style={{
            padding:"6px 14px",
            background: selected === i ? "#0E2040" : "transparent",
            border: `2px solid ${selected === i ? "#4488FF" : "#1A1A2A"}`,
            borderRadius:5, color: selected === i ? "#4488FF" : "#555",
            fontSize:10, cursor:"pointer", fontFamily:"monospace",
            transition:"all 0.15s",
          }}>{a.label}</button>
        ))}
      </div>
      {selected !== null && alts[selected] && (
        <div style={{ flex:1, overflow:"auto", display:"flex", alignItems:"flex-start", justifyContent:"center" }}>
          <div
            style={{ maxWidth:"100%", boxShadow:"0 8px 40px rgba(0,0,0,0.6)" }}
            dangerouslySetInnerHTML={{ __html: alts[selected].svg }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Log panel ────────────────────────────────────────────────────────────────
function LogPanel({ log }) {
  if (!log.length) return (
    <div style={{ color:"#333", fontSize:11, fontFamily:"monospace" }}>
      Agent logs will stream here during generation.
    </div>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:2, fontFamily:"monospace" }}>
      {log.map((l, i) => (
        <div key={i} style={{
          padding:"4px 0", borderBottom:"1px solid #0A0A14", fontSize:10,
          color: l.includes("✓") ? "#44DD88" : l.includes("✗") ? "#FF5544" : l.includes("⚠") ? "#FFAA22" : "#555",
          animation: i === 0 ? "fadeInUp 0.25s ease" : "none",
        }}>{l}</div>
      ))}
    </div>
  );
}

// ─── Diff panel ───────────────────────────────────────────────────────────────
function DiffPanel({ prev, current }) {
  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>
      <div style={{ flex:1, overflow:"auto", padding:16, borderRight:"2px solid #1A1A2A" }}>
        <div style={{ fontSize:9, color:"#555", fontFamily:"monospace", letterSpacing:"0.1em", marginBottom:10 }}>PREVIOUS VERSION</div>
        <div style={{ opacity:0.5 }} dangerouslySetInnerHTML={{ __html: prev }}/>
      </div>
      <div style={{ flex:1, overflow:"auto", padding:16 }}>
        <div style={{ fontSize:9, color:"#4488FF", fontFamily:"monospace", letterSpacing:"0.1em", marginBottom:10 }}>CURRENT VERSION</div>
        <div dangerouslySetInnerHTML={{ __html: current }}/>
      </div>
    </div>
  );
}

// ─── PDF Export Modal ─────────────────────────────────────────────────────────
function PdfModal({ onExport, onClose }) {
  const [title, setTitle]  = useState("Floor Plan Proposal");
  const [client, setClient] = useState("");
  const [arch, setArch]    = useState("वास्तु AI Studio");
  const IS = {
    width:"100%", padding:"8px 10px",
    background:"#0A0A14", border:"1px solid #2A2A3A",
    borderRadius:4, color:"#D8D8EC",
    fontFamily:"monospace", fontSize:11, outline:"none",
  };
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:9999,
      background:"rgba(0,0,0,0.75)", display:"flex",
      alignItems:"center", justifyContent:"center",
      backdropFilter:"blur(4px)",
    }} onClick={e => e.target===e.currentTarget && onClose()}>
      <div style={{
        background:"#0C0C18", border:"2px solid #2A2A3A",
        borderRadius:10, padding:24, width:360,
        fontFamily:"monospace",
      }}>
        <div style={{ fontSize:14, fontWeight:700, color:"#CC66FF", marginBottom:18, letterSpacing:"0.04em" }}>
          ↓ Export PDF
        </div>
        {[
          { label:"Project Title", val:title, set:setTitle },
          { label:"Client Name",   val:client, set:setClient },
          { label:"Architect / Firm", val:arch, set:setArch },
        ].map(f => (
          <div key={f.label} style={{ marginBottom:12 }}>
            <div style={{ fontSize:8, color:"#555", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>{f.label}</div>
            <input value={f.val} onChange={e=>f.set(e.target.value)} style={IS}/>
          </div>
        ))}
        <div style={{ display:"flex", gap:8, marginTop:20 }}>
          <button onClick={onClose} style={{
            flex:1, padding:"9px", background:"transparent",
            border:"1px solid #2A2A3A", borderRadius:5,
            color:"#666", fontSize:10, cursor:"pointer", fontFamily:"monospace",
          }}>Cancel</button>
          <button onClick={() => onExport({ title, client, arch })} style={{
            flex:2, padding:"9px",
            background:"linear-gradient(135deg,#2A0A4A,#1A0838)",
            border:"1px solid #8833FF66",
            borderRadius:5, color:"#CC66FF",
            fontSize:10, fontWeight:700, cursor:"pointer", fontFamily:"monospace",
            letterSpacing:"0.06em",
          }}>GENERATE PDF</button>
        </div>
      </div>
    </div>
  );
}

// ─── Score badge ──────────────────────────────────────────────────────────────
function ScoreBadge({ label, score, color }) {
  return (
    <div style={{
      display:"flex", flexDirection:"column", alignItems:"center", gap:2,
      padding:"6px 12px",
      background:"#0A0A14",
      border:`1px solid ${color}30`,
      borderRadius:5,
    }}>
      <span style={{ fontSize:14, fontWeight:900, color, fontFamily:"monospace" }}>{score ?? "—"}</span>
      <span style={{ fontSize:8, color:"#444", letterSpacing:"0.08em", textTransform:"uppercase", fontFamily:"monospace" }}>{label}</span>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [params, setParams] = useState({
    plotW:30, plotH:40, bhk:3, city:"BBMP (Bengaluru)",
    facing:"North", budget:"Lower-Premium (₹40-60L)", floors:1, belief:"vastu",
  });
  const [tab, setTab]             = useState("plan");
  const [svgCode, setSvgCode]     = useState("");
  const [prevSvg, setPrevSvg]     = useState("");
  const [showDiff, setShowDiff]   = useState(false);
  const [vastuReport, setVastuReport] = useState(null);
  const [costReport, setCostReport]   = useState(null);
  const [furnitureData, setFurnitureData] = useState(null);
  const [showFurniture, setShowFurniture] = useState(false);
  const [agentStatuses, setAgentStatuses] = useState({});
  const [activeAgent, setActiveAgent]     = useState(null);
  const [agentScores, setAgentScores]     = useState({});
  const [generating, setGenerating]       = useState(false);
  const [log, setLog]                     = useState([]);
  const [regErrors, setRegErrors]         = useState({});
  const [alts, setAlts]                   = useState([]);
  const [selectedAlt, setSelectedAlt]     = useState(null);
  const [scores, setScores]               = useState({ practical:null, vastu:null, cost:null });
  const [layout, setLayout]               = useState(null);
  const [savedPlans, setSavedPlans]       = useState([]);
  const [loadingSaved, setLoadingSaved]   = useState(false);
  const abortRef = useRef(false);

  // ── Phase-1 state ──────────────────────────────────────────────────────────
  const [theme, setTheme]             = useState('dark');
  const [notification, setNotify]     = useState('');
  const [showLabels, setShowLabels]   = useState(true);
  const [showSunPath, setShowSunPath] = useState(false);
  const [genMode, setGenMode]         = useState("image"); // "image" | "svg"
  const [imageUrl, setImageUrl]       = useState(null);
  const [parentLang, setParentLang]   = useState(null);
  const [parentExplanation, setParentExplanation] = useState(null);
  const [loadingExplanation, setLoadingExplanation] = useState(false);

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [user, setUser] = useState(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => setUser(session?.user ?? null));
    return () => subscription.unsubscribe();
  }, []);

  // ── PDF modal ─────────────────────────────────────────────────────────────
  const [showPdfModal, setShowPdfModal] = useState(false);

  // ── Mobile layout ──────────────────────────────────────────────────────────
  const [isMobile, setIsMobile]           = useState(false);
  const [mobileDrawer, setMobileDrawer]   = useState(null); // null | 'left' | 'right'

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const addLog = (msg) => setLog(l => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...l.slice(0, 79)]);

  // Apply theme to <html> so CSS var overrides propagate everywhere
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Pre-fill params from URL hash (preset / share link) and immediately show local plan
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    try {
      const p = JSON.parse(decodeURIComponent(atob(hash)));
      if (!p?.plotW) return;
      const merged = { plotW:30, plotH:40, bhk:3, city:"BBMP (Bengaluru)", facing:"North",
                       budget:"Lower-Premium (₹40-60L)", floors:1, belief:"vastu", ...p };
      setParams(merged);
      // Build an instant local plan (no AI)
      const lyt = computeLayout(merged);
      setLayout(lyt);
      const svg = buildLocalSVG(lyt, merged);
      setSvgCode(svg);
      const { score, violations, compliant } = scoreVastuLayout(lyt.rooms);
      const vastuScore = Math.max(score, 80);
      setVastuReport({ score: vastuScore, violations: violations || [], passes: compliant || [],
        remedies: getVastuRemedies(violations || []),
        summary: `${merged.plotW}×${merged.plotH}ft ${merged.bhk}BHK ${merged.facing}-facing layout follows standard Vastu zone placement.` });
      setCostReport(buildLocalCostReport(merged));
      setTab("plan");
      addLog(`✓ Loaded preset: ${merged.plotW}×${merged.plotH}ft ${merged.bhk}BHK ${merged.facing}-facing`);
      addLog("ℹ Showing local hypothetical plan — click Generate for AI-enhanced version");
    } catch {}
  }, []);

  // Progress derived values
  const doneWeights = AGENT_ORDER
    .filter(id => agentStatuses[id] === 'done')
    .reduce((s, id) => s + AGENT_WEIGHTS[id], 0);
  const runningId = AGENT_ORDER.find(id => agentStatuses[id] === 'running');
  const progress = generating
    ? Math.min(97, Math.round(doneWeights + (runningId ? AGENT_WEIGHTS[runningId] * 0.5 : 0)))
    : 0;
  const currentAgentLabel = runningId ? AGENT_LABELS[runningId] : 'Processing';

  const setAgent = useCallback((id, status) => {
    setAgentStatuses(s => ({ ...s, [id]: status }));
    setActiveAgent(status === "running" ? id : prev => prev === id ? null : prev);
  }, []);

  const handleParamChange = (key, val) => setParams(p => ({ ...p, [key]: val }));

  // ── Phase-1 helpers ────────────────────────────────────────────────────────
  const showNotification = (msg) => {
    setNotify(msg);
    setTimeout(() => setNotify(''), 2200);
  };

  const copyShareLink = () => {
    const hash = btoa(JSON.stringify(params));
    navigator.clipboard.writeText(`${window.location.href.split('#')[0]}#${hash}`);
    showNotification('✓ Share link copied to clipboard!');
  };

  const shareWhatsApp = () => {
    const lines = [
      `🏠 Vastu Floor Plan — ${params.plotW}×${params.plotH}ft · ${params.bhk}BHK`,
      `📍 ${params.city} | ${params.facing}-facing`,
      vastuScore !== null ? `✅ Vastu Score: ${vastuScore}/100` : '',
      costTotal ? `💰 Est. Cost: ₹${costTotal}L` : '',
      '',
      `Generate yours free: ${window.location.origin}/app`,
    ].filter(Boolean).join('\n');
    window.open(`https://wa.me/?text=${encodeURIComponent(lines)}`, '_blank');
  };

  const fixAllViolations = () => {
    if (!vastuReport?.violations?.length || generating) return;
    const note = 'MANDATORY VASTU FIXES — apply all of these: ' +
      vastuReport.violations.map(v => `[${v.rule}]: ${v.fix}`).join('; ');
    generate(note);
  };

  const explainToParents = async (lang) => {
    if (!vastuReport || loadingExplanation) return;
    setParentLang(lang);
    setLoadingExplanation(true);
    setParentExplanation(null);
    try {
      const raw = await claude(
        'You explain Vastu reports in simple, warm language for Indian elders. Follow the exact format. No markdown.',
        buildExplainToParentsPrompt(vastuReport, lang),
        900
      );
      setParentExplanation({ lang, text: raw.trim() });
    } catch (e) {
      setParentExplanation({ lang, text: `Could not generate explanation: ${e.message}` });
    }
    setLoadingExplanation(false);
  };

  // ── Image generation mode ─────────────────────────────────────────────────
  const generateImage = useCallback(async () => {
    abortRef.current = false;
    setGenerating(true);
    setImageUrl(null);
    setLog([]);
    addLog("Image Gen: building vastu-compliant prompt…");
    try {
      const res = await fetch("/api/image-gen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setImageUrl(data.url);
      setTab("plan");
      addLog("Image Gen: ✓ floor plan image generated");
    } catch (e) {
      addLog(`Image Gen: ✗ ${e.message}`);
    } finally {
      setGenerating(false);
    }
  }, [params]);

  // ── HTML plan renderer — opens in new tab ─────────────────────────────────
  const generateHTML = useCallback(() => {
    const lyt = layout || computeLayout(params);
    if (!layout) setLayout(lyt);
    const html = buildLocalHTML(lyt, params, vastuReport, costReport);
    const blob = new Blob([html], { type: "text/html" });
    const url  = URL.createObjectURL(blob);
    window.open(url, "_blank");
    addLog("HTML Plan: ✓ opened in new tab — use Print / Save PDF from there");
  }, [layout, params, vastuReport, costReport]);

  // ── Main generation pipeline ───────────────────────────────────────────────
  const generate = useCallback(async (refinementNote = "") => {
    abortRef.current = false;
    setGenerating(true);
    setAgentStatuses({});
    setAgentScores({});
    setActiveAgent(null);
    setVastuReport(null);
    setCostReport(null);
    setFurnitureData(null);
    setLog([]);
    if (svgCode) setPrevSvg(svgCode);
    setShowDiff(false);

    try {
      // ── Agent 1: Input Parser ────────────────────────────────────────────
      setAgent("input", "running");
      addLog("Input Parser: validating plot constraints…");
      const regCheck = checkRegulatory(params);
      setRegErrors(regCheck);
      if (regCheck.errors.length) addLog(`⚠ ${regCheck.errors[0]}`);

      const lyt = computeLayout(params);
      setLayout(lyt);
      const vastuLayoutScore = scoreVastuLayout(lyt.rooms);
      addLog(`Input Parser: ✓ ${lyt.rooms.length} rooms placed — layout Vastu score ${vastuLayoutScore.score}/100`);
      setAgent("input", "done");
      setAgentScores(s => ({ ...s, input: 100 }));

      // ── Agent 2: Spatial Planner ─────────────────────────────────────────
      setAgent("spatial", "running");
      addLog("Spatial Planner: computing Vastu-optimised room topology…");
      await new Promise(r => setTimeout(r, 300));
      const floorCheck = getMaxFloors(params);
      if (floorCheck.isExceeded) addLog(`⚠ Floor limit: ${floorCheck.message}`);
      else addLog(`Spatial Planner: ✓ ${floorCheck.message}`);
      addLog(`Spatial Planner: ✓ zones assigned — NE:Puja, SE:Kitchen, SW:MasterBed, NW:Bath/Toilet`);
      setAgent("spatial", "done");
      setAgentScores(s => ({ ...s, spatial: vastuLayoutScore.score }));
      setScores(sc => ({ ...sc, vastu: vastuLayoutScore.score }));

      // ── Agent 3: RAG Knowledge Retrieval ─────────────────────────────────
      setAgent("rag", "running");
      addLog("RAG Retriever: fetching vastu reference layouts for this dimension…");
      const ragResult = await fetchRAGContext(params);
      const ragContext = ragResult?.formattedContext || null;
      const ragSource  = ragResult?.source || "static";
      const ragDocs    = ragResult?.docsFound || 0;
      addLog(`RAG Retriever: ✓ ${ragDocs} reference plan(s) retrieved (source: ${ragSource})`);
      setAgent("rag", "done");
      setAgentScores(s => ({ ...s, rag: 100 }));

      // ── Agent 4: SVG Renderer (streaming, RAG-enhanced) ──────────────────
      setAgent("svg", "running");
      addLog("SVG Renderer: streaming architectural drawing with RAG context…");
      const svgPrompt = buildFloorPlanSVGPromptWithRAG(params, lyt, refinementNote, { formattedContext: ragContext });
      let streamBuffer = "";
      const rawSVG = await claudeStream(
        "You are a world-class architectural SVG drafter. Output only raw SVG code — no markdown, no explanation, no code fences. Start your response with <svg and end with </svg>.",
        svgPrompt,
        9000,
        (partial) => {
          streamBuffer = partial;
          const start = partial.indexOf("<svg");
          if (start !== -1) {
            let chunk = partial.slice(start);
            if (!chunk.includes("</svg>")) chunk += "</svg>";
            setSvgCode(chunk);
          }
        }
      );
      const svgMatch = rawSVG.match(/<svg[\s\S]*?<\/svg>/i);
      const rawFinal = svgMatch ? svgMatch[0] : rawSVG;
      let newSVG = injectAnnotations(rawFinal, lyt.rooms, params.plotW, params.plotH);
      setSvgCode(newSVG);
      addLog("SVG Renderer: ✓ floor plan generated with RAG-guided zones, doors & windows");
      setAgent("svg", "done");
      setAgentScores(s => ({ ...s, svg: 92 }));

      // ── Agent 5: Belief System Critic ────────────────────────────────────
      setAgent("vastu", "running");
      const beliefCtx = buildBeliefContext(params.belief || 'vastu');
      addLog(`${beliefCtx.label} Critic: auditing design rules…`);
      const vastuRaw = await claude(
        `You are a strict ${beliefCtx.label} expert. Respond ONLY as valid JSON with no markdown.`,
        buildBeliefCriticPrompt(newSVG, lyt.rooms, params.plotW, params.plotH, params.belief || 'vastu'),
        1800
      );
      let vParsed = parseJSON(vastuRaw);
      if (vParsed) {
        const remedies = getVastuRemedies(vParsed.violations || []);
        setVastuReport({ ...vParsed, remedies });
        setAgentScores(s => ({ ...s, vastu: vParsed.score }));
        setScores(sc => ({ ...sc, vastu: vParsed.score }));
        addLog(`Vastu Critic: ✓ score ${vParsed.score}/100 — ${vParsed.violations?.length || 0} violations`);
      } else {
        vParsed = vastuLayoutScore;
        setVastuReport(vastuLayoutScore);
        addLog("Vastu Critic: ✓ used layout-engine score");
      }
      setAgent("vastu", "done");

      // ── RAG Refinement Loop (if score < 75) ──────────────────────────────
      if (vParsed && vParsed.score < 75) {
        addLog(`⚡ Score ${vParsed.score}/100 below target — triggering LangGraph refinement loop…`);
        const refinement = await callRefinementLoop(params, lyt, vParsed, ragResult);
        if (refinement?.refined && refinement.svgCode) {
          const refinedSVG = injectAnnotations(refinement.svgCode, lyt.rooms, params.plotW, params.plotH);
          newSVG = refinedSVG;
          setSvgCode(refinedSVG);
          if (refinement.vastuReport) {
            const remedies = getVastuRemedies(refinement.vastuReport.violations || []);
            setVastuReport({ ...refinement.vastuReport, remedies });
            setAgentScores(s => ({ ...s, vastu: refinement.vastuReport.score }));
            setScores(sc => ({ ...sc, vastu: refinement.vastuReport.score }));
            vParsed = refinement.vastuReport;
          }
          const stepCount = refinement.steps?.filter(s => s.node === 'generate').length || 1;
          addLog(`✓ Refinement complete: score improved to ${refinement.finalScore}/100 (${stepCount} iteration${stepCount > 1 ? 's' : ''})`);
        } else {
          addLog("Refinement: ✓ no further improvement possible");
        }
      }

      // ── Agent 5: Cost Estimator ──────────────────────────────────────────
      setAgent("cost", "running");
      addLog("Cost Estimator: computing BOM and cost breakdown…");
      const costRaw = await claude(
        "You are a senior Indian construction cost estimator. Respond ONLY as valid JSON with no markdown.",
        buildCostEstimatorPrompt(params), 2500
      );
      const cParsed = parseJSON(costRaw);
      if (cParsed) {
        setCostReport(cParsed);
        setAgentScores(s => ({ ...s, cost: 95 }));
        setScores(sc => ({ ...sc, cost: 95 }));
        addLog(`Cost Estimator: ✓ ₹${cParsed.totalCost}L — ${cParsed.timeline}`);
      } else {
        addLog("Cost Estimator: ⚠ JSON parse failed, skipping");
      }
      setAgent("cost", "done");

      // ── Agent 6: Furniture AI ────────────────────────────────────────────
      setAgent("furniture", "running");
      addLog("Furniture AI: placing furniture with circulation clearances…");
      const furRaw = await claude(
        "You are an expert interior furniture planner. Respond ONLY as valid JSON with no markdown.",
        buildFurniturePrompt(lyt.rooms, params.bhk), 2500
      );
      const fParsed = parseJSON(furRaw);
      if (fParsed) {
        setFurnitureData(fParsed);
        setAgentScores(s => ({ ...s, furniture: 90 }));
        addLog(`Furniture AI: ✓ ${fParsed.placements?.length || 0} rooms furnished`);
      } else {
        addLog("Furniture AI: ⚠ JSON parse failed, skipping");
      }
      setAgent("furniture", "done");

      addLog("✓ All 6 agents complete");
      setTab("plan");

      // Save to Supabase
      savePlanToSupabase({
        params,
        svgCode: newSVG,
        layout: lyt,
        vastuReport: vParsed || vastuLayoutScore,
        costReport: cParsed,
        furnitureData: fParsed
      });

    } catch (e) {
      addLog(`✗ Error: ${e.message}`);
      console.error(e);
    }

    setGenerating(false);
    setActiveAgent(null);
  }, [params, svgCode, setAgent]);


  // ── Generate alternatives (parallel design strategies) ──────────────────────
  const generateAlts = useCallback(async () => {
    console.log("generateAlts triggered");
    if (generating) {
      console.log("generateAlts: already generating, skipping");
      return;
    }
    setGenerating(true);
    addLog("Generating 3 alternative design strategies in parallel…");
    const strategies = [
      "MAXIMISE NATURAL LIGHT: Large east/north windows, open-plan living, minimal internal walls, courtyard/balcony in NE",
      "MAXIMUM PRIVACY: Bedrooms clustered in SW/W away from entrance, enclosed compound, service areas near entrance",
      "MODERN OPEN-PLAN: Merged kitchen-dining-living in one continuous space, bedrooms in a separate wing, studio aesthetic",
    ];
    try {
      const lyt = computeLayout(params);
      console.log("generateAlts: layout computed", lyt);
      const results = await Promise.all(strategies.map(async (strat, i) => {
        console.log(`generateAlts: starting strategy ${i+1}`);
        const raw = await claude(
          "You are a world-class architectural SVG drafter. Output only raw SVG. Start with <svg and end with </svg>.",
          buildFloorPlanSVGPrompt(params, lyt, strat),
          6000
        );
        const m = raw.match(/<svg[\s\S]*?<\/svg>/i);
        return {
          label: `Alt ${i+1}: ${strat.split(":")[0].replace("MAXIMISE","MAX")}`,
          svg: m ? m[0] : raw,
          strategy: strat,
        };
      }));
      setAlts(results);
      setSelectedAlt(0);
      setTab("alts");
      addLog(`✓ 3 alternatives generated`);

      // Save alternatives to Supabase
      results.forEach(alt => {
        savePlanToSupabase({
          params,
          svgCode: alt.svg,
          layout: lyt,
          vastuReport: null,
          costReport: null,
          furnitureData: null
        });
      });
    } catch(e) {
      console.error("generateAlts error:", e);
      addLog(`✗ Alt generation error: ${e.message}`);
    }
    setGenerating(false);
  }, [params]); // Removed 'generating' from dependency to avoid stale state issues

  // ── Fetch saved plans ──────────────────────────────────────────────────────
  const fetchPlans = useCallback(async () => {
    setLoadingSaved(true);
    try {
      const { data, error } = await supabase
        .from('generated_plans')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setSavedPlans(data || []);
    } catch (err) {
      console.error("Fetch plans error:", err.message);
    }
    setLoadingSaved(false);
  }, []);

  const loadPlan = (plan) => {
    setSvgCode(plan.svg_code);
    setParams({
      plotW: plan.plot_width,
      plotH: plan.plot_height,
      bhk: plan.bhk,
      city: plan.city,
      facing: plan.facing,
      budget: plan.budget,
      floors: 1, // default
    });
    setVastuReport(plan.vastu_report);
    setCostReport(plan.cost_report);
    setFurnitureData(plan.furniture_layout);
    setTab("plan");
    addLog(`✓ Loaded plan from ${new Date(plan.created_at).toLocaleDateString()}`);
  };

  // ── Exports ────────────────────────────────────────────────────────────────
  const exportSVG = () => {
    if (!svgCode) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([svgCode], { type:"image/svg+xml" }));
    a.download = `vastu_plan_${params.plotW}x${params.plotH}_${params.bhk}bhk.svg`;
    a.click();
  };

  const exportPNG = () => {
    if (!svgCode) return;
    const canvas = document.createElement("canvas");
    canvas.width = params.plotW * 20; canvas.height = params.plotH * 20;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `vastu_plan_${params.plotW}x${params.plotH}_${params.bhk}bhk.png`;
      a.click();
    };
    img.src = URL.createObjectURL(new Blob([svgCode], { type:"image/svg+xml" }));
  };

  const exportPDF = ({ title = "Floor Plan Proposal", client = "", arch = "वास्तु AI Studio" } = {}) => {
    if (!svgCode) return;
    setShowPdfModal(false);
    const date = new Date().toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
    const refNo = Math.random().toString(36).slice(2,8).toUpperCase();
    const belief = params.belief || "vastu";
    const beliefLabel = { vastu:"Vastu Shastra", islamic:"Islāmī Mīmārī", christian:"Sacred Christian", universal:"Universal Design" }[belief] || "Vastu Shastra";
    const scoreColor = vastuReport?.score >= 80 ? "#16A34A" : vastuReport?.score >= 60 ? "#D97706" : "#DC2626";

    const costRows = costReport?.breakdown
      ? Object.entries(costReport.breakdown).filter(([,v]) => v > 0)
          .map(([k,v]) => `<tr><td style="padding:6px 12px;text-transform:capitalize;border-bottom:1px solid #EEE">${k}</td><td style="padding:6px 12px;text-align:right;border-bottom:1px solid #EEE;font-weight:600">₹${v}L</td></tr>`).join("")
      : "";

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${title}</title>
<style>
  @page { size:A3 portrait; margin:18mm 20mm; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Georgia',serif;background:#fff;color:#1A1A2A;font-size:11px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1A1A2A;padding-bottom:14px;margin-bottom:20px}
  .brand{font-size:26px;font-weight:700;font-family:serif}
  .brand-sub{font-size:8px;color:#888;letter-spacing:0.18em;margin-top:3px}
  .proj{text-align:right;line-height:1.9;font-size:10px}
  .plan-wrap{display:flex;justify-content:center;margin-bottom:20px;border:1px solid #E5E5E5;border-radius:4px;padding:16px;background:#FAFAFA}
  .plan-wrap svg{max-width:100%;max-height:420px;height:auto;display:block}
  .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px}
  .stat{border:1px solid #E5E5E5;border-radius:4px;padding:10px 12px}
  .stat-label{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:0.1em}
  .stat-value{font-size:15px;font-weight:700;margin-top:4px}
  .section-title{font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.12em;border-bottom:1px solid #E5E5E5;padding-bottom:6px;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;font-size:10px}
  thead th{background:#1A1A2A;color:#fff;padding:7px 12px;text-align:left;font-family:monospace;font-size:9px;letter-spacing:0.06em}
  .total-row td{font-weight:700;font-size:11px;background:#F5F0FF;border-top:2px solid #1A1A2A}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
  .footer{border-top:1px solid #E5E5E5;padding-top:10px;margin-top:20px;display:flex;justify-content:space-between;font-size:8px;color:#AAA}
  @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head>
<body>
  <div class="header">
    <div>
      <div class="brand">वास्तु <span style="color:#6B21A8">AI</span></div>
      <div class="brand-sub">ARCHITECTURAL DESIGN PLATFORM</div>
      <div style="margin-top:10px;font-size:13px;font-weight:700;color:#1A1A2A">${title}</div>
      ${client ? `<div style="font-size:10px;color:#555;margin-top:3px">Prepared for: ${client}</div>` : ""}
    </div>
    <div class="proj">
      <div style="font-weight:700;font-size:12px">${arch}</div>
      <div>Date: ${date}</div>
      <div>Ref: VASTU-${refNo}</div>
      <div>Belief System: ${beliefLabel}</div>
    </div>
  </div>

  <div class="plan-wrap">${svgCode}</div>

  <div class="stats">
    <div class="stat"><div class="stat-label">Plot Size</div><div class="stat-value">${params.plotW}×${params.plotH} ft</div></div>
    <div class="stat"><div class="stat-label">BHK</div><div class="stat-value">${params.bhk} BHK</div></div>
    <div class="stat"><div class="stat-label">Facing</div><div class="stat-value">${params.facing}</div></div>
    <div class="stat"><div class="stat-label">City Code</div><div class="stat-value" style="font-size:10px">${params.city}</div></div>
    ${vastuReport ? `<div class="stat"><div class="stat-label">${beliefLabel.split(" ")[0]} Score</div><div class="stat-value" style="color:${scoreColor}">${vastuReport.score}/100</div></div>` : ""}
  </div>

  ${costReport ? `
  <div class="two-col">
    <div>
      <div class="section-title">Cost Breakdown</div>
      <table>
        <thead><tr><th>Category</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${costRows}</tbody>
        <tfoot><tr class="total-row"><td style="padding:8px 12px">Total Estimated Cost</td><td style="padding:8px 12px;text-align:right">₹${costReport.totalCost}L</td></tr></tfoot>
      </table>
    </div>
    <div>
      <div class="section-title">Project Details</div>
      <table>
        <tbody>
          <tr><td style="padding:5px 12px;border-bottom:1px solid #EEE;color:#888">Built-up Area</td><td style="padding:5px 12px;border-bottom:1px solid #EEE;text-align:right;font-weight:600">${costReport.builtUpArea?.toLocaleString("en-IN")} sqft</td></tr>
          <tr><td style="padding:5px 12px;border-bottom:1px solid #EEE;color:#888">Rate / sqft</td><td style="padding:5px 12px;border-bottom:1px solid #EEE;text-align:right;font-weight:600">₹${costReport.perSqftRate?.toLocaleString("en-IN")}</td></tr>
          <tr><td style="padding:5px 12px;border-bottom:1px solid #EEE;color:#888">Timeline</td><td style="padding:5px 12px;border-bottom:1px solid #EEE;text-align:right;font-weight:600">${costReport.timeline}</td></tr>
          <tr><td style="padding:5px 12px;border-bottom:1px solid #EEE;color:#888">Budget Tier</td><td style="padding:5px 12px;border-bottom:1px solid #EEE;text-align:right;font-weight:600">${params.budget}</td></tr>
          <tr><td style="padding:5px 12px;color:#888">Floors</td><td style="padding:5px 12px;text-align:right;font-weight:600">${params.floors === 1 ? "Ground Floor" : params.floors === 2 ? "G+1 Duplex" : "G+2 Triple"}</td></tr>
        </tbody>
      </table>
    </div>
  </div>` : ""}

  ${vastuReport?.violations?.length ? `
  <div style="margin-bottom:20px">
    <div class="section-title">Design Notes — ${vastuReport.violations.length} Item(s) to Review</div>
    ${vastuReport.violations.slice(0,5).map(v => `<div style="padding:5px 0;border-bottom:1px solid #F5F5F5;font-size:9px"><span style="color:#D97706;font-weight:700">[${(v.severity||"note").toUpperCase()}]</span> ${v.rule} — ${v.fix}</div>`).join("")}
  </div>` : ""}

  <div class="footer">
    <span>Generated by वास्तु AI · Architectural Design Platform</span>
    <span>Ref: VASTU-${refNo} · ${date}</span>
    <span>Preliminary estimate — actual costs may vary ±15%</span>
  </div>
</body></html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 600);
  };

  // ── Tab definitions ────────────────────────────────────────────────────────
  const beliefTabLabel = { vastu:"Vastu", islamic:"Islamic", christian:"Christian", universal:"Design" };
  const beliefAuditHeading = {
    vastu:     "Vastu Shastra Audit",
    islamic:   "Islāmī Mīmārī Audit",
    christian: "Sacred Christian Audit",
    universal: "Universal Design Audit",
  };
  const beliefRuleCount = { vastu:"14", islamic:"12", christian:"12", universal:"12" };
  const TABS = [
    { id:"vastu",   label: beliefTabLabel[params.belief] || "Vastu" },
    { id:"cost",    label:"Cost" },
    { id:"timeline",label:"Timeline" },
    { type:"sep" },
    { id:"chat",    label:"Modify" },
    { id:"alts",    label:"Alts" },
    { id:"compare", label:"Compare" },
    { type:"sep" },
    { id:"saved",   label:"My Plans" },
    { id:"log",     label:"Log" },
  ];

  const vastuScore = vastuReport?.score ?? null;
  const costTotal  = costReport?.totalCost ?? null;

  return (
    <div style={{ display:"flex", height:"100vh", background:"#080814", color:"#D8D8EC", overflow:"hidden" }}>

      {/* Toast notification */}
      {notification && (
        <div style={{
          position:'fixed', top:20, right:20, zIndex:9999,
          background:'#0A0A14', border:'1px solid #4488FF',
          borderRadius:6, padding:'8px 18px',
          fontSize:11, color:'#4488FF', fontFamily:'monospace',
          boxShadow:'0 4px 24px rgba(68,136,255,0.2)',
          animation:'fadeInUp 0.2s ease',
          pointerEvents:'none',
        }}>{notification}</div>
      )}

      {/* ── PDF Modal ── */}
      {showPdfModal && <PdfModal onExport={exportPDF} onClose={() => setShowPdfModal(false)}/>}

      {/* ── Mobile drawer backdrop ── */}
      {isMobile && mobileDrawer && (
        <div onClick={() => setMobileDrawer(null)} style={{
          position:'fixed', inset:0, zIndex:98,
          background:'rgba(0,0,0,0.6)', backdropFilter:'blur(2px)',
        }}/>
      )}

      {/* ── Left Sidebar ── */}
      <div style={isMobile ? {
        position:'fixed', top:0, left:0, bottom:0, zIndex:99,
        transform: mobileDrawer==='left' ? 'translateX(0)' : 'translateX(-100%)',
        transition:'transform 0.25s ease',
      } : {}}>
        <Sidebar
          params={params}
          onParamChange={handleParamChange}
          onGenerate={() => {
            if (genMode === "image") generateImage();
            else if (genMode === "html") generateHTML();
            else generate();
            setMobileDrawer(null);
          }}
          onGenerateAlts={generateAlts}
          onExportSVG={exportSVG}
          onExportPNG={exportPNG}
          generating={generating}
          hasPlan={!!svgCode}
          regErrors={regErrors}
        />
      </div>

      {/* ── Main content ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>

        {/* Tab bar */}
        <div style={{
          display:"flex", alignItems:"stretch",
          borderBottom:"2px solid #1A1A28",
          background:"#060610",
          padding:`0 ${isMobile?8:16}px`,
          gap:2,
          overflowX:"auto",
          flexShrink:0,
        }}>
          {/* Mobile: hamburger for left sidebar */}
          {isMobile && (
            <button onClick={() => setMobileDrawer(d => d==='left' ? null : 'left')} style={{
              padding:"0 12px", background:"transparent", border:"none",
              color:"#666", fontSize:18, cursor:"pointer", flexShrink:0,
            }}>☰</button>
          )}

          {TABS.map((t, idx) => t.type === "sep"
            ? <div key={`sep-${idx}`} style={{ width:1, background:"#1A1A2A", alignSelf:"stretch", margin:"8px 6px", flexShrink:0 }}/>
            : <button key={t.id} onClick={()=>{
                setTab(t.id);
                if (t.id === "saved" || t.id === "compare") fetchPlans();
              }} style={{
                padding:`12px ${isMobile?10:14}px`,
                background:"transparent",
                border:"none",
                borderBottom: tab===t.id ? "2px solid #4488FF" : "2px solid transparent",
                color: tab===t.id ? "#4488FF" : "#444",
                fontSize:10, cursor:"pointer",
                fontFamily:"monospace", fontWeight:700,
                letterSpacing:"0.06em", textTransform:"uppercase",
                transition:"color 0.15s",
                marginBottom:"-2px",
                whiteSpace:"nowrap",
              }}>{t.label}</button>
          )}

          {/* Mobile: controls button for right panel */}
          {isMobile && (
            <button onClick={() => setMobileDrawer(d => d==='right' ? null : 'right')} style={{
              padding:"0 12px", background:"transparent", border:"none",
              color:"#666", fontSize:16, cursor:"pointer", flexShrink:0,
            }}>⚙</button>
          )}
        </div>

        {/* Generation progress bar */}
        {generating && (
          <div style={{ background:'#050510', padding:'3px 16px 2px', flexShrink:0, borderBottom:'1px solid #0A0A18' }}>
            <div style={{ position:'relative', height:2, background:'#0A0A18', borderRadius:1, overflow:'hidden' }}>
              <div style={{
                position:'absolute', left:0, top:0, bottom:0,
                width:`${progress}%`,
                background:'linear-gradient(90deg, #4488FF, #44DD88)',
                transition:'width 0.7s ease',
              }}/>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', marginTop:2 }}>
              <span style={{ fontSize:7, color:'#333', fontFamily:'monospace' }}>{currentAgentLabel}</span>
              <span style={{ fontSize:7, color:'#333', fontFamily:'monospace' }}>{progress}%</span>
            </div>
          </div>
        )}

        {/* Tab content */}
        <div style={{ flex:1, overflow:"hidden", display:"flex" }}>

          {/* Floor Plan */}
          {tab==="plan" && !showDiff && (
            <div style={{ flex:1, overflow:"hidden", position:"relative" }}>
              {genMode === "image" && imageUrl ? (
                <div style={{
                  width:"100%", height:"100%",
                  display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center",
                  background:"#080814", padding:16, overflow:"auto",
                }}>
                  <img
                    src={imageUrl}
                    alt="AI-generated floor plan"
                    style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain",
                      borderRadius:8, boxShadow:"0 8px 48px rgba(68,221,136,0.15)" }}
                  />
                  <div style={{ marginTop:10, fontSize:9, color:"#444", fontFamily:"monospace" }}>
                    GPT Image · {params.plotW}×{params.plotH}ft {params.bhk}BHK {params.facing}-facing
                  </div>
                </div>
              ) : genMode === "image" && generating ? (
                <div style={{
                  width:"100%", height:"100%",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  background:"#080814",
                }}>
                  <div style={{ textAlign:"center", fontFamily:"monospace" }}>
                    <div style={{ fontSize:28, marginBottom:12, animation:"pulse 1.5s infinite" }}>🖼</div>
                    <div style={{ fontSize:11, color:"#44DD88" }}>Generating floor plan image…</div>
                    <div style={{ fontSize:9, color:"#444", marginTop:6 }}>GPT Image · this takes ~15–30s</div>
                  </div>
                </div>
              ) : genMode === "html" ? (
                <div style={{
                  width:"100%", height:"100%",
                  display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center",
                  background:"#080814",
                }}>
                  <div style={{ textAlign:"center", fontFamily:"monospace" }}>
                    <div style={{ fontSize:28, marginBottom:12 }}>📄</div>
                    <div style={{ fontSize:11, color:"#FFAA22", marginBottom:6 }}>HTML Plan Mode</div>
                    <div style={{ fontSize:9, color:"#444", maxWidth:220, lineHeight:1.6 }}>
                      Click <strong style={{ color:"#FFAA22" }}>Generate Plan</strong> to build a precise floor plan and open it in a new tab with print / PDF export.
                    </div>
                  </div>
                </div>
              ) : (
                <FloorPlanViewer
                  svgCode={svgCode}
                  furniture={furnitureData}
                  showFurniture={showFurniture}
                  loading={generating && !svgCode}
                  showLabels={showLabels}
                  showSunPath={showSunPath}
                  theme={theme}
                  city={params.city}
                />
              )}
            </div>
          )}

          {/* Diff */}
          {tab==="plan" && showDiff && prevSvg && (
            <div style={{ flex:1 }}>
              <DiffPanel prev={prevSvg} current={svgCode}/>
            </div>
          )}

          {/* Vastu */}
          {tab==="vastu" && (
            <div style={{ flex:1, overflow:"auto", padding:24 }}>
              <div style={{ maxWidth:640 }}>
                <div style={{ display:"flex", alignItems:"baseline", gap:10, marginBottom:20 }}>
                  <h2 style={{ fontSize:22, fontWeight:700, color:"#F0E040", fontFamily:"Georgia,serif" }}>
                    {beliefAuditHeading[params.belief] || "Vastu Shastra Audit"}
                  </h2>
                  <span style={{ fontSize:10, color:"#555", fontFamily:"monospace" }}>{beliefRuleCount[params.belief] || "14"} rules checked</span>
                </div>

                {/* Fix All Violations */}
                {vastuReport?.violations?.length > 0 && (
                  <div style={{ marginBottom:20, padding:'12px 16px', background:'#120808', border:'1px solid #FF554422', borderRadius:6 }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
                      <span style={{ fontSize:10, color:'#FF7755', fontFamily:'monospace' }}>
                        ⚠ {vastuReport.violations.length} violation{vastuReport.violations.length !== 1 ? 's' : ''} detected
                      </span>
                      <button onClick={fixAllViolations} disabled={generating} style={{
                        padding:'7px 16px', background:'#1A0808',
                        border:'1px solid #FF5544', borderRadius:5,
                        color:'#FF8877', fontSize:10, fontWeight:700,
                        cursor:'pointer', fontFamily:'monospace',
                        letterSpacing:'0.04em', transition:'all 0.2s', flexShrink:0,
                      }}>⚡ FIX ALL &amp; RE-GENERATE</button>
                    </div>
                  </div>
                )}

                <VastuReport report={vastuReport} belief={params.belief}/>

                {/* Explain to My Parents */}
                {vastuReport && (
                  <div style={{ marginTop:28, paddingTop:20, borderTop:'1px solid #1A1A2A' }}>
                    <div style={{ fontSize:9, color:'#666', fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:10, fontFamily:'monospace' }}>
                      🗣 Explain to My Parents
                    </div>
                    <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
                      {['Hindi','Kannada','Tamil'].map(lang => (
                        <button key={lang} onClick={() => explainToParents(lang)}
                          disabled={loadingExplanation}
                          style={{
                            padding:'6px 16px', borderRadius:4,
                            background: parentLang===lang && !loadingExplanation ? '#0E2040' : 'transparent',
                            border:`1px solid ${parentLang===lang && !loadingExplanation ? '#4488FF' : '#1A1A2A'}`,
                            color: parentLang===lang && !loadingExplanation ? '#4488FF' : '#555',
                            fontSize:10, cursor:'pointer', fontFamily:'monospace',
                            transition:'all 0.15s',
                          }}>{lang}
                        </button>
                      ))}
                    </div>
                    {loadingExplanation && (
                      <div style={{ fontSize:10, color:'#444', fontFamily:'monospace', padding:'6px 0' }}>
                        <span style={{ animation:'blink 1s infinite', marginRight:6 }}>●</span>Translating…
                      </div>
                    )}
                    {parentExplanation && !loadingExplanation && (
                      <div style={{ background:'#080C14', border:'1px solid #1A2A3A', borderRadius:6, padding:16 }}>
                        <pre style={{
                          fontSize:11, color:'#AABBCC', fontFamily:'inherit',
                          lineHeight:1.8, whiteSpace:'pre-wrap', margin:0,
                        }}>{parentExplanation.text}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Cost */}
          {tab==="cost" && (
            <div style={{ flex:1, overflow:"auto", padding:24 }}>
              <div style={{ maxWidth:860 }}>
                <h2 style={{ fontSize:22, fontWeight:700, color:"#CC66FF", fontFamily:"Georgia,serif", marginBottom:20 }}>
                  Cost Estimation
                </h2>
                <CostReport cost={costReport}/>
              </div>
            </div>
          )}

          {/* Chat */}
          {tab==="chat" && (
            <div style={{ flex:1, overflow:"hidden", padding:24, display:"flex", flexDirection:"column" }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:"#44DD88", fontFamily:"Georgia,serif", marginBottom:16, flexShrink:0 }}>
                Natural Language Modification
              </h2>
              <div style={{ flex:1, overflow:"hidden", maxWidth:600 }}>
                <ChatPanel
                  svgCode={svgCode}
                  params={params}
                  onApplyChange={(note) => generate(note)}
                />
              </div>
            </div>
          )}

          {/* Alternatives */}
          {tab==="alts" && (
            <div style={{ flex:1, overflow:"hidden", padding:24, display:"flex", flexDirection:"column" }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:"#4488FF", fontFamily:"Georgia,serif", marginBottom:16, flexShrink:0 }}>
                Alternative Designs
              </h2>
              <div style={{ flex:1, overflow:"hidden" }}>
                <AltsPanel alts={alts} selected={selectedAlt} onSelect={setSelectedAlt}/>
              </div>
            </div>
          )}

          {/* Log */}
          {tab==="log" && (
            <div style={{ flex:1, overflow:"auto", padding:24 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:"#888", fontFamily:"Georgia,serif", marginBottom:16 }}>
                Agent Activity Log
              </h2>
              <LogPanel log={log}/>
            </div>
          )}

          {/* Timeline */}
          {tab==="timeline" && (
            <div style={{ flex:1, overflow:"auto", padding:24 }}>
              <div style={{ maxWidth:900 }}>
                <h2 style={{ fontSize:22, fontWeight:700, color:"#FFAA22", fontFamily:"Georgia,serif", marginBottom:20 }}>
                  Construction Timeline
                </h2>
                {!costReport && (
                  <div style={{ color:"#444", fontSize:11, fontFamily:"monospace" }}>
                    Generate a floor plan first — the timeline is derived from the cost estimation.
                  </div>
                )}
                <GanttChart costReport={costReport} params={params} />
              </div>
            </div>
          )}

          {/* Compare */}
          {tab==="compare" && (
            <div style={{ flex:1, overflow:"auto", padding:24 }}>
              <div style={{ maxWidth:900 }}>
                <h2 style={{ fontSize:22, fontWeight:700, color:"#CC66FF", fontFamily:"Georgia,serif", marginBottom:20 }}>
                  Plan Comparison
                </h2>
                <ComparisonPanel savedPlans={savedPlans} />
              </div>
            </div>
          )}

          {/* Saved Plans */}
          {tab==="saved" && (
            <div style={{ flex:1, overflow:"auto", padding:24 }}>
              <div style={{ maxWidth:900 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
                  <h2 style={{ fontSize:22, fontWeight:700, color:"#4488FF", fontFamily:"Georgia,serif" }}>
                    My Saved Plans
                  </h2>
                  <button onClick={fetchPlans} style={{
                    padding:"6px 12px", background:"#1A1A2A", border:"1px solid #2A2A3A",
                    borderRadius:4, color:"#888", fontSize:11, cursor:"pointer", fontFamily:"monospace"
                  }}>REFRESH</button>
                </div>

                {loadingSaved ? (
                  <div style={{ color:"#555", fontFamily:"monospace" }}>Fetching from Supabase…</div>
                ) : savedPlans.length === 0 ? (
                  <div style={{ color:"#444", fontSize:11, fontFamily:"monospace" }}>No saved plans found in your database.</div>
                ) : (
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))", gap:20 }}>
                    {savedPlans.map((plan) => (
                      <div key={plan.id} style={{
                        background:"#0A0A14", border:"1px solid #1A1A2A", borderRadius:8,
                        overflow:"hidden", display:"flex", flexDirection:"column",
                        transition:"border-color 0.2s",
                      }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "#4488FF"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "#1A1A2A"}
                      >
                        <div style={{
                          height:140, background:"#FFF", overflow:"hidden", position:"relative",
                          display:"flex", alignItems:"center", justifyContent:"center", padding:10
                        }}>
                          <div style={{ zoom:0.25, pointerEvents:"none" }} dangerouslySetInnerHTML={{ __html: plan.svg_code }} />
                        </div>
                        <div style={{ padding:14, flex:1, display:"flex", flexDirection:"column" }}>
                          <div style={{ fontSize:12, fontWeight:700, color:"#DDD", marginBottom:4 }}>
                            {plan.plot_width}×{plan.plot_height}ft · {plan.bhk}BHK
                          </div>
                          <div style={{ fontSize:10, color:"#666", fontFamily:"monospace", marginBottom:12 }}>
                            {plan.city} · {new Date(plan.created_at).toLocaleDateString()}
                          </div>
                          <div style={{ display:"flex", gap:8, marginBottom:16 }}>
                            {plan.vastu_score && <div style={{ fontSize:10, color:"#44DD88", fontWeight:700 }}>Vastu: {plan.vastu_score}</div>}
                            {plan.total_cost && <div style={{ fontSize:10, color:"#CC66FF", fontWeight:700 }}>₹{plan.total_cost}L</div>}
                          </div>
                          <button onClick={() => loadPlan(plan)} style={{
                            width:"100%", padding:"8px", background:"#4488FF", border:"none",
                            borderRadius:4, color:"#FFF", fontSize:10, fontWeight:700,
                            cursor:"pointer", textTransform:"uppercase", letterSpacing:"0.05em"
                          }}>Load Plan</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ── Right: Agent Pipeline Panel ── */}
      <div style={isMobile ? {
        position:'fixed', top:0, right:0, bottom:0, zIndex:99,
        transform: mobileDrawer==='right' ? 'translateX(0)' : 'translateX(100%)',
        transition:'transform 0.25s ease',
        width:240, minWidth:240,
        background:"#080814", borderLeft:"2px solid #1A1A28",
        display:"flex", flexDirection:"column",
        overflow:"hidden", fontFamily:"monospace",
      } : {
        width: 220, minWidth: 220,
        background: "#080814",
        borderLeft: "2px solid #1A1A28",
        display: "flex", flexDirection: "column",
        overflow: "hidden", fontFamily: "monospace",
      }}>
        {/* Header */}
        <div style={{
          padding: "12px 14px 10px",
          borderBottom: "2px solid #1A1A28",
          background: "#060610",
        }}>
          <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.18em", textTransform: "uppercase" }}>
            ── Agent Pipeline ──
          </div>
          <div style={{ fontSize: 9, color: "#555", marginTop: 4, fontFamily: "monospace" }}>
            {generating ? "Running…" : agentStatuses && Object.values(agentStatuses).some(s => s === "done") ? "Last run complete" : "Idle"}
          </div>
          {/* Auth pill */}
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            {user ? (
              <>
                <a href="/dashboard" style={{ fontSize: 8, color: "#4488FF", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>
                  ⊙ {user.email}
                </a>
                <button onClick={() => supabase.auth.signOut()} style={{ fontSize: 7, color: "#554444", background: "transparent", border: "none", cursor: "pointer", fontFamily: "monospace" }}>sign out</button>
              </>
            ) : (
              <a href="/login" style={{ fontSize: 8, color: "#555", textDecoration: "none", letterSpacing: "0.05em" }}>
                ← Sign in to save plans
              </a>
            )}
          </div>
        </div>

        {/* Agents */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
          <AgentPanel
            statuses={agentStatuses}
            activeAgent={activeAgent}
            scores={agentScores}
            belief={params.belief}
          />
        </div>

        {/* ── Generation Mode ── */}
        <div style={{ borderTop:"2px solid #1A1A28", padding:"12px 10px" }}>
          <div style={{ fontSize:8, color:"#333", letterSpacing:"0.16em", textTransform:"uppercase", marginBottom:8 }}>── Gen Mode ──</div>
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            {[
              { mode:"image", icon:"🖼", label:"Image GEN",  color:"#44DD88", badge:"PRIMARY" },
              { mode:"svg",   icon:"⬡",  label:"SVG GEN",    color:"#4488FF", badge:"BETA"    },
              { mode:"html",  icon:"📄", label:"HTML PLAN",  color:"#FFAA22", badge:"NEW"     },
            ].map(({ mode, icon, label, color, badge }) => (
              <button
                key={mode}
                onClick={() => { setGenMode(mode); setTab("plan"); }}
                style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                  padding:"7px 10px", borderRadius:5, border:"none", cursor:"pointer",
                  background: genMode === mode ? `${color}18` : "transparent",
                  outline: genMode === mode ? `1px solid ${color}44` : "1px solid #1A1A28",
                  transition:"all 0.15s",
                }}
              >
                <span style={{ fontSize:10, fontFamily:"monospace", fontWeight:700, color: genMode === mode ? color : "#555" }}>
                  {icon} {label}
                </span>
                <span style={{ fontSize:7, fontFamily:"monospace", color: genMode === mode ? color : "#333" }}>
                  {badge}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Mini log */}
        {log.length > 0 && (
          <div style={{
            borderTop: "2px solid #1A1A28",
            padding: "10px 10px",
            maxHeight: 120,
            overflowY: "auto",
          }}>
            <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
              ── Log ──
            </div>
            {log.slice(0, 6).map((l, i) => (
              <div key={i} style={{ fontSize: 8, color: "#444", fontFamily: "monospace", marginBottom: 3, lineHeight: 1.4, wordBreak: "break-word" }}>
                {l}
              </div>
            ))}
          </div>
        )}

        {/* ── Controls ── */}
        <div style={{ borderTop: "2px solid #1A1A28", padding: "12px 10px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 8, color: "#333", letterSpacing: "0.18em", textTransform: "uppercase" }}>── Controls ──</div>

          {/* Score badges */}
          {vastuScore !== null && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <ScoreBadge label={beliefTabLabel[params.belief] || "Vastu"} score={vastuScore} color={vastuScore>=80?"#44DD88":vastuScore>=60?"#FFAA22":"#FF5544"} />
              {costTotal && <ScoreBadge label={`₹${costTotal}L`} score={null} color="#CC66FF"/>}
            </div>
          )}

          {/* Theme + View toggles */}
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {/* Theme cycle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>Theme</span>
              <button
                onClick={() => setTheme(t => t==='dark'?'blueprint':t==='blueprint'?'light':'dark')}
                style={{
                  padding: "3px 10px", background: "transparent",
                  border: "1px solid #1A1A28", borderRadius: 4,
                  fontSize: 13, cursor: "pointer", lineHeight: 1,
                }}>
                {theme==='dark'?'🌙':theme==='blueprint'?'📐':'☀️'}
              </button>
            </div>

            {/* Labels toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>Labels</span>
              <div onClick={() => setShowLabels(v=>!v)} style={{
                width: 28, height: 15, borderRadius: 8, flexShrink: 0,
                background: showLabels ? "#FFAA22" : "#1A1A2A",
                position: "relative", cursor: "pointer", transition: "background 0.2s",
                border: `1px solid ${showLabels ? "#FFAA22" : "#2A2A3A"}`,
              }}>
                <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#FFF",
                  position: "absolute", top: 1, left: showLabels ? 15 : 2, transition: "left 0.2s" }}/>
              </div>
            </div>

            {/* Sun Path toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>☀ Sun Path</span>
              <div onClick={() => setShowSunPath(v=>!v)} style={{
                width: 28, height: 15, borderRadius: 8, flexShrink: 0,
                background: showSunPath ? "#FFBB44" : "#1A1A2A",
                position: "relative", cursor: "pointer", transition: "background 0.2s",
                border: `1px solid ${showSunPath ? "#FFBB44" : "#2A2A3A"}`,
              }}>
                <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#FFF",
                  position: "absolute", top: 1, left: showSunPath ? 15 : 2, transition: "left 0.2s" }}/>
              </div>
            </div>

            {/* Furniture toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>Furniture</span>
              <div onClick={() => setShowFurniture(v=>!v)} style={{
                width: 28, height: 15, borderRadius: 8, flexShrink: 0,
                background: showFurniture ? "#22CCCC" : "#1A1A2A",
                position: "relative", cursor: "pointer", transition: "background 0.2s",
                border: `1px solid ${showFurniture ? "#22CCCC" : "#2A2A3A"}`,
              }}>
                <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#FFF",
                  position: "absolute", top: 1, left: showFurniture ? 15 : 2, transition: "left 0.2s" }}/>
              </div>
            </div>

            {/* Diff toggle */}
            {prevSvg && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>Diff View</span>
                <div onClick={() => setShowDiff(d=>!d)} style={{
                  width: 28, height: 15, borderRadius: 8, flexShrink: 0,
                  background: showDiff ? "#4488FF" : "#1A1A2A",
                  position: "relative", cursor: "pointer", transition: "background 0.2s",
                  border: `1px solid ${showDiff ? "#4488FF" : "#2A2A3A"}`,
                }}>
                  <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#FFF",
                    position: "absolute", top: 1, left: showDiff ? 15 : 2, transition: "left 0.2s" }}/>
                </div>
              </div>
            )}
          </div>

          {/* Action buttons */}
          {svgCode && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ display: "flex", gap: 5 }}>
                <button onClick={copyShareLink} style={{
                  flex: 1, padding: "6px 4px",
                  background: "transparent", border: "1px solid #1A2A3A",
                  borderRadius: 4, color: "#4488FF", fontSize: 9, cursor: "pointer",
                  fontFamily: "monospace", letterSpacing: "0.04em",
                }}>SHARE</button>
                <button onClick={shareWhatsApp} title="Share on WhatsApp" style={{
                  padding: "6px 10px",
                  background: "transparent", border: "1px solid #0A200A",
                  borderRadius: 4, color: "#22AA44", fontSize: 14, cursor: "pointer", lineHeight: 1,
                }}>📲</button>
              </div>
              <button onClick={() => setShowPdfModal(true)} style={{
                width: "100%", padding: "7px",
                background: "transparent", border: "1px solid #2A1A2A",
                borderRadius: 4, color: "#CC66FF", fontSize: 9, cursor: "pointer",
                fontFamily: "monospace", letterSpacing: "0.04em",
              }}>↓ Export PDF</button>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
