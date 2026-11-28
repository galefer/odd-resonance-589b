import assert from 'node:assert/strict';
import {rankReviewChanges} from '../../lib/jush-card-ballots.js';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequest} from '../../functions/gog/api/[[path]].js';

const sql=new DatabaseSync(':memory:');
const file=name=>readFileSync(new URL('../../'+name,import.meta.url),'utf8');
sql.exec(file('database/schema.sql'));
sql.exec(file('database/migrations/0012_community_votes.sql'));
sql.exec(file('database/migrations/0013_voted_changes.sql'));
sql.exec(file('database/migrations/0014_proposal_admin.sql'));
sql.exec("INSERT INTO versions(version_label,effective_date,status,created_at) VALUES('Fixture','2026-01-01','published','2026-01-01')");
for(let i=1;i<=11;i++)sql.prepare(`INSERT INTO cards_cache(card_id,name,sort_name,category,subtype,card_type,pool_verified,tcg_date,updated_at)
  VALUES(?,?,?,'Monster','Effect','Effect Monster',1,'2024-01-01','2024-01-01')`).run(i,'Card '+i,'card '+i);
const prepare=(query,args=[])=>({
  bind:(...values)=>prepare(query,values),first:()=>sql.prepare(query).get(...args)??null,
  all:()=>({results:sql.prepare(query).all(...args)}),run:()=>({meta:sql.prepare(query).run(...args)})
});
const db={prepare,batch(statements){sql.exec('BEGIN');try{const r=statements.map(s=>s.run());sql.exec('COMMIT');return r;}
  catch(e){sql.exec('ROLLBACK');throw e;}}};
const env={GOG_DB:db,GOG_AUTH_PEPPER:'x'.repeat(40),JUSH_OFFICE_KEY:'local-test-key'.repeat(4)};
async function req(path,body,actor,expected=200){
  const headers={'Content-Type':'application/json','X-JUSH-Action':'member'};
  if(actor==='office')headers['X-JUSH-Office']=env.JUSH_OFFICE_KEY;
  else if(actor)headers.Cookie=actor;
  const request=new Request('https://jush.example/gog/api/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
  const response=await onRequest({env,request}), data=await response.json();
  assert.equal(response.status,expected,`${path} ${JSON.stringify(data)}`);
  return {...data,cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
}
const admin=(name,body,status)=>req('admin/community/'+name,body,'office',status);
const act=(name,body,user,status)=>req('community/'+name,body,user,status);
const officeBoard=()=>admin('board');
const {code}=await admin('issue',{label:'game night'});
const account=(username,code)=>({username,code,salt:'a'.repeat(32),proof:'b'.repeat(64)});
const alice=(await act('join',account('Alice',code))).cookie;
await act('join',account('Other',code),null,409);
const invite=async name=>(await act('join',account(name,(await admin('issue',{label:name})).code))).cookie;
let bob=await invite('Bob');
const cara=await invite('Cara');
const obsolete=(await admin('issue',{label:'Unused'})).code;
const codes=(await admin('players')).codes;await admin('revoke',{id:codes[0].id});
await act('join',account('Other',obsolete),null,409);
await req('admin/community/players',null,alice,403);
await req('admin/draft',null,alice,403);
await act('propose',{window:0,card:1,target:'limited',reason:'Night',previous:0},alice,409);
await admin('open',{window:0});let board=await officeBoard();const window=board.period.id;
assert.equal(board.period.deadline-board.period.opened,604800);
const propose=(user,card,target,previous=0,expected)=>act('propose',{window,card,target,reason:'Try this change.',previous},user,expected);
const vote=(user,candidate,direction,previous=0,expected)=>act('vote',{window,candidate,direction,previous},user,expected);
await propose(alice,1,'limited');await propose(bob,1,'semi_limited');await propose(cara,1,'limited',0,409);
board=await officeBoard();const ca=board.candidates.find(c=>c.target==='limited').id, cb=board.candidates.find(c=>c.target==='semi_limited').id;
await vote(cara,ca,-1);
await vote(cara,cb,1,ca);
await vote(alice,ca,0,ca,409);
await vote(cara,cb,0,cb);
const comment={window,candidate:ca,text:'What about two copies?',requestId:'comment-retry'};
await act('comment',comment,bob);await act('comment',comment,bob);
assert.equal((await act('thread?candidate='+ca,null,null)).comments.length,1);
await propose(alice,2,'limited');await propose(alice,3,'limited');await propose(alice,4,'limited',0,409);
board=await officeBoard();assert.equal(board.ballots.filter(v=>v.username==='Alice').length,3);
const remove=board.candidates.find(c=>c.card===2).id;
await act('comment',{...comment,candidate:remove,requestId:'comment-only'},bob);await vote(alice,remove,0,remove);
await propose(alice,4,'limited');
const guest=await act('board');
assert.equal(guest.username,null);assert.deepEqual(guest.mine,[]);assert.ok(!('ballots' in guest));assert.ok(!('corrections' in guest));
await admin('correct',{window,candidate:ca,member:(await admin('players')).players.find(p=>p.username==='Alice').id,reason:'Entered in error'});
assert.equal((await act('board',null,alice)).mine.length,2);
const resetCode=(await admin('issue',{label:'Bob recovery',member:(await admin('players')).players.find(p=>p.username==='Bob').id})).code;
const recovered=await act('recover',account('Bob',resetCode));
await act('comment',comment,bob,401);bob=recovered.cookie;
await act('recover',account('Bob',resetCode),null,409);
const login=(await act('login',account('Bob',''))).cookie;
await act('logout',{},login);await act('comment',comment,login,401);
await admin('close',{window});
await vote(cara,cb,-1,0,409);await act('comment',comment,bob,409);
await admin('correct',{window,candidate:cb,member:(await admin('players')).players.find(p=>p.username==='Bob').id,reason:'Correction after close'});
await admin('ruling',{window,candidate:cb,text:'Keeping this limit for now.'});
assert.equal((await officeBoard()).corrections.filter(c=>c.after_close).length,1);
await admin('open',{window});
board=await officeBoard();assert.deepEqual(board.candidates,[]);const next=board.period;
assert.equal((await admin('board?window='+window)).candidates.length,4);
await admin('ruling',{window,candidate:cb,text:'Stale edit'},409);
// Concurrent nominations for four different cards compete for the same three slots.
const attempts=await Promise.all([1,2,3,4].map(card=>onRequest({env,request:new Request('https://jush.example/gog/api/community/propose',{
  method:'POST',headers:{Cookie:alice,'Content-Type':'application/json','X-JUSH-Action':'member'},
  body:JSON.stringify({window:next.id,card,target:'limited',reason:'New period',previous:0})
})})));
assert.deepEqual(attempts.map(r=>r.status).sort(),[200,200,200,409]);
assert.equal((await act('board',null,alice)).mine.length,3);
await admin('reset',{window:next.id});board=await officeBoard();
assert.equal(board.period.deadline,next.deadline);assert.equal(board.period.active,1);
sql.prepare('UPDATE jush_windows SET deadline=unixepoch()-1 WHERE id=?').run(board.period.id);
await act('propose',{window:board.period.id,card:4,target:'limited',reason:'Late',previous:0},cara,409);
await admin('reset',{window:board.period.id});assert.equal((await officeBoard()).period.active,0);
assert.equal(sql.prepare("SELECT count(*) AS n FROM versions WHERE status='published'").get().n,1);

const listState=()=>JSON.stringify(['versions','entries'].map(t=>sql.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));
sql.exec("INSERT INTO versions(version_label,effective_date,status,created_at) VALUES('Manual draft','2026-01-02','draft','2026-01-02')");
const official=listState();
await admin('open',{window:(await officeBoard()).period.id});
const beforeId=(await officeBoard()).period.id;
const oldProposal=async (card,actor,target)=>act('propose',{window:beforeId,card,target,reason:'Existing reason',previous:0},actor);
await oldProposal(1,alice,'limited');await oldProposal(1,bob,'semi_limited');await oldProposal(2,alice,'limited');
let before=await officeBoard();
const idOf=(b,card,target)=>b.candidates.find(c=>c.card===card&&c.target===target).id;
const first=idOf(before,1,'limited'), alternative=idOf(before,1,'semi_limited');
await act('vote',{window:beforeId,candidate:first,direction:-1,previous:0},cara);
await act('comment',{window:beforeId,candidate:first,text:'Keep this thread',requestId:'before-switch'},cara);
before=await officeBoard();
sql.exec('INSERT OR IGNORE INTO jush_ballot_activation VALUES(1)');
sql.exec('INSERT OR IGNORE INTO jush_ballot_activation VALUES(1)');
let modern=await officeBoard();assert.deepEqual(modern.period,before.period);
assert.deepEqual(modern.candidates.map(c=>[c.id,c.up,c.down,c.comments,c.reason]),before.candidates.map(c=>[c.id,c.up,c.down,c.comments,c.reason]));
assert.equal(modern.reviewRule.minSupporters,3);assert.equal(modern.ballots.length,before.ballots.length);
assert.ok(!('cardBallots' in await admin('board?window='+window)));
assert.equal((await act('board',null,cara)).mine[0].choice,-first);
assert.equal((await act('board',null,cara)).nominations.length,0);
const windowAction=(path,data,actor,status)=>act(path,{window:beforeId,...data},actor,status);
const choose=(actor,card,choice,previous=null,status)=>windowAction('choose',{card,choice,previous},actor,status);
const nominate=(actor,card,target='limited',status)=>windowAction('nominate',{card,target,reason:'New limit'},actor,status);
const dan=await invite('Daniel'),eve=await invite('Evelyn');
await nominate(cara,3);await nominate(cara,4);await nominate(cara,5);await nominate(cara,6,'limited',409);
const afterNominations=await act('board',null,cara);
assert.equal(afterNominations.mine.length,4);
for(const card of [3,4,5]){
  const candidate=afterNominations.candidates.find(c=>c.card===card);
  assert.equal(candidate.up,1);
  assert.equal(afterNominations.mine.find(v=>v.card===card).choice,candidate.id);
}
await nominate(cara,3,'limited',409); // Retrying creates neither a proposal nor another vote.
await choose(alice,1,alternative,first); // A committed starter can freely move their ballot.
assert.equal((await officeBoard()).candidates.length,6);
await choose(alice,1,first,alternative);
await choose(cara,1,0,-first);await choose(cara,1,first,-first,409);
await choose(cara,1,first,0);await choose(dan,1,first);await choose(eve,1,0);
await choose(cara,2,idOf(await officeBoard(),2,'limited'));
const ownThird=idOf(afterNominations,3,'limited');
await choose(cara,3,null,ownThird);
assert.equal((await officeBoard()).candidates.find(c=>c.id===ownThird).up,0);
await choose(cara,3,0);
await choose(cara,3,ownThird,0);
assert.equal((await act('board',null,cara)).mine.length,5);
await choose(cara,2,null,idOf(await officeBoard(),2,'limited'));
await choose(dan,3,first,null,409);
await nominate(dan,1,'forbidden');
assert.equal((await act('board',null,dan)).mine.find(v=>v.card===1).choice,first);
await windowAction('withdraw-nomination',{card:1,candidate:first},alice,409);
const fifth=idOf(await officeBoard(),5,'limited');
await windowAction('withdraw-nomination',{card:5,candidate:fifth},cara);
assert.equal((await act('board',null,cara)).nominations.length,3);
await nominate(cara,6,'limited',409);
await windowAction('vote',{candidate:first,previous:0,direction:-1},eve,409);
await windowAction('propose',{card:6,target:'limited',reason:'Stale client',previous:0},eve,409);
await nominate(dan,2,'semi_limited');
const limit2=idOf(await officeBoard(),2,'limited'),semi2=idOf(await officeBoard(),2,'semi_limited');
await choose(cara,2,semi2);await choose(dan,2,limit2,semi2);await choose(eve,2,semi2);
const guest2=await act('board');assert.equal(guest2.mine.length,0);assert.ok(!('ballots' in guest2));assert.ok(!('votedChanges' in guest2));
assert.equal(guest2.shortlist.priorityOnly,true);
assert.equal(guest2.shortlist.cardCount,4);
assert.equal(guest2.shortlist.limit,2);
assert.deepEqual(guest2.shortlist.entries.map(c=>[c.candidate,c.label]),[[first,'1st pick']]);
const onDisk=()=>sql.prepare('SELECT * FROM jush_voted_changes WHERE window=? AND card=1').get(beforeId);
assert.equal(onDisk().supporters,3);assert.equal(onDisk().card_ballots,5);
sql.prepare('UPDATE jush_windows SET deadline=unixepoch() WHERE id=?').run(beforeId);
assert.equal(onDisk().candidate,first);await choose(dan,1,0,first,409);
const closed=await officeBoard();assert.equal(closed.votedChanges.choices[0].candidate,first);
assert.equal(closed.votedChanges.choices.length,1);
assert.equal(closed.votedChanges.cards.find(c=>c.card===2).split,true);
const player=(await admin('players')).players.find(p=>p.username==='Daniel').id;
await admin('correct',{window:beforeId,member:player,card:1,choice:first,reason:'Support after close'});
assert.deepEqual((await officeBoard()).votedChanges,closed.votedChanges);
assert.deepEqual((await act('board')).shortlist,closed.shortlist);
await admin('reset',{window:beforeId});
assert.deepEqual((await admin('board?window='+beforeId)).votedChanges,closed.votedChanges);
await admin('open',{window:(await officeBoard()).period.id});const fresh=await officeBoard();
assert.equal(fresh.shortlist.priorityOnly,false);assert.equal(fresh.shortlist.limit,0);
await admin('reset',{window:fresh.period.id});const replacement=await officeBoard();
assert.equal(replacement.period.deadline,fresh.period.deadline);assert.equal(replacement.reviewRule.minSupporters,3);
assert.equal(replacement.shortlist.priorityOnly,false);
assert.equal((await admin('board?window='+fresh.period.id)).reviewDiscarded,true);
assert.ok(!('shortlist' in await admin('board?window='+fresh.period.id)));
await admin('close',{window:replacement.period.id});assert.deepEqual((await officeBoard()).votedChanges.choices,[]);
assert.equal(listState(),official);
// Three full qualifying windows with distinct turnout of 40, 100 and 125 lock the next cut at five.
for(const n of [40,100,125]){
  await admin('open',{window:(await officeBoard()).period.id});const w=(await officeBoard()).period.id;
  await act('nominate',{window:w,card:1,target:'limited',reason:'History'},alice);
  for(let i=1;i<n;i++){ // The proposer's automatic ballot already counts toward turnout.
    sql.prepare('INSERT OR IGNORE INTO jush_members(username,salt,verifier) VALUES(?,?,?)').run('History'+i,'salt','verifier');
    sql.prepare('INSERT INTO jush_card_ballots(window,member,card,choice) SELECT ?,id,1,0 FROM jush_members WHERE username=?').run(w,'History'+i);
  }
  sql.prepare('UPDATE jush_windows SET opened=unixepoch()-604801,deadline=unixepoch()-1 WHERE id=?').run(w);
}
await admin('open',{window:(await officeBoard()).period.id});const scaled=await officeBoard();
assert.equal(scaled.reviewRule.minSupporters,5);assert.deepEqual(scaled.reviewRule.history.map(h=>h.voters),[125,100,40]);
await admin('reset',{window:scaled.period.id});assert.equal((await officeBoard()).reviewRule.minSupporters,5);
// The single proposal-admin flag changes only the number of distinct cards per window.
const quotaUser=await invite('QuotaMember');
assert.equal((await act('board',null,quotaUser)).nominationLimit,3);
sql.exec("INSERT INTO jush_proposal_admin(singleton,member) SELECT 1,id FROM jush_members WHERE username='QuotaMember'");
assert.throws(()=>sql.exec("INSERT INTO jush_proposal_admin(singleton,member) SELECT 2,id FROM jush_members WHERE username='Alice'"),/constraint/i);
assert.equal((await act('board',null,quotaUser)).nominationLimit,10);
assert.equal((await act('board',null,alice)).nominationLimit,3);
assert.equal((await act('board')).nominationLimit,3);
await req('admin/community/players',null,quotaUser,403);
const quotaWindow=(await act('board')).period.id;
const nomination=card=>({window:quotaWindow,card,target:'limited',reason:'Quota check'});
for(let card=1;card<=9;card++) await act('nominate',nomination(card),quotaUser);
const lastTwo=await Promise.all([10,11].map(card=>onRequest({env,request:new Request('https://jush.example/gog/api/community/nominate',{
  method:'POST',headers:{Cookie:quotaUser,'Content-Type':'application/json','X-JUSH-Action':'member'},
  body:JSON.stringify(nomination(card))
})})));
assert.deepEqual(lastTwo.map(r=>r.status).sort(),[200,409]);
assert.match((await lastTwo.find(r=>r.status===409).json()).error,/all 10/);
const atLimit=await act('board',null,quotaUser);
assert.equal(atLimit.nominations.length,10);
assert.equal(atLimit.mine.length,10);
await act('withdraw-nomination',{window:quotaWindow,card:1,candidate:idOf(atLimit,1,'limited')},quotaUser);
const afterWithdrawal=await act('board',null,quotaUser);
assert.equal(afterWithdrawal.mine.length,9);
assert.ok(!afterWithdrawal.mine.some(v=>v.card===1));
await act('nominate',nomination(1),quotaUser);
assert.equal((await act('board',null,quotaUser)).mine.length,10);
await admin('close',{window:quotaWindow});
await admin('open',{window:quotaWindow});
const newWindow=await act('board',null,quotaUser);
assert.equal(newWindow.nominations.length,0);
assert.equal(newWindow.nominationLimit,10);

const change=(card,supporters,ballots)=>({card,supporters,card_ballots:ballots});
for(const [cards,places] of [[0,0],[1,1],[3,1],[4,2],[6,2],[7,3],[10,3],[100,3]]){
  const preview=rankReviewChanges([],cards);
  assert.equal(preview.limit,places);assert.deepEqual(preview.entries,[]);
}
const contenders=[change(8,10,16),change(4,9,10),change(3,9,11),change(2,8,8)];
const medals=rankReviewChanges(contenders,20).entries;
assert.deepEqual(medals.map(p=>[p.card,p.label]),[[8,'1st pick'],[4,'2nd pick'],[3,'3rd pick'],[2,'Qualified']]);
const tie=rankReviewChanges([...contenders,change(7,9,11)],20).entries;
assert.deepEqual(tie.map(p=>p.status),['pick','pick','cutoff-tie','cutoff-tie','qualified']);
assert.deepEqual(tie.slice(2,4).map(p=>[p.label,p.places]),[['Tied for 3rd pick',1],['Tied for 3rd pick',1]]);
assert.deepEqual(rankReviewChanges([change(1,5,5),change(2,5,5),change(3,4,4)],10).entries.map(p=>p.label),['Joint 1st pick','Joint 1st pick','3rd pick']);
assert.deepEqual(rankReviewChanges([change(1,5,6),change(2,5,6),change(3,5,6)],4).entries.map(p=>p.places),[2,2,2]);
console.log('Passed ballot migration, nominations, scaling, review cutoff, pick order, ties, closed snapshots and correction history.');
