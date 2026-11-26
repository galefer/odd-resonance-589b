export function renderCardBallots(board,ui){
  const {$,escape,statuses,limitBadge,cardArt,icon,open}=ui;
  const cards=new Map();
  for(const c of [...board.candidates].sort((a,b)=>a.id-b.id)){
    if(!cards.has(c.card))cards.set(c.card,{card:c.card,first:c,options:[],votes:0,keep:0});
    cards.get(c.card).options.push(c);
  }
  for(const v of board.counts){
    const card=cards.get(v.card);
    if(card){card.votes+=v.votes;if(v.choice===0)card.keep=v.votes;}
  }
  const score=card=>{
    switch($('sort').value){
      case 'new':return Math.max(...card.options.map(c=>c.id));
      case 'up':return Math.max(...card.options.map(c=>c.up));
      case 'down':return card.keep+card.options.reduce((n,c)=>n+c.down,0);
      default:return card.votes;
    }
  };
  const rule=board.reviewRule;
  const total=board.counts.reduce((n,v)=>n+v.votes,0);
  $('candidate-count').hidden=false;
  $('candidate-count').textContent=cards.size;
  $('sort').parentElement.hidden=cards.size<2;
  $('board-leaning').textContent=total+' '+(total===1?'vote':'votes')+' · Review cut: '+rule.supportPercent+'% and '+rule.minSupporters+' supporters';
  $('review-rules').hidden=false;
  $('review-rules').querySelector('p').textContent=`Choose one limit per card. You can vote on every card and propose up to three distinct cards. At close, an exact limit needs ${rule.supportPercent}% of that card’s ballots and ${rule.minSupporters} supporters. Both rules are locked for this window. Kirk reviews qualifying changes and edits the banlist manually.`;
  const myBallots=new Map(board.mine.map(b=>[b.card,b.choice]));
  function choiceName(card,choice){
    if(choice===0)return 'Keep '+statuses[card.first.published];
    const option=card.options.find(c=>c.id===Math.abs(choice));
    return (choice<0?'Against ':'')+(statuses[option?.target]||'earlier option');
  }
  function cardLink(card,label){return `<a href="#candidate-${card.first.id}">${escape(card.first.name)} · ${escape(label)}</a>`;}
  $('mine').querySelector('summary').textContent='My votes · '+board.mine.length;
  $('mine').querySelector('div').innerHTML=board.mine.map(v=>{
    const card=cards.get(v.card);return card?cardLink(card,choiceName(card,v.choice)):'';
  }).join('')||'<p>You can vote on every proposed card.</p>';
  $('my-proposals').hidden=!board.username;
  $('my-proposals').querySelector('summary').textContent=`My proposals · ${board.nominations.length} of 3 cards used`;
  $('my-proposals').querySelector('div').innerHTML=board.nominations.map(n=>{
    const card=cards.get(n.card), own=card?.options.find(o=>o.starter===board.username);
    return own?cardLink(card,statuses[own.target]):`<p>${escape(n.name||('Card '+n.card))} · withdrawn</p>`;
  }).join('')||'<p>Choose a card in the catalogue to propose a limit.</p>';
  function row(card){
    const c=card.first, options=card.options.sort((a,b)=>Object.values(statuses).indexOf(statuses[a.target])-Object.values(statuses).indexOf(statuses[b.target]));
    const mine=myBallots.get(card.card), locked=open?'':'disabled';
    const button=(choice,label,count)=>`<button type="button" data-choice="${choice}" class="${choice===0?'keep-choice':'change-choice'}" aria-pressed="${mine===choice}" ${locked}>${escape(label)} · ${count}${mine===choice?' · Yours':''}</button>`;
    const passed=options.find(o=>o.up>=rule.minSupporters&&o.up*100>=rule.supportPercent*card.votes);
    const leader=Math.max(...options.map(o=>o.up));
    const leaning=passed?(open?'At review threshold':'Met review threshold'):!card.votes?'No votes yet':options.length>1?'Competing limits':leader>card.keep+c.down?'Leaning for':leader<card.keep+c.down?'Leaning against':'Tied';
    const splits=options.map(o=>`<span class="votes-for">${o.up} ${options.length===1?'for':escape(statuses[o.target])}</span>`);
    splits.push(`<span class="votes-against">${card.keep} keep</span>`);
    for (const o of options) if(o.down)splits.push(`<span class="votes-against">${o.down} against ${options.length>1?escape(statuses[o.target]):''}</span>`);
    const detail=options.map(o=>`<section data-option="${o.id}" ${o.id===c.id?'':`id="candidate-${o.id}"`}>
      <div class="case"><strong>${escape(o.starter)} · ${escape(statuses[o.target])}</strong><p>${escape(o.reason)}</p></div>
      ${o.ruling?`<p class="ruling"><b>Ruling</b> ${escape(o.ruling)}</p>`:''}
      ${open && o.starter===board.username&&!o.committed?`<button data-withdraw="${o.id}">Withdraw proposal</button>`:''}
      <details class="comments" data-option="${o.id}"><summary>Comments (${o.comments})</summary><div class="thread"></div></details></section>`).join('');
    return `<article class="candidate" id="candidate-${c.id}" data-id="${c.id}" data-card="${c.card}">
      <button class="candidate-art" type="button" data-view-card aria-label="View card details for ${escape(c.name)}">${cardArt(c.card)}</button>
      <details class="proposal"><summary class="proposal-summary"><span class="summary-card"><strong class="candidate-title">${escape(c.name)}</strong>
      <span class="limits"><span class="sr">Current limit </span>${limitBadge(c.published)}${icon('arrow-right')}<span class="sr">Proposed limits </span>${options.map(o=>limitBadge(o.target)).join(' ')}</span></span>
      <span class="tally"><strong class="lean">${leaning}</strong><span class="split">${splits.join(' · ')}</span></span><span class="disclose" aria-hidden="true">${icon('chevron-right')}</span>
      ${mine!==undefined?`<span class="row-note">Your vote · ${escape(choiceName(card,mine))}</span>`:''}</summary>
      <div class="proposal-body"><div class="votes">${button(0,'Keep '+statuses[c.published],card.keep)}${options.map(o=>button(o.id,statuses[o.target],o.up)).join('')}
      ${open&&mine!==undefined?'<button data-choice="remove">Withdraw my vote</button>':''}</div>${detail}</div></details></article>`;
  }
  const list=$('candidates');
  const opened=[...list.querySelectorAll('.proposal[open]')].map(el=>el.closest('article').id);
  const threads=[...list.querySelectorAll('.comments[open]')].map(el=>[el.dataset.option,el.querySelector('textarea')?.value||'']);
  const focus=document.activeElement, focusRow=focus?.closest('article')?.id;
  list.innerHTML=[...cards.values()].sort((a,b)=>score(b)-score(a)||b.first.id-a.first.id).map(row).join('')||
    `<div class="empty"><p>${open?'Start the first proposal in the card catalogue.':'No proposals this period.'}</p></div>`;
  for(const id of opened){const item=$(id);if(item)item.querySelector('.proposal').open=true;}
  for(const [id,draft] of threads){const thread=list.querySelector(`.comments[data-option="${Number(id)}"]`);if(thread){thread.dataset.draft=draft;thread.open=true;}}
  if(focusRow){
    const selector=focus.hasAttribute('data-choice')?`[data-choice="${focus.dataset.choice}"]`:'.proposal-summary';
    ($(focusRow)?.querySelector(selector)||$(focusRow)?.querySelector('.proposal-summary'))?.focus({preventScroll:true});
  }
}
