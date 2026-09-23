#!/usr/bin/env python3
"""Build a reviewable WhatSync extension and backend release candidate."""
from pathlib import Path
import base64
import hashlib
import json
import re
import shutil
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text())
version = manifest["version"]
project = "ogsvchujqpayuckxuwdf"

assert manifest.get("version_name") == version, "Manifest display version must match version"
assert "default_popup" not in manifest.get("action", {}), "Detached popup must not ship"

config = (root / "config.js").read_text()
assert project in config, "Extension targets the wrong backend"
for token in re.findall(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", config):
    payload = token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert claims.get("role") == "anon" and claims.get("ref") == project, "Unsafe browser key"

subprocess.run(["node", "--check", "background.js"], cwd=root, check=True)
subprocess.run(["node", "--check", "content.js"], cwd=root, check=True)
test_files = sorted(str(path.relative_to(root)) for path in (root / "tests").glob("*.test.cjs"))
subprocess.run(["node", "--test", *test_files], cwd=root, check=True)
subprocess.run(["bash", "package-extension.sh"], cwd=root, check=True)

extension_zip = root / "dist" / f"whatsync-{version}.zip"
with zipfile.ZipFile(extension_zip) as archive:
    names = set(archive.namelist())
    required = {
        "manifest.json", "background.js", "contact-intelligence.js", "content.js",
        "content.css", "config.js", "dashboard-bridge.js",
    }
    assert required <= names, f"Missing extension files: {sorted(required - names)}"
    forbidden = {"popup.html", "popup.js", "supabase.js", "email-confirm.html"}
    assert not (forbidden & names), f"Dead files shipped: {sorted(forbidden & names)}"
    assert not any(".env" in name or ".git/" in name or name.startswith("supabase/") for name in names)

output = root / "dist" / f"whatsync-{version}-candidate"
if output.exists():
    shutil.rmtree(output)
output.mkdir(parents=True)
shutil.copy2(extension_zip, output)

backend_zip = output / "backend-source.zip"
with zipfile.ZipFile(backend_zip, "w", zipfile.ZIP_DEFLATED) as archive:
    for base in (root / "supabase" / "functions", root / "supabase" / "migrations"):
        if not base.exists():
            continue
        for file in base.rglob("*"):
            if file.is_file() and file.name != ".DS_Store":
                archive.write(file, file.relative_to(root))

checks = {
    str(file.relative_to(output)): hashlib.sha256(file.read_bytes()).hexdigest()
    for file in output.rglob("*") if file.is_file() and file.name != "release-manifest.json"
}
(output / "release-manifest.json").write_text(json.dumps({
    "version": version,
    "status": "READY_FOR_REVIEW",
    "backendProject": project,
    "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "sha256": checks,
}, indent=2) + "\n")

candidate_zip = Path(shutil.make_archive(str(root / "dist" / f"whatsync-{version}-candidate"), "zip", output))
print(output)
print(candidate_zip)
