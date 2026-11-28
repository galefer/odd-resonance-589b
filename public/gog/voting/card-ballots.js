export const vetoRule = 'Qualifying changes can only be vetoed by Judge Majority.';

export function qualificationProgress(supporters, total, openRule) {
  // Round down for display so a near miss can never appear to meet the cut.
  const percent = total ? Math.floor(1000 * supporters / total) / 10 : 0;
  let share = total ? percent + '% for' : 'No ballots yet';
  if (supporters > 0 && percent === 0) share = 'Under 0.1% for';
  if (!openRule) return share;

  const {supportPercent, minSupporters} = openRule;
  // Each new supporter adds one to both sides of the fraction (supporters + n) / (total + n).
  const deficit = supportPercent * total - 100 * supporters;
  if (deficit > 0 && supportPercent === 100) return share + ' · Needs unanimous support';
  const votesForShare = deficit > 0 ? Math.ceil(deficit / (100 - supportPercent)) : 0;
  const needed = Math.max(0, minSupporters - supporters, votesForShare);
  if (!needed) return share + ' · Qualifies';
  return share + ' · ' + needed + ' more upvote' + (needed === 1 ? '' : 's') + ' to qualify';
}

export function compareVoteTotals(a,b,sort){
  let difference;
  if(sort==='least')difference=(a.up+a.down)-(b.up+b.down);
  else if(sort==='down')difference=b.down-a.down;
  else difference=b.up-a.up || a.down-b.down;
  return difference || a.name.localeCompare(b.name,'en') || a.id-b.id;
}

export function renderCardBallots(board,ui){
  const {$,escape,statuses,limitBadge,cardArt,icon,open}=ui;
  const cards=new Map();
  for(const c of [...board.candidates].sort((a,b)=>a.id-b.id)){
    if(!cards.has(c.card))cards.set(c.card,{card:c.card,id:c.id,name:c.name,first:c,options:[],votes:0,up:0,down:0,keep:0});
    cards.get(c.card).options.push(c);
  }
  for(const v of board.counts){
    const card=cards.get(v.card);
    if(!card)continue;
    card.votes+=v.votes;
    if(v.choice>0)card.up+=v.votes;
    else card.down+=v.votes;
    if(v.choice===0)card.keep=v.votes;
  }
  const shortlist=board.shortlist;
  const ranks=new Map((shortlist?.entries||[]).map(p=>[p.card,p]));
  const sort=$('sort');
  const rule=board.reviewRule;
  const total=board.counts.reduce((n,v)=>n+v.votes,0);
  $('candidate-count').hidden=false;
  $('candidate-count').textContent=cards.size;
  $('sort').parentElement.hidden=cards.size<2;
  $('board-leaning').textContent=total+' '+(total===1?'vote':'votes')+' · Review cut: '+rule.supportPercent+'% and '+rule.minSupporters+' supporters';
  const summary=$('pick-summary');
  summary.hidden=!shortlist;
  if(shortlist){
    const places=shortlist.limit===1?'1 place':shortlist.limit+' places';
    const timing=open?'If voting ended now':'At close';
    const ruleLine=shortlist.priorityOnly?vetoRule:'Top 30% of proposed cards, rounded up, up to 3 picks. '+vetoRule;
    summary.textContent=shortlist.cardCount?`${timing} · ${places} for ${shortlist.cardCount} ${shortlist.cardCount===1?'card':'cards'}. ${ruleLine}`:ruleLine;
  }
  $('review-rules').hidden=false;
  $('review-rules').querySelector('p').textContent=`Vote for a proposed limit or against changing the card. You can vote once on every card and propose up to ${board.nominationLimit} distinct cards. To qualify, a limit needs at least ${rule.supportPercent}% of all ballots on its card and at least ${rule.minSupporters} supporters. The upvotes needed assume every new ballot supports that limit. Kirk publishes the official banlist manually.`;
  if(shortlist)$('review-rules').querySelector('p').append(' Review picks go to qualifying limits with the most supporters, then the higher share of card ballots. Kirk decides ties at the last place.');
  const myBallots=new Map(board.mine.map(b=>[b.card,b.choice]));
  function choiceName(card,choice){
    if(choice===0)return card.options.length===1?'Against':'Against all changes';
    const option=card.options.find(c=>c.id===Math.abs(choice));
    if(choice<0 && card.options.length===1)return 'Against';
    return (choice<0?'Against ':'For ')+(statuses[option?.target]||'earlier option');
  }
  function cardLink(card,label){return `<a href="#candidate-${card.first.id}">${escape(card.first.name)} · ${escape(label)}</a>`;}
  $('mine').querySelector('summary').textContent='My votes · '+board.mine.length;
  $('mine').querySelector('div').innerHTML=board.mine.map(v=>{
    const card=cards.get(v.card);return card?cardLink(card,choiceName(card,v.choice)):'';
  }).join('')||'<p>You can vote on every proposed card.</p>';
  $('my-proposals').hidden=!board.username;
  $('my-proposals').querySelector('summary').textContent=`My proposals · ${board.nominations.length} of ${board.nominationLimit} cards used`;
  $('my-proposals').querySelector('div').innerHTML=board.nominations.map(n=>{
    const card=cards.get(n.card), own=card?.options.find(o=>o.starter===board.username);
    return own?cardLink(card,statuses[own.target]):`<p>${escape(n.name||('Card '+n.card))} · withdrawn</p>`;
  }).join('')||'<p>Choose a card in the catalogue to propose a limit.</p>';
  function row(card){
    const c=card.first, options=card.options.sort((a,b)=>Object.values(statuses).indexOf(statuses[a.target])-Object.values(statuses).indexOf(statuses[b.target]));
    const mine=myBallots.get(card.card), locked=open?'':'disabled';
    const single=options.length===1;
    // An earlier downvote on the sole target has the same visible position as a vote against changing the card.
    const selected=single && mine===-c.id?0:mine;
    const button=(choice,label,count)=>`<button type="button" data-choice="${choice}" class="${choice===0?'keep-choice':'change-choice'}" aria-pressed="${selected===choice}" ${locked}>${escape(label)} · ${count}${selected===choice?' · Yours':''}</button>`;
    const pick=ranks.get(c.card);
    const passed=shortlist?pick:options.find(o=>o.up>=rule.minSupporters&&o.up*100>=rule.supportPercent*card.votes);
    const leader=Math.max(...options.map(o=>o.up));
    const leaning=board.reviewDiscarded?'Round reset':passed?(open?'At review threshold':'Met review threshold'):!card.votes?'No votes yet':!single?'Competing limits':leader>card.down?'Leaning for':leader<card.down?'Leaning against':'Vote tied';
    const tone=pick?.status==='pick'?String(pick.rank):pick?.status==='cutoff-tie'?'tie':'';
    const standing=pick?`<strong class="${tone?'pick-badge':'lean'}">${escape(pick.label)}</strong>${options.length>1?` <span class="pick-target">${escape(statuses[pick.target])}</span>`:''}`:`<strong class="lean">${leaning}</strong>`;
    const splits=options.map(o=>`<span class="votes-for">${o.up} ${options.length===1?'for':escape(statuses[o.target])}</span>`);
    splits.push(`<span class="votes-against">${single?card.down:card.keep} ${single?'against':'against all'}</span>`);
    if(!single)for (const o of options) if(o.down)splits.push(`<span class="votes-against">${o.down} against ${escape(statuses[o.target])}</span>`);
    const progress=options.map(o=>{
      const label=single?'':escape(statuses[o.target])+' · ';
      const description=qualificationProgress(o.up,card.votes,open&&!board.reviewDiscarded?rule:null);
      return `<span class="qualification">${label}${escape(description)}</span>`;
    }).join('');
    const detail=options.map(o=>`<section data-option="${o.id}" ${o.id===c.id?'':`id="candidate-${o.id}"`}>
      <div class="case"><strong>${escape(o.starter)} · ${escape(statuses[o.target])}</strong><p>${escape(o.reason)}</p></div>
      ${o.ruling?`<p class="ruling"><b>Ruling</b> ${escape(o.ruling)}</p>`:''}
      ${open && o.starter===board.username&&!o.committed?`<button data-withdraw="${o.id}">Withdraw proposal</button>`:''}
      <details class="comments" data-option="${o.id}"><summary>Comments (${o.comments})</summary><div class="thread"></div></details></section>`).join('');
    return `<article class="candidate" id="candidate-${c.id}" data-id="${c.id}" data-card="${c.card}"${tone?` data-pick="${tone}"`:''}>
      <button class="candidate-art" type="button" data-view-card aria-label="View card details for ${escape(c.name)}">${cardArt(c.card)}</button>
      <details class="proposal"><summary class="proposal-summary"><span class="summary-card"><strong class="candidate-title">${escape(c.name)}</strong>
      <span class="limits"><span class="sr">Current limit </span>${limitBadge(c.published)}${icon('arrow-right')}<span class="sr">Proposed limits </span>${options.map(o=>limitBadge(o.target)).join(' ')}</span></span>
      <span class="tally">${standing}<span class="split">${splits.join(' · ')}</span>${progress}</span><span class="disclose" aria-hidden="true">${icon('chevron-right')}</span>
      ${mine!==undefined?`<span class="row-note">Your vote · ${escape(choiceName(card,mine))}</span>`:''}</summary>
      <div class="proposal-body"><div class="votes">${options.map(o=>button(o.id,single?'For':'For '+statuses[o.target],o.up)).join('')}${button(0,single?'Against':'Against all changes',single?card.down:card.keep)}
      ${open&&mine!==undefined?'<button data-choice="remove">Withdraw my vote</button>':''}</div>${detail}</div></details></article>`;
  }
  const list=$('candidates');
  const opened=[...list.querySelectorAll('.proposal[open]')].map(el=>el.closest('article').id);
  const threads=[...list.querySelectorAll('.comments[open]')].map(el=>[el.dataset.option,el.querySelector('textarea')?.value||'']);
  const focus=document.activeElement, focusRow=focus?.closest('article')?.id;
  list.innerHTML=[...cards.values()].sort((a,b)=>compareVoteTotals(a,b,sort.value)).map(row).join('')||
    `<div class="empty"><p>${open?'Start the first proposal in the card catalogue.':'No proposals this period.'}</p></div>`;
  for(const id of opened){const item=$(id);if(item)item.querySelector('.proposal').open=true;}
  for(const [id,draft] of threads){const thread=list.querySelector(`.comments[data-option="${Number(id)}"]`);if(thread){thread.dataset.draft=draft;thread.open=true;}}
  if(focusRow){
    const selector=focus.hasAttribute('data-choice')?`[data-choice="${focus.dataset.choice}"]`:'.proposal-summary';
    ($(focusRow)?.querySelector(selector)||$(focusRow)?.querySelector('.proposal-summary'))?.focus({preventScroll:true});
  }
}
