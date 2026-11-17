#!/usr/bin/env python3
"""
Stdlib WebSocket client to verify the echo server end-to-end.
Run the server first, then:  python3 tests/test_client.py [--port 8765]
Exits 0 on pass, 1 on fail.
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys


def ws_connect(host, port):
    sock = socket.create_connection((host, port), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET / HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += sock.recv(4096)
    assert b"101" in resp.split(b"\r\n")[0], f"handshake failed: {resp[:200]}"
    return sock


def ws_send(sock, text):
    payload = text.encode()
    mask = os.urandom(4)
    header = bytearray([0x81])
    length = len(payload)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack(">H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack(">Q", length))
    header.extend(mask)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def _read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def ws_recv(sock):
    b1, b2 = _read_exact(sock, 2)
    length = b2 & 0x7F
    if length == 126:
        (length,) = struct.unpack(">H", _read_exact(sock, 2))
    elif length == 127:
        (length,) = struct.unpack(">Q", _read_exact(sock, 8))
    payload = _read_exact(sock, length) if length else b""
    return payload.decode()


def rpc_call(sock, method, params, req_id):
    ws_send(sock, json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": req_id}))
    return json.loads(ws_recv(sock))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    failures = 0
    def check(name, got, expected):
        nonlocal failures
        ok = got == expected
        print(f"{'PASS' if ok else 'FAIL'}  {name}: got={got!r} expected={expected!r}")
        if not ok:
            failures += 1

    sock = ws_connect(args.host, args.port)
    try:
        r = rpc_call(sock, "echo", "hello", 1)
        check("echo string 'hello'", r.get("result"), "hello")
        check("echo preserves id", r.get("id"), 1)

        r = rpc_call(sock, "echo", {"message": "hello"}, 2)
        check("echo object", r.get("result"), {"message": "hello"})

        r = rpc_call(sock, "ping", None, 3)
        check("ping", r.get("result"), "pong")

        r = rpc_call(sock, "no_such_method", None, 4)
        check("unknown method error code", (r.get("error") or {}).get("code"), -32601)
    finally:
        sock.close()

    print("ALL PASS" if failures == 0 else f"{failures} FAILURES")
    sys.exit(0 if failures == 0 else 1)


if __name__ == "__main__":
    main()
