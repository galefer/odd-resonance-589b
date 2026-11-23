// Cloudflare Pages community actions. SQL batches serialize each complete user action.
export async function community(ctx, path, helpers, director = false) {
  const {request, env} = ctx;
  const {json, fail, inputJson, sha256, makeId, passwordStorageHash, safeEquals,
    loginThrottled, normalise, parseCookie, statusesFor, cachedCardView} = helpers;
  const db = env.GOG_DB;
  const query = new URL(request.url).searchParams;
  const stmt = (sql, ...args) => db.prepare(sql).bind(...args);
  const one = (sql, ...args) => stmt(sql, ...args).first();
  const all = async (sql, ...args) => (await stmt(sql, ...args).all()).results;
  const check = (condition, ...args) => stmt(`INSERT INTO jush_precondition VALUES(CASE WHEN (${condition}) THEN 1 ELSE 0 END)`, ...args);
  const write = request.method === 'POST';
  if (!write && request.method !== 'GET') throw fail(405,'Unsupported method.');
  if (write && !director && request.headers.get('X-JUSH-Action') !== 'member') throw fail(403,'Reload the voting page.');
  const body = write ? await inputJson(request) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400,'Expected a form.');
  const integer = value => Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  const string = (value,max) => {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length>max) throw fail(400,`Enter 1 to ${max} characters.`);
    return value.trim();
  };
  const batch = async statements => {
    try { return await db.batch(statements); }
    catch(error) {
      if (/three slots/i.test(String(error))) throw fail(409,'All three slots are in use. Remove a vote first.');
      if (/constraint|jush_precondition/i.test(String(error))) throw fail(409,'This action is no longer available. Refresh the board or check the code and username.');
      throw error;
    }
  };
  const finish = async statements => { await batch(statements); return json({ok:true}); };
  const cookie = parseCookie(request,'jush_member');
  const sessionHash = cookie ? await sha256(cookie) : '';
  const member = cookie ? await one(`SELECT m.id,m.username FROM jush_sessions s JOIN jush_members m ON m.id=s.member
    WHERE s.digest=? AND expires>unixepoch()`,sessionHash) : null;
  const sessionCookie = (value,seconds) => `jush_member=${value}; Path=/gog/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
  if (path === 'salt' && !write) {
    const name=(query.get('username')||'').slice(0,32);
    const row=await one('SELECT salt FROM jush_members WHERE username=?',name);
    const fallback = await sha256(`${env.GOG_AUTH_PEPPER}/member/${name.toLowerCase()}`);
    return json({salt:row?.salt || fallback.slice(0,32)});
  }
  if (write && ['join','recover','login'].includes(path)) {
    const username=string(body.username,32);
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) throw fail(400,'Use 3–32 letters, numbers, hyphens or underscores.');
    const proof=String(body.proof||'');
    if (!/^[0-9a-f]{64}$/.test(proof)) throw fail(400,'Enter a password.');
    await loginThrottled(db,request,'member '+username);
    const existing=await one('SELECT * FROM jush_members WHERE username=?',username);
    const salt=path==='login' ? existing?.salt || '0'.repeat(32) : String(body.salt);
    if (!/^[0-9a-f]{32}$/.test(salt)) throw fail(400,'Invalid password salt.');
    const verifier=await passwordStorageHash(proof,salt,env.GOG_AUTH_PEPPER);
    const statements=[];
    if(path==='login'){
      if(!existing || !safeEquals(verifier,existing.verifier)) throw fail(401,'Incorrect username or password.');
    } else {
      const code=await sha256(string(body.code,100));
      const valid='digest=? AND revoked=0 AND claimed_by IS NULL';
      if(path==='join'){
        statements.push(check(`EXISTS(SELECT 1 FROM jush_codes WHERE ${valid} AND recipient IS NULL)`,code),
          stmt('INSERT INTO jush_members(username,salt,verifier) VALUES(?,?,?)',username,salt,verifier));
      } else {
        statements.push(check(`EXISTS(SELECT 1 FROM jush_codes WHERE ${valid} AND recipient=(SELECT id FROM jush_members WHERE username=?))`,code,username),
          stmt('UPDATE jush_members SET salt=?,verifier=? WHERE username=?',salt,verifier,username),
          stmt('DELETE FROM jush_sessions WHERE member=(SELECT id FROM jush_members WHERE username=?)',username));
      }
      statements.push(stmt('UPDATE jush_codes SET claimed_by=(SELECT id FROM jush_members WHERE username=?) WHERE digest=?',username,code));
    }
    const token=makeId(32), age=30*86400;
    const loginKey=await sha256(`${request.headers.get('CF-Connecting-IP') || 'unknown'}/${normalise('member '+username)}`);
    statements.push(stmt('DELETE FROM auth_attempts WHERE key_hash=?',loginKey),
      stmt('DELETE FROM jush_sessions WHERE expires<=unixepoch()'),
      stmt('INSERT INTO jush_sessions SELECT ?,id,unixepoch()+? FROM jush_members WHERE username=? AND verifier=?',await sha256(token),age,username,verifier));
    const result=await batch(statements);
    if (!result.at(-1).meta.changes) throw fail(409,'Password changed. Sign in again.');
    return json({ok:true},200,{'Set-Cookie':sessionCookie(token,age)});
  }
  if(write && path==='logout'){
    await stmt('DELETE FROM jush_sessions WHERE digest=?',sessionHash).run();
    return json({ok:true},200,{'Set-Cookie':sessionCookie('',0)});
  }
  const latest='COALESCE((SELECT MAX(id) FROM jush_windows),0)';
  const windows=()=>all(`SELECT *,id=${latest} AND closed IS NULL AND deadline>unixepoch() AS active FROM jush_windows ORDER BY id DESC`);
  const wid=integer(body.window ?? query.get('window'));
  const current=()=>check(`${latest}=?`,wid);
  const active=()=>check(`EXISTS(SELECT 1 FROM jush_windows WHERE id=? AND id=${latest} AND deadline>unixepoch() AND closed IS NULL)`,wid);
  if(!write && path==='board'){
    const history=await windows();
    const period=query.has('window') ? history.find(w=>w.id===wid) : history[0];
    if(query.has('window') && !period) throw fail(404,'Period not found.');
    const id=period?.id || 0;
    const candidates=await all(`SELECT c.id,c.card,c.name,c.target,c.published,c.created,c.reason,c.committed,c.ruling,
      m.username AS starter,(SELECT count(*) FROM jush_votes WHERE candidate=c.id AND direction=1) AS up,
      (SELECT count(*) FROM jush_votes WHERE candidate=c.id AND direction=-1) AS down,
      (SELECT count(*) FROM jush_comments WHERE candidate=c.id) AS comments
      FROM jush_candidates c JOIN jush_members m ON m.id=c.starter WHERE window=? ORDER BY c.id DESC`,id);
    if(period?.active && candidates.length){
      const ids=[...new Set(candidates.map(c=>c.card))], statuses=new Map();
      for(let i=0;i<ids.length;i+=40){
        const part=ids.slice(i,i+40);
        const cards=await all(`SELECT * FROM cards_cache WHERE card_id IN (${part.map(()=>'?').join(',')})`,...part);
        for(const card of await statusesFor(db,cards.map(row=>cachedCardView(row)),null,false)) statuses.set(card.id,card.status);
      }
      for(const candidate of candidates) candidate.published=statuses.get(candidate.card)||candidate.published;
    }
    const mine=member ? await all('SELECT card,candidate,direction FROM jush_votes WHERE window=? AND member=?',id,member.id) : [];
    const result={period:period||null,history,candidates,mine,username:member?.username||null};
    if(director){
      result.ballots=await all(`SELECT v.*,m.username FROM jush_votes v JOIN jush_members m ON m.id=v.member WHERE window=?`,id);
      result.corrections=await all(`SELECT a.*,m.username FROM jush_corrections a JOIN jush_members m ON m.id=a.member WHERE window=? ORDER BY a.id`,id);
    }
    return json(result);
  }
  const cid=integer(body.candidate ?? query.get('candidate'));
  if(!write && path==='thread') return json({comments:await all(`SELECT m.username,t.text,t.created FROM jush_comments t
    JOIN jush_members m ON m.id=t.member WHERE t.candidate=? ORDER BY t.id`,cid)});
  if(director){
    if(!write && path==='players') return json({players:await all('SELECT id,username,joined FROM jush_members ORDER BY username'),
      codes:await all(`SELECT c.id,c.label,c.issued,c.recipient,c.revoked,m.username AS claimed FROM jush_codes c
        LEFT JOIN jush_members m ON m.id=c.claimed_by ORDER BY c.id DESC`)});
    if(write && path==='issue'){
      const recipient=integer(body.member)||null, code=makeId(16), label=string(body.label,80);
      const steps=recipient ? [stmt('UPDATE jush_codes SET revoked=1 WHERE recipient=? AND claimed_by IS NULL',recipient)] : [];
      steps.push(stmt('INSERT INTO jush_codes(digest,label,recipient) VALUES(?,?,?)',await sha256(code),label,recipient));
      await batch(steps); return json({code});
    }
    if(write && path==='revoke') return finish([stmt('UPDATE jush_codes SET revoked=1 WHERE id=? AND claimed_by IS NULL',integer(body.id))]);
    if(write && path==='open') return finish([current(),check('NOT EXISTS(SELECT 1 FROM jush_windows WHERE id=? AND closed IS NULL AND deadline>unixepoch())',wid),
      stmt('INSERT INTO jush_windows(opened,deadline) VALUES(unixepoch(),unixepoch()+604800)')]);
    if(write && path==='close') return finish([active(),stmt('UPDATE jush_windows SET closed=unixepoch() WHERE id=?',wid)]);
    if(write && path==='reset') return finish([current(),check('?>0',wid),
      stmt(`INSERT INTO jush_windows(opened,deadline,closed,reset_from) SELECT opened,deadline,closed,id FROM jush_windows WHERE id=?`,wid),
      stmt('UPDATE jush_windows SET closed=COALESCE(closed,min(deadline,unixepoch())) WHERE id=?',wid)]);
    if(write && path==='ruling') return finish([current(),check('EXISTS(SELECT 1 FROM jush_candidates WHERE id=? AND window=?)',cid,wid),
      stmt('UPDATE jush_candidates SET ruling=? WHERE id=?',string(body.text,500),cid)]);
    if(write && path==='correct'){
      const uid=integer(body.member), reason=string(body.reason,200);
      return finish([current(),check('EXISTS(SELECT 1 FROM jush_votes WHERE window=? AND candidate=? AND member=?)',wid,cid,uid),
        stmt(`INSERT INTO jush_corrections(window,candidate,member,direction,reason,after_close)
          SELECT v.window,v.candidate,v.member,v.direction,?,(w.closed IS NOT NULL OR w.deadline<=unixepoch()) FROM jush_votes v
          JOIN jush_windows w ON w.id=v.window WHERE v.window=? AND v.candidate=? AND v.member=?`,reason,wid,cid,uid),
        stmt('DELETE FROM jush_votes WHERE window=? AND candidate=? AND member=?',wid,cid,uid)]);
    }
    throw fail(404,'Unknown Office action.');
  }
  if(!member) throw fail(401,'Sign in to participate.');
  if(!write) throw fail(404,'Unknown action.');
  const uid=member.id;
  const guards=[active(),check('EXISTS(SELECT 1 FROM jush_sessions WHERE digest=? AND expires>unixepoch())',sessionHash)];
  if(path==='comment'){
    const key=string(body.requestId,64);
    return finish([...guards,check('EXISTS(SELECT 1 FROM jush_candidates WHERE id=? AND window=?)',cid,wid),
      stmt('INSERT INTO jush_comments(candidate,member,text,request_id) VALUES(?,?,?,?) ON CONFLICT(member,request_id) DO NOTHING',cid,uid,string(body.text,1000),key)]);
  }
  const prior=integer(body.previous);
  let cardId=integer(body.card);
  let create;
  if(path==='propose'){
    const raw=await one(`SELECT * FROM cards_cache WHERE card_id=? AND pool_verified=1 AND tcg_date<=?
      AND card_type NOT IN ('Skill Card','Token')`,cardId,'2025-08-01');
    if(!raw) throw fail(422,'Choose an eligible catalogue card.');
    const [card]=await statusesFor(db,[cachedCardView(raw)],null,false);
    cardId=card.id;
    if(!['forbidden','limited','semi_limited','unlimited'].includes(body.target) || body.target===card.status) throw fail(422,'Choose a different copy limit.');
    create=stmt('INSERT INTO jush_candidates(window,card,name,published,target,starter,reason) VALUES(?,?,?,?,?,?,?)',
      wid,cardId,card.name,card.status,body.target,uid,string(body.reason,200));
  }else if(path==='vote'){
    const row=await one('SELECT card FROM jush_candidates WHERE window=? AND id=?',wid,cid);
    if(!row) throw fail(409,'This candidate is no longer available.');
    cardId=row.card;
  }else throw fail(404,'Unknown action.');
  // The UI supplies the ballot it displayed. A stale tab cannot move a newer ballot.
  guards.push(check('COALESCE((SELECT candidate FROM jush_votes WHERE window=? AND member=? AND card=?),0)=?',wid,uid,cardId,prior));
  const direction=path==='propose'?1:body.direction;
  if(![-1,0,1].includes(direction)) throw fail(400,'Invalid vote.');
  if(prior){
    guards.push(check('NOT EXISTS(SELECT 1 FROM jush_candidates WHERE id=? AND starter=? AND committed=1)',prior,uid),
      stmt('DELETE FROM jush_votes WHERE window=? AND member=? AND card=?',wid,uid,cardId));
    if(prior===cid && direction===-1) guards.push(check('NOT EXISTS(SELECT 1 FROM jush_candidates WHERE id=? AND starter=?)',cid,uid));
    if(prior!==cid || !direction) guards.push(stmt('DELETE FROM jush_candidates WHERE id=? AND starter=? AND committed=0',prior,uid));
  }
  if(create) guards.push(create);
  if(direction) guards.push(stmt(`INSERT INTO jush_votes(window,member,card,candidate,direction) VALUES(?,?,?,
    ${create?'(SELECT id FROM jush_candidates WHERE window=? AND card=? AND target=?)':'?'},?)`,
    wid,uid,cardId,...(create?[wid,cardId,body.target]:[cid]),direction));
  return finish(guards);
}
