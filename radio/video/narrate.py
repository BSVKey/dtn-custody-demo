"""Narration for the /radio/ walkthrough: one mp3 per scene, Andrew (en-US-AndrewNeural).

Run inside radio/video/out/ (pip install edge-tts). Writes vo1.mp3 ... vo9.mp3 and vo.json.
"""
import asyncio, json, subprocess
import edge_tts

LINES = [
    "This page sends a Bitcoin B S V payment to someone nearby, with no internet. As a QR code, as sound, or as a text message.",
    "Start with the guide at the top. Each part is a few steps.",
    "Press Try a demo payment. It makes a practice payment, signed but not spendable, and the page checks the signatures right on your phone.",
    "To pay face to face, press Show QR code. The other person opens Get paid, enters their address and the amount, and scans.",
    "Their phone checks it with no internet and shows that it pays them a thousand sats. It waits in their outbox until they have a signal.",
    "No camera? Press Play as sound, and the other phone listens. This has already carried a real payment between two wallets, mined on Bitcoin B S V. The same tones are made for walkie-talkies, A M and F M radio, and phone calls, tested in simulation so far.",
    "Or text the payment to a gateway. Your messaging app opens with it filled in, and only a phone signal is needed. The gateway texts back a signed receipt, and the page checks it.",
    "Faucets work too, and one has run for real. Its coins were announced as sound, heard by an iPhone, and claimed and sent from the phone.",
    "Both are on the chain. The payment carried by sound was mined in block nine seven one, eight four two. The faucet was set up in block nine seven one, eight four five, and its coins were claimed from the phone.",
    "A payment checked offline is like a cheque: correct, but final only once it reaches the network, so wait for the receipt on large amounts. It's free and open source. Try it at d t n dot B S V key dot com slash radio.",
]

async def main():
    out = []
    for i, text in enumerate(LINES, 1):
        path = f"vo{i}.mp3"
        await edge_tts.Communicate(text, "en-US-AndrewNeural", rate="+0%").save(path)
        d = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode().strip())
        out.append({"scene": i, "file": path, "seconds": round(d, 2)})
    json.dump(out, open("vo.json", "w"), indent=1)
    print(json.dumps(out), sum(x["seconds"] for x in out))

asyncio.run(main())
