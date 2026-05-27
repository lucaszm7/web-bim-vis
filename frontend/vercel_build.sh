#!/bin/bash

# 1. Install wasm-pack
echo "Installing wasm-pack on vercel..."
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

echo "Adding WASM target..."
rustup target add wasm32-unknown-unknown

# 2. Build your Rust project into WebAssembly
# (Replace './your-rust-folder' with the actual path to your Rust code)
echo "Compiling Rust to WASM on vercel..."
wasm-pack build ../ifc-parser-wasm --target web

# 3. Run your standard frontend build 
# (Change to `yarn build` or `pnpm build` if necessary)
echo "Building the frontend..."
npm run build