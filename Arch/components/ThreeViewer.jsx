"use client";
import { useRef, useState, useEffect, useCallback } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Sky, Grid } from "@react-three/drei";
import * as THREE from "three";

// ─── Constants ────────────────────────────────────────────────────────────────
const WALL_H       = 9;      // ceiling height in feet
const WALL_T       = 0.25;   // wall thickness in feet
const FLOOR_T      = 0.05;
const LABEL_Y      = WALL_H + 0.8;
const WALK_SPEED   = 8;      // ft/s
const WALK_HEIGHT  = 5.5;    // eye level in feet

// ─── Room mesh: floor + 4 walls ───────────────────────────────────────────────
function Room({ room, cx, cz, selected, onClick }) {
  const { ftW, ftH, color, name } = room;
  const rx = room.x / 10 - cx + ftW / 2;
  const rz = room.y / 10 - cz + ftH / 2;

  const floorColor = new THREE.Color(color || "#B8C8B8");
  const wallColor  = new THREE.Color("#EDEAE4");

  return (
    <group position={[rx, 0, rz]} onClick={onClick}>
      {/* Floor */}
      <mesh receiveShadow position={[0, FLOOR_T / 2, 0]}>
        <boxGeometry args={[ftW, FLOOR_T, ftH]} />
        <meshStandardMaterial color={floorColor} roughness={0.8} metalness={0} />
      </mesh>

      {/* North wall */}
      <mesh castShadow position={[0, WALL_H / 2, -ftH / 2 + WALL_T / 2]}>
        <boxGeometry args={[ftW, WALL_H, WALL_T]} />
        <meshStandardMaterial color={wallColor} roughness={0.9} />
      </mesh>
      {/* South wall */}
      <mesh castShadow position={[0, WALL_H / 2, ftH / 2 - WALL_T / 2]}>
        <boxGeometry args={[ftW, WALL_H, WALL_T]} />
        <meshStandardMaterial color={wallColor} roughness={0.9} />
      </mesh>
      {/* West wall */}
      <mesh castShadow position={[-ftW / 2 + WALL_T / 2, WALL_H / 2, 0]}>
        <boxGeometry args={[WALL_T, WALL_H, ftH]} />
        <meshStandardMaterial color={wallColor} roughness={0.9} />
      </mesh>
      {/* East wall */}
      <mesh castShadow position={[ftW / 2 - WALL_T / 2, WALL_H / 2, 0]}>
        <boxGeometry args={[WALL_T, WALL_H, ftH]} />
        <meshStandardMaterial color={wallColor} roughness={0.9} />
      </mesh>

      {/* Selection highlight ring */}
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[Math.min(ftW, ftH) * 0.3, Math.min(ftW, ftH) * 0.35, 32]} />
          <meshBasicMaterial color="#4488FF" transparent opacity={0.7} />
        </mesh>
      )}

      {/* Room label */}
      <Text
        position={[0, LABEL_Y, 0]}
        fontSize={1.1}
        color="#222222"
        anchorX="center"
        anchorY="middle"
        font={undefined}
        renderOrder={1}
      >
        {name}
      </Text>
      <Text
        position={[0, LABEL_Y - 1.3, 0]}
        fontSize={0.75}
        color="#666666"
        anchorX="center"
        anchorY="middle"
        renderOrder={1}
      >
        {`${ftW}×${ftH} ft`}
      </Text>
    </group>
  );
}

// ─── First-person WASD controller ────────────────────────────────────────────
function WalkthroughController({ active, startPos }) {
  const { camera, gl } = useThree();
  const keys    = useRef({});
  const pitch   = useRef(0);
  const yaw     = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    if (!active) return;

    const onKey = e => { keys.current[e.code] = e.type === "keydown"; };
    const onMove = e => {
      if (document.pointerLockElement !== gl.domElement) return;
      yaw.current   -= e.movementX * 0.002;
      pitch.current -= e.movementY * 0.002;
      pitch.current  = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitch.current));
    };
    const onClick = () => {
      if (!started.current) gl.domElement.requestPointerLock();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup",   onKey);
    document.addEventListener("mousemove", onMove);
    gl.domElement.addEventListener("click", onClick);

    camera.position.set(...startPos);
    camera.rotation.order = "YXZ";
    started.current = false;

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup",   onKey);
      document.removeEventListener("mousemove", onMove);
      gl.domElement.removeEventListener("click", onClick);
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, [active, gl, camera, startPos]);

  useFrame((_, delta) => {
    if (!active) return;
    camera.rotation.set(pitch.current, yaw.current, 0);

    const speed = WALK_SPEED * delta;
    const dir   = new THREE.Vector3();
    const front = new THREE.Vector3(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
    const right = new THREE.Vector3( Math.cos(yaw.current), 0, -Math.sin(yaw.current));

    if (keys.current["KeyW"] || keys.current["ArrowUp"])   dir.addScaledVector(front,  speed);
    if (keys.current["KeyS"] || keys.current["ArrowDown"])  dir.addScaledVector(front, -speed);
    if (keys.current["KeyA"] || keys.current["ArrowLeft"])  dir.addScaledVector(right, -speed);
    if (keys.current["KeyD"] || keys.current["ArrowRight"]) dir.addScaledVector(right,  speed);

    camera.position.addScaledVector(dir, 1);
    camera.position.y = WALK_HEIGHT;
  });

  return null;
}

// ─── North arrow label ────────────────────────────────────────────────────────
function NorthArrow({ cx, cz, totalFtW, totalFtH }) {
  return (
    <group position={[totalFtW / 2 - cx + 3, 0.1, -totalFtH / 2 - cz - 4]}>
      <Text fontSize={1.4} color="#CC2222" anchorX="center" anchorY="middle">N ↑</Text>
    </group>
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────
function Scene({ rooms, totalFtW, totalFtH, walkMode, selectedRoom, setSelectedRoom }) {
  const cx = totalFtW / 2;
  const cz = totalFtH / 2;

  const startPos = [0, WALK_HEIGHT, cz + 5];

  return (
    <>
      <Sky sunPosition={[100, 80, 100]} turbidity={4} rayleigh={0.5} />
      <ambientLight intensity={0.7} />
      <directionalLight
        position={[totalFtW, 40, totalFtH]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <pointLight position={[0, WALL_H - 1, 0]} intensity={0.4} decay={2} />

      <Grid
        position={[0, 0, 0]}
        args={[totalFtW + 20, totalFtH + 20]}
        cellSize={1}
        cellThickness={0.3}
        cellColor="#CCCCCC"
        sectionSize={10}
        sectionThickness={0.8}
        sectionColor="#AAAAAA"
        fadeDistance={120}
        infiniteGrid
      />

      {rooms.map((room, i) => (
        <Room
          key={room.name + i}
          room={room}
          cx={cx} cz={cz}
          selected={selectedRoom === room.name}
          onClick={() => setSelectedRoom(r => r === room.name ? null : room.name)}
        />
      ))}

      <NorthArrow cx={cx} cz={cz} totalFtW={totalFtW} totalFtH={totalFtH} />

      {walkMode
        ? <WalkthroughController active={true} startPos={startPos} />
        : <OrbitControls
            makeDefault
            target={[0, 0, 0]}
            minDistance={5}
            maxDistance={totalFtW * 3}
            maxPolarAngle={Math.PI / 2 - 0.05}
            enableDamping
            dampingFactor={0.08}
          />
      }
    </>
  );
}

// ─── Exported component ───────────────────────────────────────────────────────
export default function ThreeViewer({ layout, params }) {
  const [walkMode,      setWalkMode]      = useState(false);
  const [selectedRoom,  setSelectedRoom]  = useState(null);
  const containerRef = useRef(null);

  if (!layout?.rooms?.length) {
    return (
      <div style={{
        flex:1, display:"flex", alignItems:"center", justifyContent:"center",
        background:"#080814", color:"#333", fontFamily:"monospace", fontSize:11,
      }}>
        Generate a plan first to view in 3D
      </div>
    );
  }

  const rooms     = layout.rooms;
  const totalFtW  = (layout.W || 400) / 10;
  const totalFtH  = (layout.H || 400) / 10;
  const selected  = rooms.find(r => r.name === selectedRoom);

  return (
    <div ref={containerRef} style={{ flex:1, position:"relative", background:"#C8D8E8", overflow:"hidden" }}>

      {/* Three.js Canvas */}
      <Canvas
        shadows
        camera={{ position: [0, totalFtH * 1.1, totalFtH * 1.4], fov: 55, near: 0.5, far: 2000 }}
        style={{ width:"100%", height:"100%" }}
        gl={{ antialias: true }}
      >
        <Scene
          rooms={rooms}
          totalFtW={totalFtW}
          totalFtH={totalFtH}
          walkMode={walkMode}
          selectedRoom={selectedRoom}
          setSelectedRoom={setSelectedRoom}
        />
      </Canvas>

      {/* HUD — top left */}
      <div style={{
        position:"absolute", top:12, left:12,
        display:"flex", flexDirection:"column", gap:6,
        fontFamily:"monospace", pointerEvents:"none",
      }}>
        <div style={{
          background:"rgba(0,0,0,0.55)", borderRadius:6,
          padding:"5px 10px", color:"#CCC", fontSize:9, letterSpacing:"0.06em",
        }}>
          {params?.plotW}×{params?.plotH}ft · {params?.bhk}BHK · {params?.facing}-facing
        </div>
        {walkMode && (
          <div style={{
            background:"rgba(0,0,0,0.55)", borderRadius:6,
            padding:"5px 10px", color:"#88FFCC", fontSize:9, letterSpacing:"0.05em",
          }}>
            Click canvas to lock mouse · WASD move · ESC exit
          </div>
        )}
      </div>

      {/* HUD — top right controls */}
      <div style={{
        position:"absolute", top:12, right:12,
        display:"flex", gap:6,
      }}>
        <button
          onClick={() => { setWalkMode(w => !w); setSelectedRoom(null); }}
          style={{
            padding:"6px 12px",
            background: walkMode ? "#1A3A2A" : "rgba(0,0,0,0.6)",
            border:`1px solid ${walkMode ? "#44DD88" : "#333"}`,
            borderRadius:6, color: walkMode ? "#44DD88" : "#AAA",
            fontSize:10, cursor:"pointer", fontFamily:"monospace",
            letterSpacing:"0.05em", fontWeight:700,
          }}
        >
          {walkMode ? "↩ ORBIT" : "⚑ WALK"}
        </button>
      </div>

      {/* Selected room info panel */}
      {selected && !walkMode && (
        <div style={{
          position:"absolute", bottom:16, left:"50%", transform:"translateX(-50%)",
          background:"rgba(8,8,20,0.9)", border:"1px solid #1A1A2A",
          borderRadius:8, padding:"10px 18px",
          fontFamily:"monospace", display:"flex", gap:20, alignItems:"center",
        }}>
          <div style={{ width:12, height:12, borderRadius:2, background:selected.color, flexShrink:0 }}/>
          <span style={{ color:"#EEE", fontSize:11, fontWeight:700 }}>{selected.name}</span>
          <span style={{ color:"#666", fontSize:10 }}>{selected.ftW} × {selected.ftH} ft</span>
          <span style={{ color:"#666", fontSize:10 }}>{(selected.ftW * selected.ftH).toFixed(0)} sqft</span>
        </div>
      )}
    </div>
  );
}
