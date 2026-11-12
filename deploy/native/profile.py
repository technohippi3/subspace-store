#!/usr/bin/env python3
"""Generate the single supported native profile from explicit operator inputs."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
from common import atomic_json, json_file, require

PROFILE='existing-native-linux-x86_64-systemd255'

def generate(source, destination):
    p=json_file(source);destination=Path(destination)
    require(not destination.exists(),'configuration-never-overwrites')
    require(set(p)=={'profile','installation','network','publicOrigin','tlsCAFile','core','spaced','proverUrl','relayUrl','ports','limits',
        'minimumFeeRateSatVb','maximumFeeRateSatVb','riskBudgetSats','refundPolicy','merchantDestinations','recovery','secrets','certificateTTLSeconds'},'explicit-profile-inputs-required')
    require(p['profile']==PROFILE and p['network'] in ('mainnet','regtest'),'unsupported-profile')
    from common import ID
    require(ID.fullmatch(p['installation']),'invalid-installation')
    require(set(p['ports'])=={'buyer','operator','registry','subs','https'} and all(type(v) is int and 1<=v<=65535 for v in p['ports'].values())
        and len(set(p['ports'].values()))==5,'invalid-ports')
    require(set(p['limits'])=={'windowSeconds','maximumRequests','maximumOrders'} and
        all(type(v) is int and v>0 for v in p['limits'].values()) and p['limits']['maximumOrders']<=10000,'unqualified-retained-order-capacity')
    require(type(p['minimumFeeRateSatVb']) is int and 0<p['minimumFeeRateSatVb']<=p['maximumFeeRateSatVb'] and
        type(p['maximumFeeRateSatVb']) is int,'explicit-fee-range-required')
    require(set(p['core'])=={'url','cookiePath','wallet','genesis','descriptorHash'} and
        set(p['spaced'])=={'url','cookiePath','operatorWallet','space'},'explicit-native-wallets-required')
    require(re.fullmatch('[0-9a-f]{64}',p['core']['genesis']) and re.fullmatch('[0-9a-f]{64}',p['core']['descriptorHash']) and
        re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',p['core']['wallet']) and
        re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',p['spaced']['operatorWallet']) and
        re.fullmatch('[a-z0-9][a-z0-9-]{0,62}',p['spaced']['space']),'explicit-native-wallets-required')
    for node in (p['core'],p['spaced']):
        url=urlsplit(node['url']); require(url.scheme=='http' and url.hostname in ('127.0.0.1','::1') and url.username is None and url.password is None and not url.query and not url.fragment)
        require(Path(node['cookiePath']).is_absolute())
    public=urlsplit(p['publicOrigin']);require(public.scheme=='https' and public.hostname and public.path in ('','/') and
        public.username is None and public.password is None and not public.query and not public.fragment,'trusted-origin-required')
    for field in ('relayUrl','proverUrl'):
        endpoint=urlsplit(p[field]);require(endpoint.scheme in ('http','https') and endpoint.hostname and endpoint.username is None and endpoint.password is None and
            not endpoint.query and not endpoint.fragment and endpoint.path in ('','/'),'inline-credentials-refused')
    secret_endpoint=urlsplit(p['secrets']['endpoint']);require(secret_endpoint.scheme=='https' and secret_endpoint.hostname and secret_endpoint.username is None and
        secret_endpoint.password is None and not secret_endpoint.query and not secret_endpoint.fragment and secret_endpoint.path in ('','/'),'inline-credentials-refused')
    remote=p['recovery']
    require(isinstance(remote,dict) and set(remote)=={'host','port','user','knownHostsFile'},'recovery-references-only')
    require(isinstance(remote['host'],str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}',remote['host']) and
        isinstance(remote['user'],str) and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}',remote['user']) and
        type(remote['port']) is int and 1<=remote['port']<=65535 and
        isinstance(remote['knownHostsFile'],str) and Path(remote['knownHostsFile']).is_absolute() and
        len(remote['knownHostsFile'])<=4096 and '\0' not in remote['knownHostsFile'],'invalid-recovery-reference')
    require((public.port or 443)==p['ports']['https'],'public-port-mismatch')
    identifier=p['installation'];base=f'/srv/subspace-store/{identifier}';etc=f'/etc/subspace-store/{identifier}'
    current=f'/opt/subspace-store/{identifier}/current';lock=base+'/lifecycle/maintenance.lock';secretRoot=f'/run/subspace-secrets-{identifier}'
    credential=lambda role,name:f'/run/credentials/subspace-{identifier}-{role}.service/{name}'
    backend=lambda role:{'version':1,'node':current+'/bin/node','client':current+'/client/client.mjs','config':etc+f'/recovery-{role}.json'}
    ports=p['ports'];origin=p['publicOrigin'].rstrip('/')
    runtime={'version':2,'network':'main' if p['network']=='mainnet' else 'regtest','maintenanceLock':lock,
      'installation':{key:p['core'][key] for key in ('genesis','descriptorHash')},'database':base+'/store/store.db','journalDirectory':base+'/legacy-unused-store-journal',
      'listen':{'buyer':ports['buyer'],'operator':ports['operator'],'subs':ports['registry']},
      'core':{'url':p['core']['url'],'wallet':p['core']['wallet'],'cookiePath':credential('store','core-cookie')},
      'credentials':{'operator':credential('store','operator-token'),'subs':credential('store','registry-token')},
      'recoveryBackend':backend('store'),'riskBudgetSats':p['riskBudgetSats'],'refundPolicy':p['refundPolicy'],'merchantDestinations':p['merchantDestinations'],
      'pollMilliseconds':2000,'certificateExport':{'trustedOrigin':origin,'binary':current+'/bin/subspace-export',
        'artifactManifest':current+'/share/native/subspace-export.manifest.json','directory':base+'/store/exports','ttlSeconds':p['certificateTTLSeconds'],
        'spaced':{'url':p['spaced']['url'],'cookiePath':credential('store','spaced-cookie')}}}
    runner={'version':2,'network':p['network'],'maintenance_lock':lock,'recovery_backend':backend('maintenance'),
      'store':{'implementation':'typescript','url':f"http://127.0.0.1:{ports['operator']}",'operator_token_file':secretRoot+'/maintenance/operator-token',
        'db':runtime['database'],'journal_dir':runtime['journalDirectory']},
      'controller':{'dir':base+'/controller','journal_dir':base+'/legacy-unused-controller-journal','journal_name':'runner',
        'operator_wallet':p['spaced']['operatorWallet'],'snapshot_dir':base+'/runtime-checkpoints'},
      'bitcoind':{'url':p['core']['url'],'cookie_file':p['core']['cookiePath']},'spaced':{'url':p['spaced']['url'],'cookie_file':p['spaced']['cookiePath']},
      'subs':{'url':f"http://127.0.0.1:{ports['subs']}",'write_url':f"http://127.0.0.1:{ports['subs']}",'data_dir':base+'/subs',
        'stop_command':['/usr/bin/python3',current+'/native/subs-fence.py','--config',etc+'/installation.json','stop'],
        'start_command':['/usr/bin/python3',current+'/native/subs-fence.py','--config',etc+'/installation.json','start'],'command_timeout':40,'ready_timeout':120,'capabilities':{'attach_txid':True}},
      'relay':{'url':p['relayUrl']},'verifier':current+'/bin/subspace-verifier'}
    if p['network']=='mainnet':runner['public_pilot']={'version':1,'space':p['spaced']['space'],'minimum_fee_rate_sat_vb':p['minimumFeeRateSatVb'],'maximum_fee_rate_sat_vb':p['maximumFeeRateSatVb']}
    roles={'store':['operator-token','registry-token','recovery-ssh-key','recovery-key'],'subs':['registry-token'],'proxy':['tls-cert','tls-key'],
      'maintenance':['operator-token','registry-token','recovery-ssh-key','recovery-key']}
    secrets={'version':1,'source':'infisical','endpoint':p['secrets']['endpoint'],'projectId':p['secrets']['projectId'],'environment':p['secrets']['environment'],
      'outputRoot':secretRoot,'caFile':p['secrets']['caFile'],'roles':{role:{name:{'name':name,'path':p['secrets']['path'],
        'encoding':'base64-key32' if name=='recovery-key' else 'text'} for name in names} for role,names in roles.items()}}
    services={role:{'user':f'subspace-{role}','group':f'subspace-{role}','credentials':{},'command':[]} for role in ('store','subs','proxy')}
    services['store'].update(command=['bin/node','app/ts/src/main.ts',etc+'/store.json'],credentials={name:name for name in roles['store']},
      externalCredentials={'core-cookie':p['core']['cookiePath'],'spaced-cookie':p['spaced']['cookiePath']})
    services['subs'].update(command=['/usr/bin/python3','native/subs-start.py','--config',etc+'/installation.json'],credentials={'registry-token':'registry-token'},
      externalCredentials={'spaced-cookie':p['spaced']['cookiePath']})
    services['proxy'].update(command=['bin/node','native/proxy.mjs','--serve',etc+'/installation.json'],credentials={'tls-cert':'tls-cert','tls-key':'tls-key'})
    installation={'version':1,'profile':PROFILE,'installation':identifier,'network':p['network'],'baseDirectory':base,'releaseDirectory':f'/opt/subspace-store/{identifier}/releases',
      'currentPath':current,'runtimeDirectory':f'/run/subspace-store-{identifier}','trustKey':etc+'/release-trust.pem','storeConfig':etc+'/store.json','runnerConfig':etc+'/runner.json',
      'secretsConfig':etc+'/secrets.json','recoveryConfig':etc+'/recovery-maintenance.json','walletBackupDirectory':base+'/onboarding','minimumFreeBytes':20*1024**3,
      'services':services,'commands':{name:['/usr/bin/python3','${RELEASE}/native/'+file,'--config','${INSTALLATION_CONFIG}'] for name,file in
        [('preflight','host-preflight.py'),('reconcile','reconcile.py'),('controllerReadiness','controller-readiness.py')]},
      'operator':{'url':runner['store']['url'],'credentialFile':secretRoot+'/maintenance/operator-token'},'publicOrigin':origin,
      'tls':{'certificateFile':secretRoot+'/proxy/tls-cert','privateKeyFile':secretRoot+'/proxy/tls-key','caFile':p['tlsCAFile'],'listenPort':ports['https'],'listenAddress':'0.0.0.0'},
      'nativeRpc':{'core':{key:p['core'][key] for key in ('url','wallet','cookiePath')},'spaced':{key:p['spaced'][key] for key in ('url','cookiePath')}},'proverUrl':p['proverUrl']}
    recovery={**p['recovery'],'version':1,'installation':identifier,'identityFile':'','encryptionKeyFile':'','connectTimeoutSeconds':5,'operationTimeoutSeconds':30}
    destination.mkdir(mode=0o755,parents=True)
    for name,value in [('installation',installation),('store',runtime),('runner',runner),('secrets',secrets)]:atomic_json(destination/(name+'.json'),value);(destination/(name+'.json')).chmod(0o644)
    for role in ('store','maintenance'):
        recovery['identityFile']=credential('store','recovery-ssh-key') if role=='store' else secretRoot+'/maintenance/recovery-ssh-key'
        recovery['encryptionKeyFile']=credential('store','recovery-key') if role=='store' else secretRoot+'/maintenance/recovery-key'
        atomic_json(destination/('recovery-'+role+'.json'),recovery);(destination/('recovery-'+role+'.json')).chmod(0o644)
    atomic_json(destination/'admission-input.json',{'action':'admission','window_seconds':p['limits']['windowSeconds'],
        'maximum_requests':p['limits']['maximumRequests'],'maximum_orders':p['limits']['maximumOrders']})
    return {'profile':PROFILE,'configurationDirectory':etc,'generatedDirectory':str(destination),'admissionConfigured':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--input',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    try:print(json.dumps({'ok':True,**generate(args.input,args.output)}))
    except Exception:print(json.dumps({'ok':False,'code':'explicit-native-profile-refused'}));raise SystemExit(2)
