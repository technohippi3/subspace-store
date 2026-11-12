#!/usr/bin/env python3
"""Fresh, bounded host retrieval with explicit attended recovery selection."""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import ssl
import stat
import re
import urllib.parse
import urllib.request
import urllib.error

from common import ID, Refused, json_file, require
from credential_file import protected


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused("secret-source-redirect")


def validate(config, role):
    require(set(config) == {"version", "source", "endpoint", "projectId", "environment", "roles", "outputRoot", "caFile"} and config["version"] == 1)
    require(config["source"] in ("infisical", "attended") and ID.fullmatch(role) and role in config["roles"])
    endpoint = urllib.parse.urlsplit(config["endpoint"])
    require(endpoint.scheme == "https" and endpoint.hostname and not endpoint.username and
            not endpoint.password and endpoint.path in ("", "/") and not endpoint.query and not endpoint.fragment)
    require(Path(config["outputRoot"]).is_absolute() and str(Path(config["outputRoot"])).startswith("/run/"), "runtime-storage-required")
    require(isinstance(config["roles"][role], dict) and 1 <= len(config["roles"][role]) <= 16)
    for name, reference in config["roles"][role].items():
        require(ID.fullmatch(name) and set(reference) == {"name", "path", "encoding"} and
                ID.fullmatch(reference["name"]) and reference["encoding"] in ("text", "base64-key32") and
                reference["path"].startswith("/") and ".." not in reference["path"].split("/"))


def fetch(config, role, credentials_directory):
    validate(config, role)
    output = Path(config["outputRoot"]) / role
    require(output.parent.is_dir() and not output.parent.is_symlink(), "runtime-storage-required")
    if output.exists():
        require(output.is_dir() and not output.is_symlink(), "unsafe-runtime-directory")
        shutil.rmtree(output)
    output.mkdir(mode=0o700)
    try:
        values = {}
        if config["source"] == "infisical":
            bootstrap = json.loads(protected(Path(credentials_directory) / "bootstrap"))
            require(set(bootstrap) == {"clientId", "clientSecret"} and
                    all(isinstance(x, str) and 1 <= len(x) <= 4096 for x in bootstrap.values()), "invalid-bootstrap")
            context = ssl.create_default_context(cafile=config["caFile"])
            opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))

            def request(path, data=None, token=None):
                body = None if data is None else json.dumps(data).encode()
                headers = {"Content-Type": "application/json"}
                if token:
                    headers["Authorization"] = "Bearer " + token
                message = urllib.request.Request(config["endpoint"].rstrip("/") + path, data=body, headers=headers)
                with opener.open(message, timeout=5) as response:
                    raw = response.read(65537)
                require(len(raw) <= 65536, "oversize-secret-response")
                return json.loads(raw)

            auth = request("/api/v1/auth/universal-auth/login", bootstrap)
            token = auth.get("accessToken")
            require(isinstance(token, str) and 1 <= len(token) <= 16384 and auth.get("tokenType") == "Bearer", "invalid-secret-response")
            for name, reference in config["roles"][role].items():
                query = urllib.parse.urlencode({"projectId": config["projectId"], "environment": config["environment"],
                    "secretPath": reference["path"], "type": "shared", "viewSecretValue": "true",
                    "expandSecretReferences": "false", "includeImports": "false"})
                secret = request("/api/v4/secrets/" + urllib.parse.quote(reference["name"], safe="") + "?" + query, token=token)["secret"]
                require(secret.get("secretKey") == reference["name"] and secret.get("secretPath") == reference["path"] and
                        secret.get("environment") == config["environment"] and secret.get("workspace") == config["projectId"] and
                        secret.get("type") == "shared" and secret.get("secretValueHidden") is False, "secret-scope-mismatch")
                value = secret.get("secretValue")
                require(isinstance(value, str) and 0 < len(value.encode()) <= 16384, "invalid-secret-response")
                values[name] = value.encode()
        else:
            for name in config["roles"][role]:
                values[name] = protected(Path(credentials_directory) / ("offline-" + name))
        for name, value in values.items():
            if config["roles"][role][name]["encoding"] == "base64-key32":
                value = base64.b64decode(value, validate=True)
                require(len(value) == 32, "invalid-recovery-key")
            fd = os.open(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as file:
                file.write(value)
        require(set(p.name for p in output.iterdir()) == set(config["roles"][role]), "incomplete-credentials")
        return {"ok": True, "role": role, "source": config["source"]}
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--role", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(fetch(json_file(args.config), args.role, os.environ["CREDENTIALS_DIRECTORY"])))
    except Exception as error:
        code = (error.code if isinstance(error, Refused) else
                "credential-permission-denied" if isinstance(error, PermissionError) else
                "secret-source-request-refused" if isinstance(error, urllib.error.HTTPError) else
                "secret-source-unavailable" if isinstance(error, urllib.error.URLError) else
                "runtime-bootstrap-missing" if isinstance(error, FileNotFoundError) and Path(error.filename or "").name == "bootstrap" else
                "secret-source-ca-missing" if isinstance(error, FileNotFoundError) and Path(error.filename or "").name.endswith(".pem") else
                "runtime-credential-file-missing" if isinstance(error, FileNotFoundError) else
                "runtime-credential-layout-invalid" if isinstance(error, KeyError) else
                "runtime-credentials-unavailable")
        print(json.dumps({"ok": False, "code": code}))
        raise SystemExit(2)
