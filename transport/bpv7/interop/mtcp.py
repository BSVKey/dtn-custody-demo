"""Minimal MTCP (uD3TN's CLA: a TCP stream of CBOR byte strings, one bundle each).
  python3 mtcp.py send <port> <bundle.hex>     connect and send one bundle
  python3 mtcp.py recv <port> <out.hex> [secs] listen, write the first bundle received
"""
import socket, sys, time
import cbor2

mode, port = sys.argv[1], int(sys.argv[2])
if mode == "send":
    data = bytes.fromhex(open(sys.argv[3]).read().strip())
    with socket.create_connection(("127.0.0.1", port)) as s:
        s.sendall(cbor2.dumps(data))
        time.sleep(2)  # let the CLA read and dispatch before we close
else:
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port)); srv.listen(1); srv.settimeout(float(sys.argv[4]) if len(sys.argv) > 4 else 60)
    conn, _ = srv.accept()

    def read(n):  # exact read: the peer keeps the link open, so never read to EOF
        out = b""
        while len(out) < n:
            chunk = conn.recv(n - len(out))
            if not chunk:
                raise EOFError("MTCP peer closed mid-bundle")
            out += chunk
        return out

    with conn:
        ib = read(1)[0]
        assert ib >> 5 == 2, "MTCP frames are CBOR byte strings"
        ai = ib & 31
        n = ai if ai < 24 else int.from_bytes(read({24: 1, 25: 2, 26: 4, 27: 8}[ai]), "big")
        bundle = read(n)
    open(sys.argv[3], "w").write(bundle.hex())
    print(f"[mtcp] received a {len(bundle)}-byte bundle on :{port}")
