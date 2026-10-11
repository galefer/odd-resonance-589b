"""Build deterministic D1 foundation SQL from the published April 7, 2025 TCG list."""
from pathlib import Path
from collections import Counter
import re
root=Path(__file__).resolve().parent
rows=[]
for l in (root/'seed-source.txt').read_text().splitlines():
 l=l.strip()
 if not l or l.startswith('#'): continue
 if l.startswith('['):
  status, typ=l[1:-1].split(' ')
  cat,_,sub=typ.partition('/')
  sub=sub or cat
  continue
 rows.append((status,cat,sub,l))
assert len(rows)==207, len(rows)
assert Counter(r[0] for r in rows)=={'forbidden':109, 'limited':82,'semi_limited':16}

def norm(v):
 import unicodedata
 v=unicodedata.normalize('NFKD',v)
 v=''.join(x for x in v if not unicodedata.combining(x))
 v=v.replace('’',"'").replace('‘',"'").replace('–','-').replace('—','-')
 return re.sub('[^a-zA-Z0-9]+',' ',v).strip().lower()
assert len({norm(x[3]) for x in rows})==207

def q(v): return "'"+str(v).replace("'","''")+"'"

lines=[
 '-- Seed: JUSH-era TCG banlist, effective 2025-04-07. Card pool capped 2025-08-01.',
 '-- This file is idempotent: run it once on a NEW database after schema.sql.',
 "INSERT OR IGNORE INTO settings(key,value) VALUES",
 "  ('format_name','Justice Hunters House Format'),",
 "  ('format_short_name','JUSH Format'),",
 "  ('format_description','Independent TCG format with a hard card-pool cutoff at Justice Hunters (1 August 2025). All eligible cards not on this list are Unlimited.'),",
 "  ('store_name','Your Local Store'),",
 "  ('accent_label','JUSH-era House Format');",
 "INSERT OR IGNORE INTO versions(id,version_label,effective_date,summary,status,source,created_at,published_at)",
 " VALUES (1,'April 2025 TCG Foundation','2025-04-07','Official April 7, 2025 TCG Advanced list, frozen as the starting point for a standalone JUSH-era house format.','published','tcg-apr-2025',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
 'INSERT OR IGNORE INTO entries(version_id,name,sort_name,card_id,category,subtype,card_type,status,note) VALUES',
]
entrylines=[]
for status,cat,sub,name in rows:
 ct=(f'{cat}/{sub}' if cat=='Monster' else cat)
 entrylines.append('  ('+','.join(['1',q(name),q(norm(name)),'NULL',q(cat),q(sub),q(ct),q(status),'NULL'])+')')
lines.append(',\n'.join(entrylines)+';')
(root/'seed.sql').write_text('\n'.join(lines)+'\n')
print('Created seed.sql with',len(rows),'entries')
