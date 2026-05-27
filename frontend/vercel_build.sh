#!/bin/bash

# 1. Install wasm-pack
echo "Installing wasm-pack..."
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# 2. Build your Rust project into WebAssembly
# (Replace './your-rust-folder' with the actual path to your Rust code)
echo "Compiling Rust to WASM..."
wasm-pack build ./your-rust-folder --target web

# 3. Run your standard frontend build 
# (Change to `yarn build` or `pnpm build` if necessary)
echo "Building the frontend..."
npm run build