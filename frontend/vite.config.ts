import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

function wasmPlugin(): Plugin {
  const rustSrcDir = path.resolve(process.cwd(), '../ifc-parser-wasm/src');
  const wasmSource = path.resolve(process.cwd(), '../ifc-parser-wasm/pkg/ifc_parser_wasm_bg.wasm');
  const wasmDest = path.resolve(process.cwd(), 'public/ifc_parser_wasm_bg.wasm');

  const isDev = !process.argv.includes('build');

  const buildWasm = () => {
    console.log('\n[wasmPlugin] Building Rust WASM project...');
    try {
      execSync('wasm-pack build ../ifc-parser-wasm --target web', { stdio: 'inherit' });
      console.log('[wasmPlugin] Build successful!\n');
    }
    catch (err) {
      console.error('\n[wasmPlugin] Build failed:', err, '\n');
    }
  };

  const copyWasm = () => {
    try {
      if (fs.existsSync(wasmSource)) {
        const destDir = path.dirname(wasmDest);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(wasmSource, wasmDest);
        console.log('[wasmPlugin] Automatically copied ifc_parser_wasm_bg.wasm to public/\n');
      }
    } catch (err) {
      console.error('\n[wasmPlugin] Failed to copy WASM file:', err, '\n');
    }
  };

  return {
    name: 'wasm-plugin',
    buildStart() {
      if (isDev) {
        buildWasm();
      }
      copyWasm();
    },
    configureServer(server) {
      server.watcher.add(rustSrcDir);
      server.watcher.add(wasmSource);

      let isBuilding = false;
      server.watcher.on('all', async (_event, filePath) => {
        const normalizedPath = path.normalize(filePath);

        if (normalizedPath.startsWith(path.normalize(rustSrcDir)) && filePath.endsWith('.rs')) {
          if (isBuilding) {
            console.log(`\n[wasmPlugin] Already building. Skipping...`);
            return;
          }
          isBuilding = true;
          console.log(`\n[wasmPlugin] Rust file changed: ${path.basename(filePath)}. Rebuilding WASM...`);
          try {
            buildWasm();
            copyWasm();
          } catch (e) {
            // Error logged in buildWasm
          } finally {
            isBuilding = false;
          }
        }

        if (filePath.endsWith('.wgsl')) {
          console.log(`\n[wasmPlugin] Shader file changed: ${path.basename(filePath)}. Sending custom HMR update...`);
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            server.hot.send({
              type: 'custom',
              event: 'shader-update',
              data: { code: content }
            });
          } catch (e) {
            console.error('[wasmPlugin] Failed to read shader file for hot-reload:', e);
          }
        }

        if (normalizedPath === path.normalize(wasmSource)) {
          server.hot.send({ type: 'full-reload' });
        }
      });
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wasmPlugin()],
  server: {
    fs: {
      allow: ['..']
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
