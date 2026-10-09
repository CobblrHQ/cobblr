#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null || ! command -v wasm-bindgen >/dev/null; then
  echo 'nesting build needs Rust 1.90 with wasm32-unknown-unknown and wasm-bindgen-cli 0.2.105' >&2
  exit 1
fi
RUSTFLAGS='-C target-feature=+simd128' cargo build --locked --manifest-path modules/digifab/nesting/Cargo.toml --release --target wasm32-unknown-unknown -j 2
mkdir -p modules/digifab/nesting/pkg
wasm-bindgen modules/digifab/nesting/target/wasm32-unknown-unknown/release/cobblr_nesting.wasm --target nodejs --out-dir modules/digifab/nesting/pkg
mv modules/digifab/nesting/pkg/cobblr_nesting.js modules/digifab/nesting/pkg/cobblr_nesting.cjs
# The sources this build came from, so a test can refuse an engine older than its checkout (#5419).
cat modules/digifab/nesting/Cargo.toml modules/digifab/nesting/Cargo.lock modules/digifab/nesting/src/lib.rs | sha256sum | cut -d' ' -f1 > modules/digifab/nesting/pkg/source.sha256
