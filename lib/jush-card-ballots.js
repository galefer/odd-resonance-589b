// With equal positive supporter counts, the smaller ballot total gives the higher exact share.
export function rankReviewChanges(choices, cardCount) {
  const limit = Math.min(3, Math.ceil(3 * cardCount / 10));
  const ranked = [...choices].sort((a,b)=>b.supporters-a.supporters || a.card_ballots-b.card_ballots || a.card-b.card);
  const entries = [];
  const ordinal = ['1st','2nd','3rd'];
  for (let start=0; start<ranked.length;) {
    let end=start+1;
    while (end<ranked.length && ranked[end].supporters===ranked[start].supporters &&
           ranked[end].card_ballots===ranked[start].card_ballots) end++;
    const places=Math.max(0,Math.min(end,limit)-start);
    const rank=start+1;
    let status='qualified', label='Qualified';
    if (places>0) {
      status=end>limit?'cutoff-tie':'pick';
      const prefix=status==='cutoff-tie'?'Tied for ':end-start>1?'Joint ':'';
      label=prefix+ordinal[start]+' pick';
    }
    for (const choice of ranked.slice(start,end)) entries.push({...choice,rank,status,label,places});
    start=end;
  }
  return {limit,cardCount,entries};
}

// A signed choice preserves an earlier downvote without guessing another copy limit.
export async function cardBallotBoard(result, rule, {all,one}, member, director) {
  const id=rule.window;
  result.reviewRule={supportPercent:rule.percent,minSupporters:rule.minimum,version:rule.version};
  result.cardBallots=true;
  result.reviewDiscarded=Boolean(rule.discarded);
  const counts=await all(`SELECT card,choice,count(*) AS atClose,sum(corrected=0) AS votes
    FROM jush_card_ballots WHERE window=? GROUP BY card,choice`,id);
  result.counts=counts.map(({card,choice,votes})=>({card,choice,votes}));
  const byChoice=new Map(counts.filter(v=>v.choice!==0).map(v=>[v.choice,v.votes]));
  for (const c of result.candidates) { c.up=byChoice.get(c.id)||0; c.down=byChoice.get(-c.id)||0; }
  result.mine=member?await all('SELECT card,choice FROM jush_card_ballots WHERE window=? AND member=? AND corrected=0',id,member.id):[];
  result.nominations=member?await all('SELECT n.card,c.name FROM jush_nomination_cards n LEFT JOIN cards_cache c ON c.card_id=n.card WHERE n.window=? AND n.member=? ORDER BY n.card',id,member.id):[];
  let choices=[];
  if (!rule.discarded) {
    const cardCount=new Set(result.candidates.map(c=>c.card)).size;
    if (result.period.active) {
      const turnout=new Map();
      for (const v of counts) turnout.set(v.card,(turnout.get(v.card)||0)+v.votes);
      for (const c of result.candidates) {
        const ballots=turnout.get(c.card)||0;
        if (c.up>=rule.minimum && 100*c.up>=rule.percent*ballots)
          choices.push({card:c.card,candidate:c.id,name:c.name,published:c.published,target:c.target,supporters:c.up,card_ballots:ballots});
      }
    } else {
      choices=await all(`SELECT window,card,candidate,name,published,target,supporters,card_ballots
        FROM jush_voted_changes WHERE window=? ORDER BY supporters DESC,name COLLATE NOCASE`,id);
    }
    // A reset retains the opening policy of its original window. The in-place migration
    // is the only original (non-reset) card-ballot window marked non-comparable.
    let root=result.period;
    const periods=new Map(result.history.map(p=>[p.id,p]));
    while (root.reset_from) root=periods.get(root.reset_from);
    const opening=root.id===id?rule:await one('SELECT comparable FROM jush_ballot_rules WHERE window=?',root.id);
    result.shortlist={...rankReviewChanges(choices,cardCount),priorityOnly:!opening?.comparable};
  }
  if (!director) return;
  result.reviewRule.history=JSON.parse(rule.history);
  result.ballots=await all(`SELECT b.card,b.choice,b.member,m.username FROM jush_card_ballots b
    JOIN jush_members m ON m.id=b.member WHERE b.window=? AND b.corrected=0`,id);
  result.corrections.push(...await all(`SELECT a.*,m.username FROM jush_card_corrections a
    JOIN jush_members m ON m.id=a.member WHERE a.window=? ORDER BY a.id`,id));
  if (result.period.active || rule.discarded) return;
  const totals=await one('SELECT count(*) AS ballots,count(DISTINCT member) AS voters FROM jush_card_ballots WHERE window=?',id);
  const cards=new Map();
  for(const c of result.candidates) {
    if(!cards.has(c.card)) cards.set(c.card,{card:c.card,name:c.name,published:c.published,current:c.currentPublished||c.published,keep:0,ballots:0,options:[]});
    cards.get(c.card).options.push({id:c.id,target:c.target,supporters:0,opposed:0});
  }
  for(const v of counts) {
    const card=cards.get(v.card);
    if(!card)continue;
    card.ballots+=v.atClose;
    if(v.choice===0)card.keep=v.atClose;
    else {
      const option=card.options.find(o=>o.id===Math.abs(v.choice));
      if(option)option[v.choice>0?'supporters':'opposed']=v.atClose;
    }
  }
  const winners=new Set(choices.map(v=>v.card));
  for(const c of cards.values()){
    const support=c.options.reduce((n,o)=>n+o.supporters,0);
    c.split=!winners.has(c.card) && c.options.filter(o=>o.supporters>0).length>1 &&
      support>=rule.minimum && support*100>=rule.percent*c.ballots;
  }
  result.votedChanges={...totals,choices,cards:[...cards.values()]};
}

export async function cardBallotAction(path, context) {
  const {body,rule,member,guards,stmt,check,finish,fail,cardInfo}=context;
  const wid=rule.window,uid=member.id;
  if(!['nominate','withdraw-nomination','choose'].includes(path))throw fail(409,'Voting has changed. Reload the board to choose a limit.');
  const card=Number(body.card);
  if(!Number.isSafeInteger(card)||card<=0)throw fail(400,'Choose a card.');
  if(path==='nominate'){
    const item=await cardInfo(card,rule);
    if(!item||!['forbidden','limited','semi_limited','unlimited'].includes(body.target)||body.target===item.status)
      throw fail(422,'Choose an eligible card and a different limit.');
    const reason=context.string(body.reason,200);
    return finish([...guards,check('NOT EXISTS(SELECT 1 FROM jush_candidates WHERE window=? AND card=? AND starter=?)',wid,item.id,uid),
      stmt('INSERT OR IGNORE INTO jush_nomination_cards(window,member,card) VALUES(?,?,?)',wid,uid,item.id),
      stmt(`INSERT INTO jush_candidates(window,card,name,published,target,starter,reason,committed)
        SELECT ?,?,?,?,?,?,?,EXISTS(SELECT 1 FROM jush_card_ballots WHERE window=? AND card=? AND member<>?)`,
        wid,item.id,item.name,item.status,body.target,uid,reason,wid,item.id,uid)]);
  }
  if(path==='withdraw-nomination'){
    const cid=Number(body.candidate);
    return finish([...guards,check('EXISTS(SELECT 1 FROM jush_candidates WHERE window=? AND card=? AND id=? AND starter=? AND committed=0)',wid,card,cid,uid),
      stmt(`DELETE FROM jush_card_ballots WHERE window=? AND card=? AND member=? AND
        (abs(choice)=? OR NOT EXISTS(SELECT 1 FROM jush_candidates WHERE window=? AND card=? AND id<>?))`,wid,card,uid,cid,wid,card,cid),
      stmt('DELETE FROM jush_candidates WHERE window=? AND id=?',wid,cid)]);
  }
  const {choice,previous}=body;
  if(!(choice===null||Number.isSafeInteger(choice)&&choice>=0) || !(previous===null||Number.isSafeInteger(previous)))
    throw fail(400,'Reload the ballot and choose a limit.');
  const steps=[...guards,check('EXISTS(SELECT 1 FROM jush_candidates WHERE window=? AND card=?)',wid,card),
    check('(SELECT choice FROM jush_card_ballots WHERE window=? AND card=? AND member=?) IS ?',wid,card,uid,previous)];
  if(choice>0)steps.push(check('EXISTS(SELECT 1 FROM jush_candidates WHERE window=? AND card=? AND id=?)',wid,card,choice));
  steps.push(stmt('DELETE FROM jush_card_ballots WHERE window=? AND member=? AND card=?',wid,uid,card));
  if(choice!==null)steps.push(stmt('INSERT INTO jush_card_ballots(window,member,card,choice) VALUES(?,?,?,?)',wid,uid,card,choice));
  return finish(steps);
}
