#!/usr/bin/env bash
# Our custody payload through JPL ION, routed by contact graph routing over a contact plan
# compiled by contact-plans/compile.mjs. Node 1 -> node 2 is scheduled down from 15 s to
# 35 s; the payload is sent at about 18 s, so ION must hold it and forward it at 35 s.
# Each ION node runs in its own IPC namespace (ION state lives in SysV shared memory).
set -uo pipefail
cd /app
node contact-plans/compile.mjs ion/interop.json --ion /tmp/contacts.ionrc
echo "[ion] contact plan compiled -> ionadmin commands (ION $(cat /opt/ion/COMMIT)):"
grep '^a ' /tmp/contacts.ionrc | sed 's/^/        /'
node ion/prepare.mjs
N=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/pins.json","utf8")).chunks + 1)')

mk_node() { # node peer myport peerport
  local n=$1 p=$2 mp=$3 pp=$4 d=/tmp/n$1
  mkdir -p "$d/recv"
  printf 'configFlags 1\nwmSize 5000000\nheapWords 2500000\npathName %s\n' "$d" > "$d/node.ionconfig"
  {
    echo "## begin ionadmin"
    echo "1 $n $d/node.ionconfig"
    echo "s"
    echo "a contact +0 +3600 $n $n 12500000"
    echo "a range +0 +3600 $n $n 0"
    grep '^a ' /tmp/contacts.ionrc
    echo "m horizon +0"
    echo "## end ionadmin"
    echo "## begin bpadmin"
    echo "1"
    echo "a scheme ipn 'ipnfw' 'ipnadminep'"
    echo "a endpoint ipn:$n.1 q"
    echo "a endpoint ipn:$n.2 q"
    echo "a protocol udp"
    echo "a induct udp 127.0.0.1:$mp udpcli"
    echo "a outduct udp 127.0.0.1:$mp udpclo"
    echo "a outduct udp 127.0.0.1:$pp udpclo"
    echo "s"
    echo "## end bpadmin"
    echo "## begin ipnadmin"
    echo "a plan $n udp/127.0.0.1:$mp"
    echo "a plan $p udp/127.0.0.1:$pp"
    echo "## end ipnadmin"
  } > "$d/node.rc"
}
mk_node 1 2 4556 4557
mk_node 2 1 4557 4556

# Receiver: ION node 2, bprecvfile saves each file it receives (testfile1, testfile2, ...).
unshare --ipc --fork bash -c "cd /tmp/n2 && ionstart -I node.rc >/tmp/n2/start.log 2>&1 && cd recv && timeout 90 bprecvfile ipn:2.1 $N >/tmp/n2/recv.log 2>&1; cd /tmp/n2 && ionstop >/dev/null 2>&1" & R=$!
sleep 3

# Sender: ION node 1. Contacts are relative to its start (t0); send at +18 s, inside the gap.
unshare --ipc --fork bash -c "
  cd /tmp/n1 && date +%s%3N > /tmp/t0 && ionstart -I node.rc >/tmp/n1/start.log 2>&1
  sleep 18; date +%s%3N > /tmp/tsend
  echo \"[ion] sending at +\$(( (\$(cat /tmp/tsend) - \$(cat /tmp/t0)) / 1000 )) s, inside the scheduled gap (15 s to 35 s)\"
  for f in /tmp/send/*; do bpsendfile ipn:1.2 ipn:2.1 \"\$f\" >>/tmp/n1/send.log 2>&1; done
  echo \"[ion] node 1 queued \$(ls /tmp/send | wc -l) files; holding for the contact at +35 s\"
  sleep 40; ionstop >/dev/null 2>&1" & S=$!
wait "$S"; wait "$R"
echo "[ion] received files: $(find /tmp/n2/recv -type f | wc -l)"
node ion/verify.mjs; CODE=$?
if [ "$CODE" != "0" ]; then for f in /tmp/n1/start.log /tmp/n1/send.log /tmp/n1/ion.log /tmp/n2/recv.log /tmp/n2/ion.log; do echo "--- $f (tail)"; tail -15 "$f" 2>/dev/null; done; fi
echo "=== ION exit: $CODE ==="
exit "$CODE"
