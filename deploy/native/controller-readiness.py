#!/usr/bin/env python3
"""Reduce the actual attended runner's recovery proof to a packaging receipt."""
import argparse
import json
from pathlib import Path
import sys
import importlib.util
from common import command, config, json_file, require

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        value = config(args.config)
        release = Path(value["currentPath"]).resolve(strict=True)
        sys.path.insert(0, str(release / "app"))
        from runner.cli import build
        from controller.recovery_backend import acknowledged_controller_position
        from host import maintenance
        command(['/usr/bin/systemctl','start','subspace-secrets-'+value['installation']+'-maintenance.service'],timeout=35)
        runner = build(json_file(value["runnerConfig"]))
        try:
            status=runner.store.status();seller=status.get('seller') or {};spaces=seller.get('spaces') or []
            bootstrap=seller.get('explicit_limits') is not True or not spaces
            runtime=json_file(value['storeConfig'])
            expected={'version':1,'network':runtime['network'],'wallet':runtime['core']['wallet'],**runtime['installation']}
            require(status.get('installation_identity')==expected and status.get('acknowledged') is True,'store-identity-not-acknowledged')
            if bootstrap:
                require(status.get('paused') is True,'seller-bootstrap-must-stay-paused')
                spec=importlib.util.spec_from_file_location('native_preflight',Path(__file__).with_name('host-preflight.py'))
                module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.preflight(value)
            else:
                require(runner.networks().get("ok") is True, "controller-network-not-ready")
            report = runner.recovery() if runner.c.recovery_state() is not None else runner.c.recovery_report()
            require(report.get("ready") is True and not runner.c.journal.down(), "controller-not-reconciled")
            require(getattr(runner.c,'recovery_backend',None) is not None,'offhost-controller-required')
            acknowledged_controller_position(runner.c.db,runner.c.recovery_backend)
            require(maintenance(value)["acknowledged"] is True, "store-not-acknowledged")
        finally:
            runner.publisher.db.close()
            runner.c.close()
        print(json.dumps({"ready": True, "acknowledged": True,'productionReady':not bootstrap,'waitingSellerSetup':bootstrap,
            'diagnostic':'waiting-seller-setup' if bootstrap else 'ready'}))
    except Exception:
        print(json.dumps({"ready": False, "acknowledged": False}))
        raise SystemExit(2)
