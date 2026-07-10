#!/usr/bin/env python3
"""Install a CA certificate into a rooted Android device/emulator's SYSTEM trust store.

Android reads /system/etc/security/cacerts/<subject_hash_old>.0 as **PEM**. If you push a
DER file there, conscrypt/BoringSSL silently skips it, so Chrome, native apps, and Flutter
never trust it (even though it shows in Settings > Trusted credentials). This script
normalizes the cert to PEM, names it correctly, and installs it over adb.

Usage:
    python install-android-ca.py [path/to/ca.crt] [--serial EMULATOR-SERIAL]

  - Omit the path and it auto-finds GAZE's proxy CA under %APPDATA%.
  - Accepts PEM or DER input (auto-detected and converted to PEM).

Requires: `adb` and `openssl` on PATH, and a ROOTED device (adb root must succeed —
LDPlayer, Genymotion, and AOSP emulators are rooted by default).
"""
from __future__ import annotations
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time

# Common locations of GAZE's exported/persisted CA (per-workspace channel names).
APPDATA = os.environ.get("APPDATA", os.path.expanduser("~/AppData/Roaming"))
DEFAULT_CANDIDATES = [
    os.path.join(APPDATA, p, "proxy-ca", "gaze-ca.crt")
    for p in ("ai.opencode.desktop.dev", "ai.opencode.desktop", "OpenCode Dev", "OpenCode")
]


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def find_default_ca() -> str | None:
    return next((p for p in DEFAULT_CANDIDATES if os.path.isfile(p)), None)


def to_pem(src: str) -> str:
    """Return the cert as PEM text, accepting PEM or DER input."""
    for inform in ("PEM", "DER"):
        r = run(["openssl", "x509", "-inform", inform, "-in", src, "-outform", "PEM"])
        if r.returncode == 0 and "BEGIN CERTIFICATE" in r.stdout:
            return r.stdout
    die(f"{src} is not a parseable X.509 certificate")
    return ""  # unreachable


def subject_hash_old(pem_text: str) -> str:
    """OpenSSL's legacy subject hash — the filename Android's store indexes CAs by."""
    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
        f.write(pem_text)
        tmp = f.name
    try:
        r = run(["openssl", "x509", "-in", tmp, "-noout", "-subject_hash_old"])
        if r.returncode != 0:
            die("openssl -subject_hash_old failed: " + r.stderr.strip())
        return r.stdout.strip()
    finally:
        os.unlink(tmp)


def adb(base_args: list[str], extra: list[str]) -> subprocess.CompletedProcess:
    return run(["adb", *base_args, *extra])


def main() -> None:
    ap = argparse.ArgumentParser(description="Install a CA into a rooted Android system trust store (PEM).")
    ap.add_argument("cert", nargs="?", help="CA cert file (PEM or DER). Defaults to GAZE's CA.")
    ap.add_argument("--serial", help="adb device serial (e.g. emulator-5554); optional if only one device.")
    args = ap.parse_args()

    for tool in ("adb", "openssl"):
        if not shutil.which(tool):
            die(f"{tool} not found on PATH")

    cert = args.cert or find_default_ca()
    if not cert:
        die("no cert given and GAZE CA not found; pass the path explicitly")
    if not os.path.isfile(cert):
        die(f"no such file: {cert}")

    base = ["-s", args.serial] if args.serial else []

    state = adb(base, ["get-state"])
    if "device" not in (state.stdout + state.stderr):
        die("no device/emulator connected (adb get-state: " + (state.stdout + state.stderr).strip() + ")")

    pem = to_pem(cert)
    h = subject_hash_old(pem)
    fname = f"{h}.0"
    print(f"cert:  {cert}")
    print(f"hash:  {h}  ->  {fname}  (PEM)")

    with tempfile.NamedTemporaryFile("w", suffix=".0", delete=False, newline="\n") as f:
        f.write(pem)
        local = f.name

    try:
        print("elevating adb + remounting system rw ...")
        adb(base, ["root"])
        time.sleep(2)
        adb(base, ["shell", "mount -o rw,remount / 2>/dev/null; mount -o rw,remount /system 2>/dev/null; true"])

        remote_tmp = f"/sdcard/{fname}"
        push = adb(base, ["push", local, remote_tmp])
        if push.returncode != 0:
            die("adb push failed: " + push.stderr.strip())

        dest = f"/system/etc/security/cacerts/{fname}"
        install_cmd = (
            f"cp {remote_tmp} {dest} && chmod 644 {dest} && chown root:root {dest} "
            f"&& (chcon u:object_r:system_file:s0 {dest} 2>/dev/null || true) "
            f"&& rm -f {remote_tmp} && echo INSTALL_OK || echo INSTALL_FAIL"
        )
        res = adb(base, ["shell", install_cmd])
        out = (res.stdout + res.stderr).strip()
        if "INSTALL_OK" not in out:
            die("install failed (need root?): " + out)

        tail = adb(base, ["shell", f"tail -c 30 {dest}"])
        if "END CERTIFICATE" not in tail.stdout:
            die("installed file is not PEM — something went wrong")

        print(f"installed: {dest}")
        print("done. Reboot the emulator/device so apps re-read the trust store:")
        serial_arg = f" -s {args.serial}" if args.serial else ""
        print(f"    adb{serial_arg} reboot")
    finally:
        os.unlink(local)


if __name__ == "__main__":
    main()
