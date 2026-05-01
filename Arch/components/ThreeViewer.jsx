"use client";
import { useRef, useState, useEffect, useMemo } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";

// ─── Constants ────────────────────────────────────────────────────────────────
const WALL_H     = 9;
const WALL_T     = 0.22;
const FLOOR_T    = 0.08;
const WALK_SPEED = 10;
const EYE_H      = 5.5;
const DOOR_W     = 3.0;   // ft
const DOOR_H     = 7.5;   // ft
const WIN_W      = 3.2;   // ft
const WIN_SILL   = 2.8;   // ft from floor
const WIN_TOP    = 7.0;   // ft from floor

// ─── Furniture heights (ft) by item type ─────────────────────────────────────
const FURN_H_MAP = {
  "sofa": 3.0, "coffee table": 1.5, "tv unit": 1.5,
  "king bed": 2.2, "double bed": 2.0, "queen bed": 2.0,
  "side table": 2.0, "wardrobe": 6.5,
  "counter": 3.0, "refrigerator": 5.5,
  "dining table": 2.5,
  "wc": 2.5, "basin": 3.0,
  "altar": 3.0,
  "desk": 2.5, "chair": 3.0,
};
function getFurnH(name) {
  const lower = (name || "").toLowerCase();
  for (const [k, h] of Object.entries(FURN_H_MAP)) {
    if (lower.includes(k)) return h;
  }
  return 2.5;
}

// ─── Compute door + window openings from room adjacency ───────────────────────
// Doors:   placed at shared wall midpoints between adjacent rooms
// Windows: placed centered on exterior walls (no shared adjacency on that side)
function computeOpenings(rooms) {
  const map = {}, interior = {};
  for (const r of rooms) map[r.name] = { N: [], S: [], E: [], W: [] };

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j];

      // A-East / B-West (vertical shared wall)
      if (Math.abs((a.x + a.w) - b.x) <= 1) {
        interior[`${a.name}_E`] = interior[`${b.name}_W`] = true;
        const ov1 = Math.max(a.y, b.y), ov2 = Math.min(a.y + a.h, b.y + b.h);
        if ((ov2 - ov1) / 10 >= DOOR_W + 0.5) {
          const ctr = (ov1 + ov2) / 2;
          map[a.name].E.push({ type: "door", center: (ctr - a.y) / 10, width: DOOR_W });
          map[b.name].W.push({ type: "door", center: (ctr - b.y) / 10, width: DOOR_W });
        }
      }
      // B-East / A-West
      if (Math.abs((b.x + b.w) - a.x) <= 1) {
        interior[`${b.name}_E`] = interior[`${a.name}_W`] = true;
        const ov1 = Math.max(a.y, b.y), ov2 = Math.min(a.y + a.h, b.y + b.h);
        if ((ov2 - ov1) / 10 >= DOOR_W + 0.5) {
          const ctr = (ov1 + ov2) / 2;
          map[b.name].E.push({ type: "door", center: (ctr - b.y) / 10, width: DOOR_W });
          map[a.name].W.push({ type: "door", center: (ctr - a.y) / 10, width: DOOR_W });
        }
      }
      // A-South / B-North (horizontal shared wall)
      if (Math.abs((a.y + a.h) - b.y) <= 1) {
        interior[`${a.name}_S`] = interior[`${b.name}_N`] = true;
        const ov1 = Math.max(a.x, b.x), ov2 = Math.min(a.x + a.w, b.x + b.w);
        if ((ov2 - ov1) / 10 >= DOOR_W + 0.5) {
          const ctr = (ov1 + ov2) / 2;
          map[a.name].S.push({ type: "door", center: (ctr - a.x) / 10, width: DOOR_W });
          map[b.name].N.push({ type: "door", center: (ctr - b.x) / 10, width: DOOR_W });
        }
      }
      // B-South / A-North
      if (Math.abs((b.y + b.h) - a.y) <= 1) {
        interior[`${b.name}_S`] = interior[`${a.name}_N`] = true;
        const ov1 = Math.max(a.x, b.x), ov2 = Math.min(a.x + a.w, b.x + b.w);
        if ((ov2 - ov1) / 10 >= DOOR_W + 0.5) {
          const ctr = (ov1 + ov2) / 2;
          map[b.name].S.push({ type: "door", center: (ctr - b.x) / 10, width: DOOR_W });
          map[a.name].N.push({ type: "door", center: (ctr - a.x) / 10, width: DOOR_W });
        }
      }
    }
  }

  // Windows on non-shared exterior walls
  for (const r of rooms) {
    for (const [side, len] of [["N", r.ftW], ["S", r.ftW], ["E", r.ftH], ["W", r.ftH]]) {
      if (!interior[`${r.name}_${side}`] && len >= WIN_W + 2) {
        map[r.name][side].push({ type: "window", center: len / 2, width: Math.min(WIN_W, len - 2) });
      }
    }
  }

  return map;
}

// ─── Build wall piece descriptors from openings ───────────────────────────────
// Returns array of { start, end, y0, y1, solid } along the wall length axis
function buildWallPieces(wallLen, openings) {
  const sorted = [...openings].sort(
    (a, b) => (a.center - a.width / 2) - (b.center - b.width / 2),
  );
  const pieces = [];
  let cur = 0;
  for (const o of sorted) {
    const s = Math.max(0, o.center - o.width / 2);
    const e = Math.min(wallLen, o.center + o.width / 2);
    if (s > cur + 0.05)
      pieces.push({ start: cur, end: s, y0: 0, y1: WALL_H, solid: true });
    if (o.type === "window") {
      if (WIN_SILL > 0.05)
        pieces.push({ start: s, end: e, y0: 0,       y1: WIN_SILL, solid: true });
      if (WALL_H - WIN_TOP > 0.05)
        pieces.push({ start: s, end: e, y0: WIN_TOP,  y1: WALL_H,  solid: true });
      pieces.push({ start: s, end: e, y0: WIN_SILL, y1: WIN_TOP, solid: false }); // glass
    }
    // door → full-height gap, no geometry
    cur = Math.max(cur, e);
  }
  if (cur < wallLen - 0.05)
    pieces.push({ start: cur, end: wallLen, y0: 0, y1: WALL_H, solid: true });
  return pieces;
}

// ─── Sky + atmospheric fog ─────────────────────────────────────────────────────
function SkyEnv() {
  const { scene } = useThree();
  useEffect(() => {
    scene.background = new THREE.Color("#87CEEB");
    scene.fog = new THREE.FogExp2("#C5E8F5", 0.0035);
    return () => { scene.background = null; scene.fog = null; };
  }, [scene]);
  // Visible sun disc high in sky
  return (
    <mesh position={[200, 280, -400]}>
      <sphereGeometry args={[18, 16, 16]} />
      <meshBasicMaterial color="#FFF5CC" />
    </mesh>
  );
}

// ─── Grass ground ─────────────────────────────────────────────────────────────
function Ground({ size }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
      <planeGeometry args={[size * 6, size * 6, 1, 1]} />
      <meshStandardMaterial color="#6DAF6A" roughness={0.98} />
    </mesh>
  );
}

// ─── Horizontal wall (N or S) with door/window openings ──────────────────────
// Pieces run along local X. Doors swing into room interior.
const H_WALL_COLORS = { N: "#EDEAE4", S: "#E8E4DC" };

function HorizWall({ ftW, wallZ, side, openings }) {
  const wColor = H_WALL_COLORS[side] || "#EDEAE4";
  const pieces = buildWallPieces(ftW, openings);
  const doors  = openings.filter(o => o.type === "door");
  // N wall: room interior is +Z  → swing +Z → rotation.y = -π/3
  // S wall: room interior is -Z  → swing -Z → rotation.y = +π/3
  const swingY = side === "N" ? -Math.PI / 3 : Math.PI / 3;

  return (
    <group position={[0, 0, wallZ]}>
      {/* Wall segments */}
      {pieces.map((p, i) => {
        const w = p.end - p.start, h = p.y1 - p.y0;
        const cx = p.start - ftW / 2 + w / 2;
        const cy = p.y0 + h / 2;
        if (!p.solid) {
          // Glass pane (window)
          return (
            <group key={i}>
              <mesh position={[cx, cy, 0]}>
                <boxGeometry args={[w - 0.12, h - 0.12, WALL_T * 0.35]} />
                <meshStandardMaterial color="#A8D8F0" transparent opacity={0.32}
                  roughness={0.05} metalness={0.25} />
              </mesh>
              {/* Window frame strips */}
              <mesh position={[cx, p.y0 + 0.06, 0]}><boxGeometry args={[w, 0.1, WALL_T * 0.9]} /><meshStandardMaterial color={wColor} roughness={0.9} /></mesh>
              <mesh position={[cx, p.y1 - 0.06, 0]}><boxGeometry args={[w, 0.1, WALL_T * 0.9]} /><meshStandardMaterial color={wColor} roughness={0.9} /></mesh>
              <mesh position={[p.start - ftW / 2 + 0.06, cy, 0]}><boxGeometry args={[0.1, h, WALL_T * 0.9]} /><meshStandardMaterial color={wColor} roughness={0.9} /></mesh>
              <mesh position={[p.end - ftW / 2 - 0.06, cy, 0]}><boxGeometry args={[0.1, h, WALL_T * 0.9]} /><meshStandardMaterial color={wColor} roughness={0.9} /></mesh>
            </group>
          );
        }
        return (
          <mesh key={i} position={[cx, cy, 0]} castShadow receiveShadow>
            <boxGeometry args={[w, h, WALL_T]} />
            <meshStandardMaterial color={wColor} roughness={0.9} />
          </mesh>
        );
      })}

      {/* Door panels — hinge at left (West) edge, swing into room */}
      {doors.map((d, i) => {
        const hx = (d.center - DOOR_W / 2) - ftW / 2;
        return (
          <group key={i} position={[hx, 0, 0]} rotation={[0, swingY, 0]}>
            {/* Door slab */}
            <mesh position={[DOOR_W / 2, DOOR_H / 2, WALL_T * 0.5 + 0.06]} castShadow>
              <boxGeometry args={[DOOR_W - 0.08, DOOR_H - 0.04, 0.11]} />
              <meshStandardMaterial color="#A07848" roughness={0.45} />
            </mesh>
            {/* Panel inset detail */}
            <mesh position={[DOOR_W / 2, DOOR_H * 0.62, WALL_T * 0.5 + 0.12]}>
              <boxGeometry args={[DOOR_W * 0.6, DOOR_H * 0.3, 0.04]} />
              <meshStandardMaterial color="#8B6035" roughness={0.5} />
            </mesh>
            <mesh position={[DOOR_W / 2, DOOR_H * 0.28, WALL_T * 0.5 + 0.12]}>
              <boxGeometry args={[DOOR_W * 0.6, DOOR_H * 0.3, 0.04]} />
              <meshStandardMaterial color="#8B6035" roughness={0.5} />
            </mesh>
            {/* Handle */}
            <mesh position={[DOOR_W * 0.82, DOOR_H * 0.46, WALL_T * 0.5 + 0.16]}>
              <sphereGeometry args={[0.1, 8, 8]} />
              <meshStandardMaterial color="#C8A030" metalness={0.85} roughness={0.12} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// ─── Vertical wall (E or W) with door/window openings ────────────────────────
// Pieces run along local Z. Doors swing into room interior.
const V_WALL_COLORS = { W: "#EDEAE4", E: "#E8E4DC" };

function VertWall({ ftH, wallX, side, openings }) {
  const wColor = V_WALL_COLORS[side] || "#EDEAE4";
  const pieces = buildWallPieces(ftH, openings);
  const doors  = openings.filter(o => o.type === "door");
  // W wall: room interior is +X → rotation.y = +π/3
  // E wall: room interior is -X → rotation.y = -π/3
  const swingY = side === "W" ? Math.PI / 3 : -Math.PI / 3;

  return (
    <group position={[wallX, 0, 0]}>
      {/* Wall segments */}
      {pieces.map((p, i) => {
        const d = p.end - p.start, h = p.y1 - p.y0;
        const cz = p.start - ftH / 2 + d / 2;
        const cy = p.y0 + h / 2;
        if (!p.solid) {
          // Glass pane (window)
          return (
            <group key={i}>
              <mesh position={[0, cy, cz]}>
                <boxGeometry args={[WALL_T * 0.35, h - 0.12, d - 0.12]} />
                <meshStandardMaterial color="#A8D8F0" transparent opacity={0.32}
                  roughness={0.05} metalness={0.25} />
              </mesh>
              {/* Window frame strips */}
              <mesh position={[0, p.y0 + 0.06, cz]}><boxGeometry args={[WALL_T * 0.9, 0.1, d]} /><meshStandardMaterial color={wColor} roughness={0.9} /></mesh>
              <mesh position={[0, p.y1 - 0.06, cz]}><boxGeometry args={[WALL_T * 0.9, 0.1, d]} /><meshStandardMaterial color={wColor} roughness={0.9} /></mesh>
              <mesh position={[0, cy, p.start - ftH / 2 + 0.06]}><boxGeometry args={[WALL_T * 0.9, h, 0.1]} /><meshStandardMaterial color={wColor} roughness={0.9} /></mesh>
              <mesh position={[0, cy, p.end - ftH / 2 - 0.06]}><boxGeometry args={[WALL_T * 0.9, h, 0.1]} /><meshStandardMaterial color={wColor} roughness={0.9} /></mesh>
            </group>
          );
        }
        return (
          <mesh key={i} position={[0, cy, cz]} castShadow receiveShadow>
            <boxGeometry args={[WALL_T, h, d]} />
            <meshStandardMaterial color={wColor} roughness={0.9} />
          </mesh>
        );
      })}

      {/* Door panels — hinge at North edge of opening, swing into room */}
      {doors.map((d, i) => {
        const hz = (d.center - DOOR_W / 2) - ftH / 2;
        return (
          <group key={i} position={[0, 0, hz]} rotation={[0, swingY, 0]}>
            {/* Door slab — panel extends along +Z from hinge */}
            <mesh position={[WALL_T * 0.5 + 0.06, DOOR_H / 2, DOOR_W / 2]} castShadow>
              <boxGeometry args={[0.11, DOOR_H - 0.04, DOOR_W - 0.08]} />
              <meshStandardMaterial color="#A07848" roughness={0.45} />
            </mesh>
            {/* Panel inset */}
            <mesh position={[WALL_T * 0.5 + 0.12, DOOR_H * 0.62, DOOR_W / 2]}>
              <boxGeometry args={[0.04, DOOR_H * 0.3, DOOR_W * 0.6]} />
              <meshStandardMaterial color="#8B6035" roughness={0.5} />
            </mesh>
            <mesh position={[WALL_T * 0.5 + 0.12, DOOR_H * 0.28, DOOR_W / 2]}>
              <boxGeometry args={[0.04, DOOR_H * 0.3, DOOR_W * 0.6]} />
              <meshStandardMaterial color="#8B6035" roughness={0.5} />
            </mesh>
            {/* Handle */}
            <mesh position={[WALL_T * 0.5 + 0.16, DOOR_H * 0.46, DOOR_W * 0.82]}>
              <sphereGeometry args={[0.1, 8, 8]} />
              <meshStandardMaterial color="#C8A030" metalness={0.85} roughness={0.12} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// ─── Single room ──────────────────────────────────────────────────────────────
function Room({ room, cx, cz, selected, onSelect, openings }) {
  const { ftW, ftH, color, name } = room;
  const rx = room.x / 10 - cx + ftW / 2;
  const rz = room.y / 10 - cz + ftH / 2;
  const ops = openings[name] || { N: [], S: [], E: [], W: [] };

  return (
    <group position={[rx, 0, rz]}>
      {/* Floor slab */}
      <mesh receiveShadow position={[0, FLOOR_T / 2, 0]}
        onClick={e => { e.stopPropagation(); onSelect(name); }}>
        <boxGeometry args={[ftW - WALL_T, FLOOR_T, ftH - WALL_T]} />
        <meshStandardMaterial color={color || "#B8C8B8"} roughness={0.85} />
      </mesh>

      {/* Walls with openings */}
      <HorizWall ftW={ftW} wallZ={-(ftH / 2 - WALL_T / 2)} side="N" openings={ops.N} />
      <HorizWall ftW={ftW} wallZ={ ftH / 2 - WALL_T / 2}  side="S" openings={ops.S} />
      <VertWall  ftH={ftH} wallX={-(ftW / 2 - WALL_T / 2)} side="W" openings={ops.W} />
      <VertWall  ftH={ftH} wallX={ ftW / 2 - WALL_T / 2}  side="E" openings={ops.E} />

      {/* Selection glow ring */}
      {selected && (
        <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[Math.min(ftW, ftH) * 0.25, Math.min(ftW, ftH) * 0.32, 32]} />
          <meshBasicMaterial color="#4488FF" transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* HTML label */}
      <Html position={[0, WALL_H + 1.2, 0]} center distanceFactor={28} occlude={false}
        style={{ pointerEvents: "none", userSelect: "none" }}>
        <div style={{
          background: "rgba(8,8,20,0.78)", border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 5, padding: "3px 8px", color: "#EEE", fontSize: 11,
          fontFamily: "monospace", fontWeight: 700, whiteSpace: "nowrap", letterSpacing: "0.03em",
        }}>
          {name}
          <span style={{ color: "#888", fontWeight: 400, marginLeft: 5 }}>{ftW}×{ftH}</span>
        </div>
      </Html>
    </group>
  );
}

// ─── North label ──────────────────────────────────────────────────────────────
function NorthLabel({ x, z }) {
  return (
    <Html position={[x, 1, z]} center distanceFactor={28} style={{ pointerEvents: "none" }}>
      <div style={{
        color: "#CC2222", fontWeight: 900, fontSize: 15,
        fontFamily: "monospace", textShadow: "0 0 6px rgba(0,0,0,0.5)",
      }}>N ↑</div>
    </Html>
  );
}

// ─── Furniture piece ─────────────────────────────────────────────────────────
function FurnitureItem({ item, cx, cz }) {
  const ftW = item.w / 10;
  const ftD = item.h / 10;
  const h   = getFurnH(item.name);
  const wx  = (item.x + item.w / 2) / 10 - cx;
  const wz  = (item.y + item.h / 2) / 10 - cz;
  return (
    <mesh position={[wx, h / 2 + FLOOR_T, wz]} castShadow receiveShadow>
      <boxGeometry args={[ftW, h, ftD]} />
      <meshStandardMaterial color={item.color || "#8B7355"} roughness={0.65} metalness={0.05} />
    </mesh>
  );
}

// ─── First-person walker ──────────────────────────────────────────────────────
function WalkController({ active }) {
  const { camera, gl } = useThree();
  const keys  = useRef({});
  const yaw   = useRef(0);
  const pitch = useRef(0);

  useEffect(() => {
    if (!active) return;
    camera.rotation.order = "YXZ";
    const down  = e => { keys.current[e.code] = true; };
    const up    = e => { keys.current[e.code] = false; };
    const move  = e => {
      if (document.pointerLockElement !== gl.domElement) return;
      yaw.current   -= e.movementX * 0.0022;
      pitch.current -= e.movementY * 0.0022;
      pitch.current  = Math.max(-1.1, Math.min(1.1, pitch.current));
    };
    const click = () => gl.domElement.requestPointerLock();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    document.addEventListener("mousemove", move);
    gl.domElement.addEventListener("click", click);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("mousemove", move);
      gl.domElement.removeEventListener("click", click);
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, [active, camera, gl]);

  useFrame((_, dt) => {
    if (!active) return;
    camera.rotation.set(pitch.current, yaw.current, 0);
    const spd = WALK_SPEED * dt;
    const fwd = new THREE.Vector3(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
    const rgt = new THREE.Vector3( Math.cos(yaw.current), 0, -Math.sin(yaw.current));
    if (keys.current.KeyW  || keys.current.ArrowUp)    camera.position.addScaledVector(fwd,  spd);
    if (keys.current.KeyS  || keys.current.ArrowDown)  camera.position.addScaledVector(fwd, -spd);
    if (keys.current.KeyA  || keys.current.ArrowLeft)  camera.position.addScaledVector(rgt, -spd);
    if (keys.current.KeyD  || keys.current.ArrowRight) camera.position.addScaledVector(rgt,  spd);
    camera.position.y = EYE_H;
  });

  return null;
}

// ─── Main scene ───────────────────────────────────────────────────────────────
function Scene({ rooms, totalFtW, totalFtH, walkMode, selected, onSelect, furniture, showFurniture }) {
  const cx = totalFtW / 2;
  const cz = totalFtH / 2;
  const openings = useMemo(() => computeOpenings(rooms), [rooms]);

  return (
    <>
      <SkyEnv />

      <ambientLight intensity={1.1} />
      <hemisphereLight args={["#DDEEFF", "#88AA88", 0.55]} />
      <directionalLight
        position={[totalFtW * 0.8, 60, totalFtH * 0.8]}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-totalFtW * 1.5}
        shadow-camera-right={totalFtW * 1.5}
        shadow-camera-top={totalFtH * 1.5}
        shadow-camera-bottom={-totalFtH * 1.5}
      />

      <Ground size={Math.max(totalFtW, totalFtH)} />

      {rooms.map((room, i) => (
        <Room
          key={`${room.name}-${i}`}
          room={room}
          cx={cx} cz={cz}
          selected={selected === room.name}
          onSelect={onSelect}
          openings={openings}
        />
      ))}

      {showFurniture && furniture?.placements?.map((p, pi) =>
        p.items.map((item, ii) => (
          <FurnitureItem key={`f-${pi}-${ii}`} item={item} cx={cx} cz={cz} />
        ))
      )}

      <NorthLabel x={totalFtW / 2 - cx + 4} z={-(totalFtH / 2 - cz) - 5} />

      {walkMode
        ? <WalkController active />
        : <OrbitControls
            makeDefault
            target={[0, 2, 0]}
            minDistance={4}
            maxDistance={totalFtW * 4}
            maxPolarAngle={Math.PI / 2 - 0.02}
            enableDamping
            dampingFactor={0.07}
          />
      }
    </>
  );
}

// ─── Exported component ───────────────────────────────────────────────────────
export default function ThreeViewer({ layout, params, furniture }) {
  const [walkMode,      setWalkMode]      = useState(false);
  const [showFurniture, setShowFurniture] = useState(true);
  const [selected,      setSelected]      = useState(null);
  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  if (!layout?.rooms?.length) {
    return (
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        background: "#080814", color: "#333", fontFamily: "monospace", fontSize: 11,
      }}>
        Generate a plan first to view in 3D
      </div>
    );
  }

  const rooms    = layout.rooms;
  const totalFtW = (layout.W || 300) / 10;
  const totalFtH = (layout.H || 400) / 10;
  const selRoom  = rooms.find(r => r.name === selected);
  const camY     = totalFtH * 1.2;
  const camZ     = totalFtH * 1.5;

  return (
    <div ref={containerRef}
      style={{ flex: 1, position: "relative", background: "#87CEEB", overflow: "hidden" }}>
      {size.w > 0 && size.h > 0 && (
        <Canvas
          shadows
          camera={{ position: [0, camY, camZ], fov: 52, near: 0.3, far: 3000 }}
          style={{ position: "absolute", inset: 0 }}
          gl={{ antialias: true, alpha: false }}
          onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
        >
          <Scene
            rooms={rooms}
            totalFtW={totalFtW}
            totalFtH={totalFtH}
            walkMode={walkMode}
            selected={selected}
            onSelect={n => setSelected(s => s === n ? null : n)}
            furniture={furniture}
            showFurniture={showFurniture}
          />
        </Canvas>
      )}

      {/* Top-left info */}
      <div style={{
        position: "absolute", top: 12, left: 12,
        display: "flex", flexDirection: "column", gap: 6,
        fontFamily: "monospace", pointerEvents: "none", zIndex: 10,
      }}>
        <div style={{
          background: "rgba(0,0,0,0.45)", borderRadius: 6,
          padding: "5px 10px", color: "#DDD", fontSize: 9, letterSpacing: "0.06em",
        }}>
          {params?.plotW}×{params?.plotH}ft · {params?.bhk}BHK · {params?.facing}-facing
        </div>
        {walkMode && (
          <div style={{
            background: "rgba(0,0,0,0.45)", borderRadius: 6,
            padding: "5px 10px", color: "#88FFCC", fontSize: 9,
          }}>
            Click canvas · WASD move · ESC exit
          </div>
        )}
      </div>

      {/* Top-right controls */}
      <div style={{ position: "absolute", top: 12, right: 12, zIndex: 10, display: "flex", gap: 6 }}>
        {furniture?.placements?.length > 0 && (
          <button onClick={() => setShowFurniture(v => !v)} style={{
            padding: "6px 14px",
            background: showFurniture ? "rgba(20,30,60,0.85)" : "rgba(0,0,0,0.55)",
            border: `1px solid ${showFurniture ? "#4488FF" : "#444"}`,
            borderRadius: 6,
            color: showFurniture ? "#88AAFF" : "#666",
            fontSize: 10, cursor: "pointer", fontFamily: "monospace",
            fontWeight: 700, letterSpacing: "0.05em",
          }}>
            {showFurniture ? "■ FURN" : "□ FURN"}
          </button>
        )}
        <button onClick={() => { setWalkMode(w => !w); setSelected(null); }} style={{
          padding: "6px 14px",
          background: walkMode ? "rgba(20,50,30,0.85)" : "rgba(0,0,0,0.55)",
          border: `1px solid ${walkMode ? "#44DD88" : "#444"}`,
          borderRadius: 6,
          color: walkMode ? "#44DD88" : "#AAA",
          fontSize: 10, cursor: "pointer", fontFamily: "monospace",
          fontWeight: 700, letterSpacing: "0.05em",
        }}>
          {walkMode ? "↩ ORBIT" : "⚑ WALK"}
        </button>
      </div>

      {/* Bottom: selected room info */}
      {selRoom && !walkMode && (
        <div style={{
          position: "absolute", bottom: 16,
          left: "50%", transform: "translateX(-50%)",
          background: "rgba(8,8,20,0.88)",
          border: "1px solid #1A1A2A",
          borderRadius: 8, padding: "9px 20px",
          fontFamily: "monospace",
          display: "flex", gap: 18, alignItems: "center",
          zIndex: 10,
        }}>
          <div style={{
            width: 11, height: 11, borderRadius: 2,
            background: selRoom.color, flexShrink: 0,
          }} />
          <span style={{ color: "#EEE", fontSize: 11, fontWeight: 700 }}>{selRoom.name}</span>
          <span style={{ color: "#666", fontSize: 10 }}>{selRoom.ftW} × {selRoom.ftH} ft</span>
          <span style={{ color: "#555", fontSize: 10 }}>{(selRoom.ftW * selRoom.ftH).toFixed(0)} sqft</span>
          <button onClick={() => setSelected(null)}
            style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 14 }}>×</button>
        </div>
      )}
    </div>
  );
}
