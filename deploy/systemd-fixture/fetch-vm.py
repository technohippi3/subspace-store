#!/usr/bin/env python3
"""Fetch the exact official signed Ubuntu image used by the package fixture."""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request

SHA='406630c08b5e545fcc7209854b129d47e3af822db128c9f19336593b5a2d3fe0'
NAME='ubuntu-24.04-minimal-cloudimg-amd64.img'
BASE='https://cloud-images.ubuntu.com/minimal/releases/noble/release-20261105/'

def digest(path):
    value=hashlib.sha256()
    with path.open('rb') as file:
        while chunk:=file.read(1024*1024):value.update(chunk)
    return value.hexdigest()

def fetch(output):
    output=Path(output)
    if output.exists():
        if not output.is_file() or output.is_symlink() or digest(output)!=SHA:raise RuntimeError('fixture image digest differs')
        return
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ubuntu-image-',dir=output.parent) as temporary:
        root=Path(temporary)
        for name,cap in [('SHA256SUMS',2*1024*1024),('SHA256SUMS.gpg',16384),(NAME,300*1024*1024)]:
            size=0
            with urllib.request.urlopen(BASE+name,timeout=30) as source,(root/name).open('xb') as target:
                while chunk:=source.read(1024*1024):
                    size+=len(chunk)
                    if size>cap:raise RuntimeError('fixture image download exceeded bounds')
                    target.write(chunk)
                target.flush();os.fsync(target.fileno())
        keyring=Path('/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg')
        subprocess.run(['gpgv','--keyring',str(keyring),str(root/'SHA256SUMS.gpg'),str(root/'SHA256SUMS')],check=True,capture_output=True,timeout=30)
        lines=(root/'SHA256SUMS').read_text().splitlines()
        if not any(line.split()[-1].lstrip('*')==NAME and line.split()[0]==SHA for line in lines) or digest(root/NAME)!=SHA:
            raise RuntimeError('official signed image checksum differs')
        os.link(root/NAME,output)
        fd=os.open(output.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args();fetch(args.output)
