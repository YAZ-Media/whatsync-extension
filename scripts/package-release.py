#!/usr/bin/env python3
"""Package a local candidate; never deploy or enable sales."""
from pathlib import Path
import json, re, base64, subprocess, zipfile, hashlib, shutil
root=Path(__file__).resolve().parent.parent
website=root/'website'
manifest=json.loads((root/'manifest.json').read_text());version=manifest['version']
config=(root/'config.js').read_text();backend=(website/'src/lib/backend.ts').read_text()
project='ogsvchujqpayuckxuwdf'
assert project in config and project in backend, 'Backend targets differ'
for text in [config,backend]:
 for jwt in re.findall(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',text):
  claims=json.loads(base64.urlsafe_b64decode(jwt.split('.')[1]+'=='))
  assert claims.get('role')=='anon' and claims.get('ref')==project, 'Unsafe/mismatched browser key'
for p in (root/'supabase/functions').rglob('*.ts'):
 other=website/p.relative_to(root)
 assert other.exists() and p.read_bytes()==other.read_bytes(), f'Backend source drift: {p.relative_to(root)}'
assert (website/'dist/index.html').exists(), 'Build website first'
for p in (website/'dist/assets').glob('*.js'):
 assert b'dizxmubrpwwfrjepcttb' not in p.read_bytes(), 'Website build targets old backend'
subprocess.run(['bash','package-extension.sh'],cwd=root,check=True)
output=root/'dist'/f'whatsync-{version}-candidate';output.mkdir(parents=True,exist_ok=True)
shutil.copy2(root/'dist'/f'whatsync-{version}.zip',output)
with zipfile.ZipFile(output/f'whatsync-{version}.zip') as archive:
 names=archive.namelist();assert 'contact-intelligence.js' in names
 assert not any('.env' in n or '.git/' in n or n.startswith('website/') for n in names)
 for name in ['background.js','popup.html','config.js','content.js','dashboard-bridge.js']:
  assert name in names

def bundle(name,base,paths):
 with zipfile.ZipFile(output/name,'w',zipfile.ZIP_DEFLATED) as archive:
  for relative in paths:
   path=base/relative
   if not path.exists():continue
   files=path.rglob('*') if path.is_dir() else [path]
   for file in files:
    if file.is_file() and file.name!='.DS_Store':archive.write(file,file.relative_to(base))
bundle('website-static.zip',website/'dist',['.'])
bundle('website-source.zip',website,['src','public','index.html','package.json','package-lock.json','vite.config.ts','tailwind.config.ts','postcss.config.js','tsconfig.json','tsconfig.app.json','tsconfig.node.json'])
bundle('backend-source.zip',root,['supabase/functions','supabase/migrations','supabase/config.toml'])
for src in ['LAUNCH_READINESS.md','DEPLOYMENT.md','DESIGN_SYSTEM.md','STORE_LISTING.md','release/LAUNCH_RUNBOOK.md']:
 shutil.copy2(root/src,output/Path(src).name)
evidence=output/'evidence';evidence.mkdir(exist_ok=True)
for src,dest in [(website/'test-results/results.json','browser-tests.json'),(Path('/tmp/whatsync-final-audit.json'),'dependency-audit.json'),(Path('/tmp/whatsync-production-probe.json'),'production-readonly-probe.json'),(Path('/tmp/whatsync-production-acceptance.json'),'production-deployed-checks.json'),(Path('/tmp/whatsync-database-acceptance.json'),'database-deployed-checks.json'),(Path('/tmp/whatsync-node-tests.txt'),'node-tests.txt'),(Path('/tmp/whatsync-billing-tests.txt'),'billing-tests.txt'),(Path('/tmp/whatsync-signup-tests.txt'),'signup-tests.txt'),(Path('/tmp/whatsync-postgres-tests.txt'),'postgres-tests.txt'),(Path('/tmp/whatsync-compiled-tests.json'),'compiled-site-tests.json')]:
 if src.exists():shutil.copy2(src,evidence/dest)
for p in (website/'test-results').glob('*.png'):shutil.copy2(p,evidence/p.name)
checks={str(p.relative_to(output)):hashlib.sha256(p.read_bytes()).hexdigest() for p in output.rglob('*') if p.is_file() and p.name!='release-manifest.json'}
(output/'release-manifest.json').write_text(json.dumps({'version':version,'status':'CANDIDATE_NOT_APPROVED_FOR_PAID_LAUNCH','backend':project,'sourceCommits':{'extension':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'website':subprocess.check_output(['git','rev-parse','HEAD'],cwd=website,text=True).strip()},'sha256':checks},indent=2)+'\n')
shutil.make_archive(str(root/'dist'/f'whatsync-{version}-candidate'), 'zip', output)
print(output)
print(str(output)+'.zip')
