import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasmPack from 'vite-plugin-wasm-pack';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wasmPack("../ifc-parser-wasm")],
  optimizeDeps: {
    exclude: ['./src/wasm/ifc_parser_wasm.js'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
