#!/usr/bin/env bash
set -uo pipefail
cd /app/flight
T=/opt/tweetnacl
echo "[flight] TweetNaCl sha256:"; (cd $T && sha256sum tweetnacl.c tweetnacl.h | sed 's/^/          /')
# Our code builds warning-free under -Wall -Wextra -Werror; upstream TweetNaCl is compiled unmodified.
gcc -std=c99 -O2 -c $T/tweetnacl.c -o /tmp/tweetnacl_host.o || exit 1
gcc -std=c99 -D_POSIX_C_SOURCE=199309L -O2 -Wall -Wextra -Werror -I$T -I. -o /tmp/vectors vectors.c custody.c sha256.c /tmp/tweetnacl_host.o || exit 1
/tmp/vectors > /tmp/out.json || { echo "vectors program failed"; exit 1; }
node check.mjs < /tmp/out.json; CODE=$?
echo "[flight] ARM Cortex-M4 (arm-none-eabi-gcc -Os -mthumb), code and data per object:"
for f in custody.c sha256.c $T/tweetnacl.c; do arm-none-eabi-gcc -std=c99 -Os -mcpu=cortex-m4 -mthumb -ffunction-sections -I$T -I. -c "$f" -o "/tmp/$(basename "$f" .c).o" || exit 1; done
arm-none-eabi-size -t /tmp/custody.o /tmp/sha256.o /tmp/tweetnacl.o | sed 's/^/          /'
echo "=== FLIGHT exit: $CODE ==="
exit "$CODE"
