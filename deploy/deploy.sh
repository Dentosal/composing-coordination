#!/bin/sh
# Builds the server for the VPS (a static Linux binary, cross-compiled here: the VPS is too small to build it),
# updates the checkout there to the pushed master, and restarts the service.
# Needs: rustup target add x86_64-unknown-linux-musl
set -eu
HOST=${HOST:-root@bandgame.dento.fi}
cd "$(dirname "$0")/../server"
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
    cargo build --release --bin band-game --target x86_64-unknown-linux-musl
scp target/x86_64-unknown-linux-musl/release/band-game "$HOST:/opt/bandgame/bin/band-game.new"
ssh "$HOST" 'set -e
    git -C /opt/bandgame pull --ff-only
    chmod 755 /opt/bandgame/bin/band-game.new
    mv /opt/bandgame/bin/band-game.new /opt/bandgame/bin/band-game
    systemctl restart bandgame
    systemctl is-active bandgame'
