"""Cross-check transport/bpv7 against pyd3tn (uD3TN's own BPv7 library).

1. Our bundle (node vector.mjs) is parsed by pyd3tn and re-serialized by pyd3tn: the
   bytes must be identical, which means pyd3tn computes the same CRC-16 and CRC-32C
   values we wrote, and our CBOR is the canonical form it produces.
2. pyd3tn builds a bundle with an unknown block type 224 next to its own extension
   blocks; our decoder must accept it (CRCs verify) and read the fields back.

Usage: python pyd3tn-check.py   (needs pyd3tn and cbor2 on PYTHONPATH)
"""
import json, subprocess, sys, os
import cbor2
from pyd3tn.bundle7 import Bundle, BlockType, CanonicalBlock, CRCType, BlockProcFlag, create_bundle7

# pyd3tn's Python parser only knows the RFC 9171 block types; the uD3TN C node does not
# have this limit (see ud3tn-run.sh). Let the parser carry type 224 as a plain int.
BlockType._value2member_map_[224] = 224

here = os.path.dirname(os.path.abspath(__file__))
node = lambda *a: subprocess.run(["node", os.path.join(here, "vector.mjs"), *a], capture_output=True, text=True, check=True).stdout.strip()

ours = bytes.fromhex(node())
again = bytes(Bundle.parse(ours))
assert again == ours, "pyd3tn re-serialization differs from our bytes"
print(f"1 PASS  pyd3tn re-serializes our {len(ours)}-byte bundle byte for byte (CRC-16 primary, CRC-16/32C blocks, block 224)")

b = create_bundle7("dtn://source/payload", "dtn://dest/payload", b'{"payloadId":"0xp","index":0,"leafHex":"00"}',
                   crc_type_primary=CRCType.CRC32, hop_limit=8, previous_node_eid="dtn://relaya/",
                   crc_type_canonical=CRCType.CRC16)
b.blocks.insert(0, CanonicalBlock(224, cbor2.dumps([json.dumps({"kind": "custody/1"})]), block_number=9,
                block_proc_flags=BlockProcFlag.MUST_BE_REPLICATED, crc_type=CRCType.CRC32))
theirs = bytes(b)
got = json.loads(node(theirs.hex()))
types = [x["type"] for x in got["blocks"]]
assert 224 in types and types[-1] == 1, types
assert got["primary"]["source"] == "dtn://source/payload"
print(f"2 PASS  our decoder accepts pyd3tn's {len(theirs)}-byte bundle, block types {types}, all CRCs verified")
