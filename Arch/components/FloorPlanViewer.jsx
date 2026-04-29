"use client";
import { useRef, useState, useCallback, useEffect } from "react";
import * as d3 from "d3";
import { ROOM_COLORS } from "../lib/layoutEngine";

const CITY_LAT = {
  'BBMP (Bengaluru)': 12.97,
  'BMC (Mumbai)': 18.98,
  'MCD (Delhi)': 28.61,
  'GHMC (Hyderabad)': 17.38,
  'CMDA (Chennai)': 13.08,
  'PMC (Pune)': 18.52,
  'NBC (Generic)': 20,
};

export default function FloorPlanViewer({
  svgCode, furniture, showFurniture, loading,
  showLabels = true, showSunPath = false, theme = 'dark', city = '',
  layout = null, params = {}
}) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // ── D3 Rendering Logic ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!layout || !svgRef.current) return;

    const { rooms, W, H, bldX, bldY, bldW, bldH, OUTER, entrance } = layout;
    const PAD = 24;
    const totalW = W + PAD * 2;
    const totalH = H + PAD * 2;

    const svg = d3.select(svgRef.current)
      .attr("viewBox", `0 0 ${totalW} ${totalH}`)
      .attr("width", "100%")
      .attr("height", "100%");

    // Clear previous
    svg.selectAll("*").remove();

    // 1. Background
    svg.append("rect")
      .attr("width", totalW)
      .attr("height", totalH)
      .attr("fill", theme === 'dark' ? "#080814" : "#F8F8F4");

    // 2. Plot Area
    svg.append("rect")
      .attr("x", PAD)
      .attr("y", PAD)
      .attr("width", W)
      .attr("height", H)
      .attr("fill", theme === 'dark' ? "#101020" : "#F5F5F0")
      .attr("stroke", theme === 'dark' ? "#2A2A3E" : "#333")
      .attr("stroke-width", 2);

    // 3. Building Envelope
    svg.append("rect")
      .attr("x", bldX + PAD)
      .attr("y", bldY + PAD)
      .attr("width", bldW)
      .attr("height", bldH)
      .attr("fill", "none")
      .attr("stroke", theme === 'dark' ? "#4488FF44" : "#999")
      .attr("stroke-width", OUTER)
      .attr("stroke-dasharray", "4 2");

    // 4. Rooms
    const roomGroups = svg.selectAll(".room")
      .data(rooms)
      .join("g")
      .attr("class", "room");

    roomGroups.append("rect")
      .attr("x", d => d.x + PAD)
      .attr("y", d => d.y + PAD)
      .attr("width", d => d.w)
      .attr("height", d => d.h)
      .attr("fill", d => theme === 'dark' ? d3.color(ROOM_COLORS[d.name] || "#D0D0C8").darker(0.8) : (ROOM_COLORS[d.name] || "#D0D0C8"))
      .attr("stroke", theme === 'dark' ? "#1A1A2A" : "#FFF")
      .attr("stroke-width", 1.5)
      .attr("rx", 1);

    // 5. Room Labels
    if (showLabels) {
      roomGroups.each(function(d) {
        const g = d3.select(this);
        const fs = Math.max(6, Math.min(10, Math.min(d.w, d.h) / 5));
        if (d.w < 20 || d.h < 15) return;

        g.append("text")
          .attr("x", d.x + d.w / 2 + PAD)
          .attr("y", d.y + d.h / 2 + PAD - 2)
          .attr("text-anchor", "middle")
          .attr("font-size", fs)
          .attr("font-family", "monospace")
          .attr("font-weight", 700)
          .attr("fill", theme === 'dark' ? "#888" : "#1A1A1A")
          .text(d.name.toUpperCase());

        g.append("text")
          .attr("x", d.x + d.w / 2 + PAD)
          .attr("y", d.y + d.h / 2 + PAD + fs)
          .attr("text-anchor", "middle")
          .attr("font-size", fs * 0.8)
          .attr("font-family", "monospace")
          .attr("fill", theme === 'dark' ? "#444" : "#666")
          .text(`${d.ftW}×${d.ftH}ft`);
      });
    }

    // 6. Doors (D3 Arcs)
    // We assume each room has a door at a generic location for now
    // In a real app, doors would be part of the layout data
    const arcGenerator = d3.arc()
      .innerRadius(0)
      .outerRadius(8)
      .startAngle(0)
      .endAngle(Math.PI / 2);

    roomGroups.filter(d => d.name !== "Corridor" && d.name !== "Utility")
      .append("path")
      .attr("d", arcGenerator)
      .attr("transform", d => `translate(${d.x + PAD + 2}, ${d.y + PAD + 2})`)
      .attr("fill", "none")
      .attr("stroke", theme === 'dark' ? "#4488FF88" : "#666")
      .attr("stroke-width", 1);

    // 7. Windows
    roomGroups.filter(d => d.w > 30)
      .append("rect")
      .attr("x", d => d.x + d.w / 2 - 8 + PAD)
      .attr("y", d => d.y + PAD - 1)
      .attr("width", 16)
      .attr("height", 2)
      .attr("fill", "#4488FF")
      .attr("opacity", 0.6);

    // 8. Furniture (if data-driven)
    if (showFurniture && furniture?.placements) {
      const furn = svg.append("g").attr("class", "furniture-layer");
      furniture.placements.forEach(room => {
        (room.items || []).forEach(item => {
          const g = furn.append("g")
            .attr("transform", `rotate(${item.rotation || 0}, ${item.x + PAD + item.w / 2}, ${item.y + PAD + item.h / 2})`);
          
          g.append("rect")
            .attr("x", item.x + PAD)
            .attr("y", item.y + PAD)
            .attr("width", item.w)
            .attr("height", item.h)
            .attr("fill", item.color || "#C8B090")
            .attr("stroke", "#2A1A0A")
            .attr("stroke-width", 0.5)
            .attr("opacity", 0.8)
            .attr("rx", 1);

          if (item.w > 15) {
            g.append("text")
              .attr("x", item.x + PAD + item.w / 2)
              .attr("y", item.y + PAD + item.h / 2 + 2)
              .attr("font-size", 4)
              .attr("text-anchor", "middle")
              .attr("fill", "#1A1A1A")
              .attr("font-family", "monospace")
              .text(item.name);
          }
        });
      });
    }

    // 9. North Arrow
    const ax = totalW - 28, ay = 28;
    const arrow = svg.append("g").attr("class", "north-arrow");
    arrow.append("circle").attr("cx", ax).attr("cy", ay).attr("r", 18).attr("fill", "#00000066").attr("stroke", "#4488FF44");
    arrow.append("polygon").attr("points", `${ax},${ay - 14} ${ax + 5},${ay + 6} ${ax},${ay + 2} ${ax - 5},${ay + 6}`).attr("fill", "#4488FF");
    arrow.append("text").attr("x", ax).attr("y", ay + 16).attr("text-anchor", "middle").attr("font-size", 8).attr("fill", "#4488FF").attr("font-family", "monospace").text("N");

    // 10. Sun Path (if enabled)
    if (showSunPath) {
      const lat = CITY_LAT[city] || 20;
      const sunG = svg.append("g").attr("class", "sun-path-layer").attr("opacity", 0.4);
      
      // Sun arc (East to West)
      // East is Right (90 deg from North), West is Left (270 deg)
      const sunPath = d3.path();
      sunPath.arc(totalW / 2, totalH / 2, Math.min(totalW, totalH) / 2.5, Math.PI, 0); // Simplified arc
      
      sunG.append("path")
        .attr("d", sunPath.toString())
        .attr("fill", "none")
        .attr("stroke", "#FFCC44")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "4 4");

      // Sun positions
      const positions = [
        { label: "6AM (E)", angle: Math.PI },
        { label: "12PM", angle: Math.PI / 2 },
        { label: "6PM (W)", angle: 0 }
      ];

      positions.forEach(p => {
        const r = Math.min(totalW, totalH) / 2.5;
        const sx = totalW / 2 + r * Math.cos(p.angle);
        const sy = totalH / 2 - r * Math.sin(p.angle);
        
        sunG.append("circle")
          .attr("cx", sx)
          .attr("cy", sy)
          .attr("r", 3)
          .attr("fill", "#FFCC44");
          
        sunG.append("text")
          .attr("x", sx)
          .attr("y", sy - 6)
          .attr("text-anchor", "middle")
          .attr("font-size", 6)
          .attr("fill", "#FFCC44")
          .attr("font-family", "monospace")
          .text(p.label);
      });
    }

    // 11. Scale Bar
    const bFt = 5;
    const bPx = bFt * (W / (params.plotW || 30));
    const bx = PAD + 10, by = totalH - 15;
    const scaleBar = svg.append("g").attr("class", "scale-bar");
    scaleBar.append("line").attr("x1", bx).attr("y1", by).attr("x2", bx + bPx).attr("y2", by).attr("stroke", theme==='dark'?'#666':'#999').attr("stroke-width", 1.5);
    scaleBar.append("line").attr("x1", bx).attr("y1", by-3).attr("x2", bx).attr("y2", by+1).attr("stroke", theme==='dark'?'#666':'#999').attr("stroke-width", 1.5);
    scaleBar.append("line").attr("x1", bx + bPx).attr("y1", by-3).attr("x2", bx + bPx).attr("y2", by+1).attr("stroke", theme==='dark'?'#666':'#999').attr("stroke-width", 1.5);
    scaleBar.append("text").attr("x", bx + bPx / 2).attr("y", by - 5).attr("text-anchor", "middle").attr("font-size", 7).attr("fill", theme==='dark'?'#666':'#999').attr("font-family", "monospace").text("5 ft");

  }, [layout, theme, showLabels, showFurniture, furniture, showSunPath, city, params.plotW]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const onMouseDown = useCallback(e => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }, []);

  const onMouseMove = useCallback(e => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const onMouseUp = useCallback(() => { dragging.current = false; }, []);

  const onWheel = useCallback(e => {
    e.preventDefault();
    setZoom(z => Math.min(4, Math.max(0.3, z - e.deltaY * 0.001)));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  const blueprintFilter = theme === 'blueprint'
    ? 'invert(1) sepia(1) saturate(4) hue-rotate(195deg)'
    : 'none';

  if (!layout && !svgCode && !loading) {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <div style={{ fontSize: 64, opacity: 0.08, userSelect: "none" }}>⬡</div>
        <div style={{ fontSize: 13, color: "#444", fontFamily: "monospace", letterSpacing: "0.12em", textTransform: "uppercase" }}>
          configure & generate
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <div style={{ fontSize: 48, animation: "spin 2s linear infinite", opacity: 0.5 }}>⬡</div>
        <div style={{ fontSize: 11, color: "#666", fontFamily: "monospace", letterSpacing: "0.1em" }}>D3 RENDERING…</div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      {/* Zoom controls */}
      <div style={{ position: "absolute", top: 12, right: 12, zIndex: 10, display: "flex", flexDirection: "column", gap: 4 }}>
        {[
          { label: "+", action: () => setZoom(z => Math.min(4, z + 0.2)) },
          { label: "−", action: () => setZoom(z => Math.max(0.3, z - 0.2)) },
          { label: "⊙", action: resetView },
        ].map(btn => (
          <button key={btn.label} onClick={btn.action} style={{
            width: 28, height: 28,
            background: "#0E0E18", border: "2px solid #2A2A3E",
            borderRadius: 4, color: "#888", fontSize: 15,
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "monospace", transition: "border-color 0.2s",
          }}
            onMouseEnter={e => e.target.style.borderColor = "#4488FF"}
            onMouseLeave={e => e.target.style.borderColor = "#2A2A3E"}
          >{btn.label}</button>
        ))}
      </div>

      <div
        ref={containerRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{ width: "100%", height: "100%", cursor: dragging.current ? "grabbing" : "grab", userSelect: "none", touchAction: "none" }}
      >
        <div style={{
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
          transformOrigin: "center center",
          transition: dragging.current ? "none" : "transform 0.1s ease",
        }}>
          {layout ? (
            <svg
              ref={svgRef}
              style={{
                maxWidth: "90%", maxHeight: "90%",
                boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
                filter: blueprintFilter,
                transition: "filter 0.4s ease",
                background: theme === 'dark' ? "#101020" : "#FFF"
              }}
            />
          ) : (
            <div
              style={{
                maxWidth: "90%", maxHeight: "90%",
                boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
                filter: blueprintFilter,
                transition: "filter 0.4s ease",
              }}
              dangerouslySetInnerHTML={{ __html: svgCode }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
