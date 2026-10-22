// Exercise the real import CLI with a provider fixture that reproduces the
// misleading current-format filter. No network or Cloudflare account required.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {blmmCards} from './fixtures/blmm.mjs';

const root=resolve(import.meta.dirname,'../..');
const directory=await mkdtemp(join(tmpdir(),'gog-catalogue-regression-'));
const fixture=join(directory,'provider.mjs');
const output=join(directory,'catalogue.sql');
try {
  const raw=(id,name,date,type='Effect Monster')=>({id,name,type,desc:'Fixture metadata.',card_images:[{id}],misc_info:[{tcg_date:date}]});
  const cards=[
    raw(5370235,'Cyberdark Chimera','2021-10-14'),
    raw(1111,'Cutoff-day card','2025-08-01'),
    raw(2222,'Later reprint of older card','2002-03-08'),
    raw(3333,'First released after JUSH','2025-08-02'),
    raw(4444,'No proven TCG release',null),
    raw(5555,'Skill fixture','2020-01-01','Skill Card'),
    raw(6666,'Token fixture','2020-01-01','Token'),
    raw(59983249,'Monarchic Perfection',null,'Trap Card'),
    raw(12067160,'Gorgon of Zilofthonia','2026-07-15','Link Monster'),
    raw(87640391,'Migratory Zereort',null),
    raw(98349765,'Layer 19: "Preventing the Invasion! The Pitch-Black Super Quantum!!"',null,'Spell Card'),
    ...blmmCards
  ];
  // A later printing must never replace the original TCG release as the cutoff.
  cards[2].card_sets=[{set_name:'2026 reprint'}];
  cards[3].misc_info[0].ocg_date='2024-01-01';
  cards[4].misc_info[0].ocg_date='2024-01-01';
  await writeFile(fixture,`const cards=${JSON.stringify(cards)};
    globalThis.fetch=async input=>{
      const url=new URL(input);
      const data=url.searchParams.has('format')?cards.filter(card=>card.id!==5370235):cards;
      if(url.searchParams.get('misc')!=='yes') throw new Error('Release evidence not requested');
      return Response.json({data,meta:{total_rows:data.length}});
    };`);
  const result=spawnSync(process.execPath,['--import',pathToFileURL(fixture).href,join(root,'database/sync-catalogue.mjs'),output],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const db=new DatabaseSync(':memory:');
  db.exec(await readFile(join(root,'database/schema.sql'),'utf8'));
  db.exec(await readFile(join(root,'database/seed.sql'),'utf8'));
  const restrictions=JSON.stringify(db.prepare('SELECT * FROM entries ORDER BY version_id,sort_name').all());
  const generated=await readFile(output,'utf8');
  db.exec(generated);
  const chimera=db.prepare('SELECT * FROM cards_cache WHERE card_id=5370235').get();
  assert(chimera,'Eligible card omitted by format=tcg must still be imported');
  for (const card of blmmCards) {
    const imported=db.prepare('SELECT tcg_date,pool_verified FROM cards_cache WHERE card_id=?').get(card.id);
    assert.equal(imported?.tcg_date,'2025-06-13',`${card.name}: North American BLMM release`);
    assert.equal(imported.pool_verified,1);
  }
  assert.equal(chimera.pool_verified,1);
  assert.equal(chimera.tcg_date,'2021-10-14');
  assert.equal(db.prepare('SELECT tcg_date FROM cards_cache WHERE card_id=59983249').get().tcg_date,'2025-07-03');
  assert.equal(db.prepare('SELECT tcg_date FROM cards_cache WHERE card_id=12067160').get().tcg_date,'2025-07-03');
  assert.equal(db.prepare('SELECT tcg_date FROM cards_cache WHERE card_id=87640391').get().tcg_date,'2025-05-01');
  assert.equal(db.prepare('SELECT name FROM cards_cache WHERE card_id=98349765').get().name,
    'Layer 19 "Sudden Incursion! Super Quantum Black!!"');
  assert(db.prepare("SELECT 1 FROM card_name_search WHERE search_text='chimera' AND card_id=5370235").get());
  assert(db.prepare('SELECT 1 FROM card_artworks WHERE artwork_id=5370235').get());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards_cache WHERE pool_verified=1').get().n,10);
  assert.equal(db.prepare('SELECT reason FROM card_id_evidence WHERE input_id=3333').get().reason,'outside_pool');
  assert.equal(db.prepare('SELECT reason FROM card_id_evidence WHERE input_id=4444').get().reason,'missing_tcg_date');
  assert.equal(db.prepare("SELECT value FROM catalogue_meta WHERE key='eligible_cards'").get().value,'10');
  assert.equal(db.prepare("SELECT value FROM catalogue_meta WHERE key='source'").get().value,
    'YGOPRODeck API v7 + reviewed TCG release evidence');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM entries ORDER BY version_id,sort_name').all()),restrictions);
  db.exec(generated);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards_cache WHERE pool_verified=1').get().n,10);
  db.close();
  console.log('Passed: reviewed release evidence, omitted historical TCG card, search/artwork indexes, inclusive cutoff, later reprints, unknown dates, non-playable exclusions, restriction preservation and repeat import.');
} finally {
  const tempRoot=resolve(tmpdir()).replace(/[\\/]+$/,'');
  if(directory.startsWith(`${tempRoot}${sep}`)) await rm(directory,{recursive:true,force:true});
}
