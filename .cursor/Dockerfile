# Cloud agent image for Kin (projects/kin).
# Matches CI: Node 22.13.0, Rust 1.93.0 + wasm32-unknown-unknown.
# Installs toolchains only. Kin itself has zero third-party dependencies.
FROM node:22.13.0-bookworm

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git sudo \
 && rm -rf /var/lib/apt/lists/* \
 && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.93.0 \
 && rustup component add rustfmt clippy \
 && rustup target add wasm32-unknown-unknown \
 && chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME" \
 && rustc --version && cargo --version && node --version
