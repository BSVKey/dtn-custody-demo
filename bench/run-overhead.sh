#!/usr/bin/env bash
# Runs inside bench/Dockerfile.overhead. Arguments are passed to bench/overhead.mjs.
set -euo pipefail
cd /app
T=/opt/tweetnacl
ARCH=$(uname -m)
echo "[overhead] $ARCH, $(nproc) CPUs visible, $(gcc --version | head -1), libsodium $(dpkg-query -W -f='${Version}' libsodium-dev), node $(node --version)"
echo "[overhead] CPU: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //' || true)"
gcc -std=c99 -O2 -c $T/tweetnacl.c -o /tmp/tweetnacl.o
gcc -std=c99 -D_POSIX_C_SOURCE=199309L -O2 -Wall -Wextra -Werror -DUSE_TWEETNACL -I$T -Iflight -o /tmp/bench-tweetnacl \
    bench/overhead.c flight/custody.c flight/sha256.c /tmp/tweetnacl.o
gcc -std=c99 -D_POSIX_C_SOURCE=199309L -O2 -Wall -Wextra -Werror -DUSE_SODIUM -Iflight -o /tmp/bench-sodium \
    bench/overhead.c flight/sha256.c -lsodium
echo "C_RESULT $(/tmp/bench-tweetnacl)"
echo "C_RESULT $(/tmp/bench-sodium)"
node bench/overhead.mjs "$@"
