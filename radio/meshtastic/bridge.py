"""Bridge one Meshtastic radio (USB serial) to radio/lib as newline-delimited hex.

    stdin   "TX <hex>"   send these bytes on the PRIVATE_APP port (256)
    stdout  "RX <hex>"   bytes received on the PRIVATE_APP port
            "UP <node id>" once the radio is connected

Needs the official Python library:  pip install meshtastic
Run by radio/meshtastic.mjs; on its own:  python bridge.py --port COM5
or, for a node on the network (meshtasticd, or a radio on Wi-Fi):  python bridge.py --host 127.0.0.1

Not yet run against real hardware.
"""
import argparse
import sys

import meshtastic.serial_interface
import meshtastic.tcp_interface
from meshtastic import portnums_pb2
from pubsub import pub

PRIVATE_APP = portnums_pb2.PortNum.PRIVATE_APP

ap = argparse.ArgumentParser()
ap.add_argument("--port", help="serial port, e.g. COM5 or /dev/ttyUSB0 (default: first found)")
ap.add_argument("--host", help="connect over TCP (port 4403) instead of serial, e.g. 127.0.0.1 or host:port")
ap.add_argument("--dest", default="^all", help="destination node id, default broadcast")
ap.add_argument("--channel", type=int, default=0, help="channel index to send on")
args = ap.parse_args()


def on_receive(packet, interface):
    d = packet.get("decoded") or {}
    if d.get("portnum") in ("PRIVATE_APP", PRIVATE_APP) and d.get("payload") is not None:
        print("RX " + bytes(d["payload"]).hex(), flush=True)


pub.subscribe(on_receive, "meshtastic.receive")
if args.host:
    host, _, port = args.host.partition(":")
    iface = meshtastic.tcp_interface.TCPInterface(hostname=host, portNumber=int(port or 4403))
else:
    iface = meshtastic.serial_interface.SerialInterface(devPath=args.port)
me = iface.getMyNodeInfo() or {}
print("UP " + str((me.get("user") or {}).get("id", "?")), flush=True)

try:
    for line in sys.stdin:
        line = line.strip()
        if line.startswith("TX "):
            iface.sendData(bytes.fromhex(line[3:]), destinationId=args.dest, portNum=PRIVATE_APP,
                           wantAck=False, channelIndex=args.channel)
finally:
    iface.close()
