import React, { useState, useRef, useEffect, useCallback } from 'react';
import { UploadCloud, FileBox, Database, ChevronDown, ChevronRight, Cpu, Box, RotateCcw } from 'lucide-react';
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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<IfcViewer | null>(null);
  const rafRef = useRef<number>(0);
  const dragCounterRef = useRef(0);

  // Pointer state for orbit controls
  const pointerRef = useRef({ down: false, lastX: 0, lastY: 0 });

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

  // ── Render Loop ───────────────────────────────────────────────────────────
  const startRenderLoop = (viewer: IfcViewer) => {
    const loop = () => {
      try {
        viewer.render();
      } catch (e: any) {
        // Ignore transient surface errors like "lost"
        if (!String(e).includes('Lost') && !String(e).includes('Timeout')) {
          console.warn('Render error:', e);
        }
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

  // ── Orbit Controls ────────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!hasGeometry) return;
    pointerRef.current = { down: true, lastX: e.clientX, lastY: e.clientY };
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [hasGeometry]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = pointerRef.current;
    if (!p.down || !viewerRef.current) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    viewerRef.current.orbit_camera(dx, dy);
  }, []);

  const onPointerUp = useCallback(() => {
    pointerRef.current.down = false;
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!viewerRef.current) return;
    e.preventDefault();
    viewerRef.current.zoom_camera(e.deltaY);
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
    setFileName(file.name);
    setIsProcessing(true);
    setRootNode(null);
    setHasGeometry(false);
    setRenderError(null);

    try {
      const text = await file.text();

      // 1. Load geometry into WebGPU
      try {
        viewerRef.current.load_ifc_geometry(text);
        setHasGeometry(true);
      } catch (geoErr: any) {
        console.warn('Geometry loading partial/failed:', geoErr);
        // Continue — at minimum show metadata
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
          style={{ cursor: hasGeometry ? 'grab' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
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
          <Database size={22} color="var(--accent)" />
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
