import React, { useState, useRef, useEffect, useCallback } from 'react';
import { UploadCloud, FileBox, Database, ChevronDown, ChevronRight, Cpu, Box, RotateCcw, Settings } from 'lucide-react';
import './index.css';

// Import WASM
import initWasm, { IfcViewer, parse_ifc_metadata } from 'ifc-parser-wasm';
import wasmUrl from '/ifc_parser_wasm_bg.wasm?url';

interface SpatialNodeDto {
  id: number;
  node_type: string;
  name: string;
  entity_type: string;
  elevation: number | null;
  has_geometry: boolean;
  attributes: string;
  children: SpatialNodeDto[];
}

interface IfcMetadataResponse {
  success: boolean;
  error?: string;
  root: SpatialNodeDto | null;
}

// ─── Spatial Tree Component ─────────────────────────────────────────────────
const SpatialNodeTree = ({ node, level = 0 }: { node: SpatialNodeDto; level?: number }) => {
  const [expanded, setExpanded] = useState(level < 2); // Expand top levels by default
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div className="spatial-node">
      <div
        className={`node-header ${hasChildren ? 'clickable' : ''}`}
        style={{ paddingLeft: `${level * 16}px` }}
        onClick={() => hasChildren && setExpanded(!expanded)}
        title={node.attributes}
      >
        <div className="node-icon">
          {hasChildren ? (
            expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span style={{ width: 14, display: 'inline-block' }} />
          )}
        </div>
        <div className="node-content">
          <span className="node-type">{node.node_type}</span>
          {node.name && <span className="node-name">{node.name}</span>}
          {node.elevation != null && <span className="node-elevation">({node.elevation.toFixed(2)}m)</span>}
        </div>
      </div>
      {expanded && hasChildren && (
        <div className="node-children">
          {node.children.map(child => (
            <SpatialNodeTree key={child.id} node={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Main App ───────────────────────────────────────────────────────────────
function App() {
  const [isWasmReady, setIsWasmReady] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rootNode, setRootNode] = useState<SpatialNodeDto | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasGeometry, setHasGeometry] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [statsText, setStatsText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [showPerformance, setShowPerformance] = useState(() => {
    return localStorage.getItem('showPerformance') === 'true';
  });
  const [fps, setFps] = useState(0);
  const [frameTime, setFrameTime] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<IfcViewer | null>(null);
  const rafRef = useRef<number>(0);
  const dragCounterRef = useRef(0);

  // Performance tracking refs
  const frameCountRef = useRef(0);
  const firstTickTimeRef = useRef(performance.now());
  const accumulatedTickTimeRef = useRef(0);

  // Auto-load Duplex model if enabled in localStorage
  const [autoLoadDuplex, setAutoLoadDuplex] = useState(() => {
    return localStorage.getItem('autoLoadDuplex') === 'true';
  });

  // Pointer state for orbit + pan controls
  // mode: 'orbit' = left btn, 'pan' = middle/right btn
  const pointerRef = useRef({ down: false, lastX: 0, lastY: 0, mode: 'orbit' as 'orbit' | 'pan' });

  const processIfcContent = useCallback(async (name: string, text: string) => {
    setFileName(name);
    setIsProcessing(true);
    setRootNode(null);
    setHasGeometry(false);
    setRenderError(null);

    try {
      // 1. Load geometry into WebGPU
      try {
        viewerRef.current?.load_ifc_geometry(text);
        setHasGeometry(true);
      } catch (geoErr: any) {
        console.warn('Geometry loading partial/failed:', geoErr);
      }

      // 2. Parse metadata for sidebar
      const resultJson = parse_ifc_metadata(text);
      const result: IfcMetadataResponse = JSON.parse(resultJson);
      if (result.success) {
        setRootNode(result.root);

        let count = 0;
        const countElements = (n: SpatialNodeDto) => {
          count++;
          n.children?.forEach(countElements);
        };
        if (result.root) countElements(result.root);
        setStatsText(`${count} entities`);
      } else {
        setRenderError('Parser error: ' + result.error);
      }
    } catch (e: any) {
      console.error(e);
      setRenderError(e?.message ?? String(e));
    } finally {
      setIsProcessing(false);
    }
  }, []);

  // ── Initialize WASM + Viewer ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let handleShaderUpdate: ((data: { code: string }) => void) | null = null;

    initWasm(wasmUrl).then(async () => {
      if (cancelled) return;
      setIsWasmReady(true);

      // Resize canvas to pixel ratio
      const canvas = canvasRef.current!;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);

      try {
        // IfcViewer initialization is async
        const viewer = await IfcViewer.create('webgpu-canvas');
        viewerRef.current = viewer;
        viewer.update_camera();
        startRenderLoop(viewer);

        // Auto-load Duplex on startup if enabled in localStorage
        const shouldAutoLoad = localStorage.getItem('autoLoadDuplex') === 'true';
        if (shouldAutoLoad && !cancelled) {
          setIsProcessing(true);
          try {
            const res = await fetch('/DuplexA.ifc');
            if (!res.ok) throw new Error('Failed to fetch default Duplex model');
            const text = await res.text();
            if (!cancelled) {
              await processIfcContent('DuplexA.ifc', text);
            }
          } catch (e: any) {
            console.error(e);
            if (!cancelled) {
              setRenderError(e?.message ?? String(e));
              setIsProcessing(false);
            }
          }
        }

        // Register custom HMR shader update listener when viewer is fully initialized
        if (import.meta.hot) {
          handleShaderUpdate = (data: { code: string }) => {
            console.log('🔥 Hot-reloading shader via WebSocket event...');
            try {
              viewer.update_shader(data.code);
            } catch (err) {
              console.error('Failed to reload shader:', err);
            }
          };
          import.meta.hot.on('shader-update', handleShaderUpdate);
        }
      } catch (e: any) {
        console.error('WebGPU init failed:', e);
        setRenderError(String(e?.message ?? e));
      }
    }).catch((e: any) => {
      console.error('WASM load failed', e);
      setRenderError('Failed to load WebAssembly module.');
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      viewerRef.current?.free();
      viewerRef.current = null;
      if (import.meta.hot && handleShaderUpdate) {
        import.meta.hot.off('shader-update', handleShaderUpdate);
      }
    };
  }, []);

  const handleAutoLoadToggle = useCallback(async (checked: boolean) => {
    setAutoLoadDuplex(checked);
    localStorage.setItem('autoLoadDuplex', String(checked));

    // Only load DuplexA if enabling it and there is no model currently loaded
    if (checked && !fileName && isWasmReady && viewerRef.current) {
      setIsProcessing(true);
      try {
        const res = await fetch('/DuplexA.ifc');
        if (!res.ok) throw new Error('Failed to fetch default Duplex model');
        const text = await res.text();
        await processIfcContent('DuplexA.ifc', text);
      } catch (e: any) {
        console.error(e);
        setRenderError(e?.message ?? String(e));
        setIsProcessing(false);
      }
    }
  }, [fileName, isWasmReady, processIfcContent]);

  const handlePerformanceToggle = useCallback((checked: boolean) => {
    setShowPerformance(checked);
    localStorage.setItem('showPerformance', String(checked));
  }, []);

  // ── Render Loop ───────────────────────────────────────────────────────────
  const startRenderLoop = (viewer: IfcViewer) => {
    firstTickTimeRef.current = performance.now();
    const loop = () => {
      try {
        viewer.render();
      } catch (e: any) {
        // Ignore transient surface errors like "lost"
        if (!String(e).includes('Lost') && !String(e).includes('Timeout')) {
          console.warn('Render error:', e);
        }
      }
      const lastTickTime = performance.now();
      const tickTime = lastTickTime - firstTickTimeRef.current;
      firstTickTimeRef.current = lastTickTime;

      frameCountRef.current++;
      accumulatedTickTimeRef.current += tickTime;

      if (frameCountRef.current >= 30) {
        const avgTickTime = accumulatedTickTimeRef.current / frameCountRef.current;
        const calculatedFps = avgTickTime > 0 ? 1000 / avgTickTime : 0;

        setFps(calculatedFps);
        setFrameTime(avgTickTime);

        frameCountRef.current = 0;
        accumulatedTickTimeRef.current = 0;
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  // ── Canvas Resize ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      canvas.width = w;
      canvas.height = h;
      viewerRef.current?.resize(w, h);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ── Orbit + Pan Controls ─────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!hasGeometry) return;
    // button 0 = left (orbit), button 1 = middle (pan), button 2 = right (pan)
    const mode = e.button === 0 ? 'orbit' : 'pan';
    pointerRef.current = { down: true, lastX: e.clientX, lastY: e.clientY, mode };
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [hasGeometry]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = pointerRef.current;
    if (!p.down || !viewerRef.current) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (p.mode === 'pan') {
      viewerRef.current.pan_camera(dx, dy);
    } else {
      viewerRef.current.orbit_camera(dx, dy);
    }
  }, []);

  const onPointerUp = useCallback(() => {
    pointerRef.current.down = false;
  }, []);

  // Suppress right-click context menu on the canvas
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // ── Non-passive wheel listener (fixes "Unable to preventDefault" warning) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (viewerRef.current) viewerRef.current.zoom_camera(e.deltaY);
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, []);

  // ── DnD ──────────────────────────────────────────────────────────────────
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsDragging(true);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file?.name?.toLowerCase().endsWith('.ifc')) {
      await processFile(file);
    } else {
      alert('Please drop a valid .ifc file.');
    }
  }, [isWasmReady]);

  // ── File Processing ───────────────────────────────────────────────────────
  const processFile = async (file: File) => {
    if (!isWasmReady || !viewerRef.current) {
      alert('Engine still initializing, please wait.');
      return;
    }
    const text = await file.text();
    await processIfcContent(file.name, text);
  };

  const showOverlay = isDragging || (!fileName && !isProcessing);

  return (
    <div
      className="app-container"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* ── 3D Viewport ── */}
      <div className="main-view">
        <canvas
          id="webgpu-canvas"
          ref={canvasRef}
          className="webgpu-canvas"
          style={{
            cursor: !hasGeometry
              ? 'default'
              : pointerRef.current.down && pointerRef.current.mode === 'pan'
                ? 'move'
                : 'grab',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={onContextMenu}
        />

        {/* Toolbar overlay */}
        {hasGeometry && (
          <div className="viewport-toolbar">
            <div className="toolbar-pill">
              <Box size={14} />
              <span>{statsText}</span>
            </div>
            <div className="toolbar-pill toolbar-hint">
              <RotateCcw size={14} />
              <span>Drag to orbit · Scroll to zoom</span>
            </div>
          </div>
        )}

        {/* Performance Overlay HUD */}
        {showPerformance && (
          <div className="performance-overlay glass-panel">
            <div className="perf-metric">
              <span className="perf-label">FPS</span>
              <span className="perf-value">{fps.toFixed(2)}</span>
            </div>
            <div className="perf-metric">
              <span className="perf-label">Frame Time</span>
              <span className="perf-value">{frameTime.toFixed(2)} ms</span>
            </div>
          </div>
        )}

        {/* Error banner */}
        {renderError && (
          <div className="error-banner">
            ⚠ {renderError}
          </div>
        )}

        {/* Drop / Welcome Overlay */}
        <div className={`dropzone-overlay${showOverlay ? ' active' : ''}${isDragging ? ' dragging' : ''}`}>
          <div className="drop-message glass-panel">
            <UploadCloud className="icon-upload" />
            <div style={{ textAlign: 'center' }}>
              <h2 style={{ margin: '0 0 0.5rem 0', fontSize: '1.4rem', fontWeight: 700 }}>
                {isDragging ? 'Release to Load' : 'Drop an IFC File'}
              </h2>
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                {isWasmReady
                  ? 'IFC4 / IFC2x3 · WebGPU accelerated'
                  : 'Initializing WebGPU engine…'}
              </p>
            </div>
            {!isWasmReady && (
              <div className="spinner" />
            )}
          </div>
        </div>
      </div>

      {/* ── Metadata Sidebar ── */}
      <div className="sidebar glass-panel">
        <div className="sidebar-header">
          <div>
            <h2 className="sidebar-title">BIM Inspector</h2>
            <div className="sidebar-subtitle">
              {fileName ?? 'No model loaded'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              id="settings-toggle-btn"
              className={`settings-icon-btn${settingsOpen ? ' active' : ''}`}
              onClick={() => setSettingsOpen(o => !o)}
              title="Settings"
              aria-label="Toggle settings"
              aria-expanded={settingsOpen}
            >
              <Settings size={18} />
            </button>
            <Database size={22} color="var(--accent)" />
          </div>
        </div>

        {/* Settings Dropdown */}
        <div className={`settings-dropdown${settingsOpen ? ' open' : ''}`} aria-hidden={!settingsOpen}>
          <div className="settings-dropdown-inner">
            <div className="settings-dropdown-title">Settings</div>
            <label className="settings-label">
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={autoLoadDuplex}
                onChange={(e) => handleAutoLoadToggle(e.target.checked)}
              />
              <span>Auto-load Duplex on startup</span>
            </label>
            <label className="settings-label">
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={showPerformance}
                onChange={(e) => handlePerformanceToggle(e.target.checked)}
              />
              <span>Show performance metrics</span>
            </label>
          </div>
        </div>

        <div className="sidebar-content">
          {isProcessing ? (
            <div className="empty-state">
              <Cpu size={32} color="var(--accent)" className="spin" />
              <div>Parsing IFC model…</div>
            </div>
          ) : !rootNode ? (
            <div className="empty-state">
              <FileBox size={48} color="var(--border-color)" />
              <div style={{ fontSize: '0.85rem' }}>
                Drop an IFC file to inspect its elements and properties.
              </div>
            </div>
          ) : (
            <>
              <div className="entity-count-bar">
                Spatial Structure
              </div>
              <SpatialNodeTree node={rootNode} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
