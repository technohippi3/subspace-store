"""Step records for a regtest run, and the Markdown report.

Every result written here is a regtest result: real bitcoind, spaced and
subs on a local regtest network, driven by harness code. It is not model,
integration or buyer-acceptance evidence, and the report says so.
"""

import json
import time
from pathlib import Path

LABEL = "regtest"


class Report:
    def __init__(self, path):
        self.path = Path(path)
        self.steps = []
        self.findings = []
        self.meta = {"label": LABEL}

    def step(self, scenario, case, what, regtest, model=None, match=None, note="",
             required=None):
        """Record one step. A step compared with the model is required unless
        marked informational (`required=False`). A required step that
        disagrees fails the run."""
        if required is None:
            required = match is not None
        fixed = self.meta.get("comparison_source") == "fixed_spec"
        rec = {"label": LABEL, "scenario": scenario, "case": case, "step": what,
               "regtest": regtest, "expected" if fixed else "model": model, "match": match, "note": note,
               "kind": "required" if required else "informational",
               "t": round(time.time(), 1)}
        self.steps.append(rec)
        mark = {True: "agrees", False: "DISAGREES", None: "-"}[match]
        comparison = "fixed spec" if fixed else "model"
        print(f"[{LABEL}] {scenario} {case or ''} {what}: {_short(regtest)} | {comparison}: {_short(model)} | {mark}",
              flush=True)
        self.save()
        return rec

    def finding(self, fid, text):
        self.findings.append({"id": fid, "text": text})
        print(f"[{LABEL}] finding {fid}: {text}", flush=True)
        self.save()

    def failures(self):
        return [s for s in self.steps if s["kind"] == "required" and s["match"] is False]

    def verdict(self):
        if self.meta.get("error"):
            return "error"
        return "fail" if self.failures() else "pass"

    def exit_code(self):
        """0 pass, 1 a required step disagrees, 2 the run ended in error."""
        return {"pass": 0, "fail": 1}.get(self.verdict(), 2)

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"meta": self.meta, "verdict": self.verdict(),
                                         "steps": self.steps, "findings": self.findings},
                                        indent=1, default=str))

    def markdown(self):
        fixed = self.meta.get("comparison_source") == "fixed_spec"
        lines = [f"# Regtest run report", "",
                 "Every result below is labelled \"regtest\": the pinned bitcoind, spaced and",
                 "subs on a local regtest network, driven by the harness in `regtest/`. None",
                 "of it is model, integration, mainnet or buyer-acceptance evidence.",
                 ("Expectations are fixed specification assertions; no independent model executes in this run." if fixed else
                  "The \"model\" column is what the reference model expects for the same events."),
                 ""]
        lines.append(f"Verdict: {self.verdict()} ({len(self.failures())} required steps disagree).")
        lines.append("")
        for k, v in self.meta.items():
            lines.append(f"- {k}: {v}")
        lines.append("")
        current = None
        for s in self.steps:
            if s["scenario"] != current:
                current = s["scenario"]
                lines += ["", f"## {current}", "",
                          f"| label | case | kind | step | regtest result | {'fixed spec expects' if fixed else 'model expects'} | agree |",
                          "| --- | --- | --- | --- | --- | --- | --- |"]
            agree = {True: "yes", False: "no", None: ""}[s["match"]]
            lines.append(f"| {LABEL} | {s['case'] or ''} | {s['kind']} | {s['step']} | {_cell(s['regtest'])} "
                         f"| {_cell(s['expected'] if fixed else s['model'])} | {agree} |")
        if self.findings:
            lines += ["", "## Findings recorded during the run", ""]
            for f in self.findings:
                lines.append(f"- {f['id']}: {f['text']}")
        return "\n".join(lines) + "\n"


def _short(v):
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    return s if len(s) < 140 else s[:137] + "..."


def _cell(v):
    if v is None:
        return ""
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    s = s.replace("|", "\\|").replace("\n", " ")
    return s if len(s) < 220 else s[:217] + "..."
