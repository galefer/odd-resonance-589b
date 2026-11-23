import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequest} from '../../functions/gog/api/[[path]].js';

const sql=new DatabaseSync(':memory:');
const file=name=>readFileSync(new URL('../../'+name,import.meta.url),'utf8');
sql.exec(file('database/schema.sql'));
sql.exec(file('database/migrations/0012_community_votes.sql'));
sql.exec("INSERT INTO versions(version_label,effective_date,status,created_at) VALUES('Fixture','2026-01-01','published','2026-01-01')");
for(let i=1;i<=6;i++)sql.prepare(`INSERT INTO cards_cache(card_id,name,sort_name,category,subtype,card_type,pool_verified,tcg_date,updated_at)
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
console.log('JUSH community voting, account recovery, deadline, reset, support and privacy checks passed.');
