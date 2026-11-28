import {compareVoteTotals,qualificationProgress,renderCardBallots,vetoRule} from './card-ballots.js?v=proposal-limit-1.author-edits-1';
import { mountCardViewer } from '/gog/card-viewer.js';

const $ = id => document.getElementById(id);
const escape = x => String(x ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const statuses = {forbidden:'Forbidden (0)', limited:'Limited (1)', semi_limited:'Semi-Limited (2)', unlimited:'Unlimited (3)'};
const date = seconds => new Date(seconds*1000).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/London'})+' UK';
const periodDate = (seconds, archived) => new Date(seconds*1000).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:archived?'2-digit':undefined,timeZone:'Europe/London'});
let board={candidates:[],mine:[],history:[]}, selectedPeriod='', boardRequest=0, chosen;
const active=()=>Boolean(board.period?.active && board.period.deadline>Date.now()/1000);
const notice=text=>{$('feedback').textContent=text;};
async function api(path,body) {
  const init=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-JUSH-Action':'member'},body:JSON.stringify(body)};
  const response=await fetch('/gog/api/'+path,{...init,cache:'no-store'});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error||'Could not complete the request.');
  return result;
}
const action=(name,body)=>api('community/'+name,{window:board.period?.id,...body});
const icon = name => `<svg class="icon" aria-hidden="true"><use href="/gog/assets/jush/icons/sprite.svg#jush-icon-${name}"></use></svg>`;
const limitBadge = status => `<span class="limit ${escape(status)}">${escape(statuses[status] || status)}</span>`;
function cardArt(id, url) {
  return `<span class="card-art" aria-hidden="true">${icon('card-stack')}<img loading="lazy" decoding="async" alt="" src="${escape(url || '/gog/api/cards/'+id+'/image?size=thumb')}"></span>`;
}
document.addEventListener('error', event => {
  if (event.target.matches?.('.card-art img')) event.target.hidden=true;
}, true);
function leaningOf(c) {
  if (c.up > c.down) return 'for';
  if (c.down > c.up) return 'against';
  return c.up ? 'tied' : 'none';
}
const leaningLabels = {for:'Leaning for', against:'Leaning against', tied:'Tied', none:'No votes yet'};
function renderBoard(keepThreads){
  const w=board.period, open=active();
  $('window').textContent=w ? (open?'Voting open until ':'Voting closed · ')+date(w.closed??w.deadline) : 'Voting is closed';
  $('period').innerHTML=board.history.map((p,i)=>`<option value="${i?p.id:''}" title="${date(p.opened)}">${i?'#'+p.id:'Latest'} · ${periodDate(p.opened,i>0)}${p.reset_from?' · reset':''}</option>`).join('')||'<option>No periods yet</option>';
  $('period').value=selectedPeriod;
  $('period').parentElement.hidden=board.history.length<2;
  $('sort').parentElement.hidden=board.candidates.length<2;
  $('window').parentElement.classList.toggle('open',open);
  $('account').textContent=board.username?'Sign out · '+board.username:'Player sign in';
  $('mine').hidden=!board.username;
  $('my-proposals').hidden=true;
  if(!board.shortlist)$('pick-summary').hidden=true;
  if(board.cardBallots){
    if(!keepThreads)for(const thread of $('candidates').querySelectorAll('.comments[open]'))thread.open=false;
    renderCardBallots(board,{$,escape,statuses,limitBadge,cardArt,icon,open});
    viewer.syncProposalAction();
    return;
  }
  $('candidate-count').hidden=!board.candidates.length;
  $('candidate-count').textContent=String(board.candidates.length);
  const totals = {for:0, against:0, tied:0, none:0};
  for (const candidate of board.candidates) totals[leaningOf(candidate)]++;
  const overview = Object.entries(totals).filter(([,n])=>n).map(([lean,n])=>
    lean === 'none' ? n+' awaiting votes' : n+' '+leaningLabels[lean].toLowerCase());
  const cardTurnout = new Map();
  let periodVotes = 0;
  for (const c of board.candidates) {
    const votes = c.up+c.down;
    periodVotes += votes;
    cardTurnout.set(c.card,(cardTurnout.get(c.card)||0)+votes);
  }
  $('board-leaning').textContent = [periodVotes+' '+(periodVotes===1?'vote':'votes'),...overview].join(' · ');
  const rule = board.reviewRule;
  $('review-rules').hidden = !rule;
  if (rule) $('review-rules').querySelector('p').textContent =
    `At close, a proposed limit needs at least ${rule.minSupporters} supporters and ${rule.supportPercent}% of all votes on that card, across every proposed limit. Each player counts once per card. ${vetoRule} Kirk publishes the official banlist manually.`;
  $('window').parentElement.classList.toggle('open',open);
  $('account').textContent=board.username?'Sign out · '+board.username:'Player sign in';
  $('mine').hidden=!board.username;
  $('mine').querySelector('summary').textContent=`My votes · ${board.mine.length} of 3 used`;
  $('mine').querySelector('div').innerHTML=board.mine.map(v=>{
    const c=board.candidates.find(c=>c.id===v.candidate);
    return c?`<a href="#candidate-${c.id}">${escape(c.name)} · ${statuses[c.target]} · ${v.direction===1?'Upvote':'Downvote'}</a>`:'';
  }).join('')||'<p>You have three available slots.</p>';
  const list = $('candidates');
  const focused = document.activeElement;
  const focusedRow = focused?.closest('.candidate')?.id;
  const openRows = new Set([...list.querySelectorAll('.proposal[open]')].map(el => el.closest('article').id));
  const openThreads = new Map(keepThreads ? [...list.querySelectorAll('.comments[open]')].map(el => [el.closest('article').id, el.querySelector('textarea')?.value]) : []);
  list.innerHTML=sortedCandidates().map(c=>{
    const mine=board.mine.find(v=>v.candidate===c.id);
    const starter=mine && c.starter===board.username;
    const disabled=!open || Boolean(starter && c.committed);
    const btn=(direction,label,count)=>`<button data-vote="${direction}" aria-pressed="${mine?.direction===direction}" ${disabled||(starter&&direction<0)?'disabled':''}>${label} ${count}${mine?.direction===direction?' · Yours':''}</button>`;
    const others=board.candidates.filter(o=>o.card===c.card && o.id!==c.id);
    const lean = leaningOf(c);
    const notes = [mine && (mine.direction===1 ? 'Your upvote' : 'Your downvote'), c.ruling && 'Ruling available'].filter(Boolean);
    return `<article class="candidate" id="candidate-${c.id}" data-id="${c.id}">
      <button type="button" class="candidate-art" data-view-card aria-label="View card details for ${escape(c.name)}">${cardArt(c.card)}</button>
      <details class="proposal"><summary class="proposal-summary">
        <span class="summary-card"><strong class="candidate-title">${escape(c.name)}</strong>
        <span class="limits"><span class="sr">Published limit </span>${limitBadge(c.published)}${icon('arrow-right')}<span class="sr">Proposed limit </span>${limitBadge(c.target)}</span></span>
        <span class="tally"><strong class="lean lean-${lean}">${leaningLabels[lean]}</strong><span class="split"><span class="votes-for">${c.up} for</span> · <span class="votes-against">${c.down} against</span></span><span class="qualification">${escape(qualificationProgress(c.up,cardTurnout.get(c.card),open?rule:null))}</span></span>
        <span class="disclose" aria-hidden="true">${icon('chevron-right')}</span>
        ${notes.length ? `<span class="row-note">${notes.join(' · ')}</span>` : ''}
      </summary><div class="proposal-body">
      <div class="case"><strong>${escape(c.starter)}</strong><p>${escape(c.reason)}</p></div>
      ${open && c.starter===board.username?`<button type="button" data-edit-reason="${c.id}">Edit proposal text</button>`:''}
      ${rule && others.length ? `<p class="target-share">${c.up} of ${cardTurnout.get(c.card)} votes on this card support this limit.</p>` : ''}
      ${c.ruling?`<p class="ruling"><b>Ruling</b> ${escape(c.ruling)}</p>`:''}
      <div class="votes">${btn(1,'Upvote',c.up)}${btn(-1,'Downvote',c.down)}${mine&&open&&!disabled?`<button data-vote="0">${starter?'Withdraw proposal':'Remove my vote'}</button>`:''}</div>
      ${others.length?`<p>Other proposals · ${others.map(o=>`<a href="#candidate-${o.id}">${statuses[o.target]}</a>`).join(' · ')}</p>`:''}
      <details class="comments"><summary>Comments (${c.comments})</summary><div class="thread"></div></details></div></details></article>`;
  }).join('')||`<div class="empty">${icon('card-stack')}<div><h3>${open?'Start the first proposal':'No proposals this period'}</h3><p>${open?'Choose a card in the catalogue and propose its new limit.':'Browse the published card limits below.'}</p></div></div>`;
  for (const id of openRows) {
    const row = $(id);
    if (!row) continue;
    row.querySelector('.proposal').open = true;
    if (openThreads.has(id)) {
      const comments = row.querySelector('.comments');
      comments.dataset.draft = openThreads.get(id) || '';
      comments.open = true;
    }
  }
  if (focusedRow) {
    const row = $(focusedRow);
    const control = focused.matches('[data-vote]') ? row?.querySelector(`[data-vote="${focused.dataset.vote}"]:enabled`)
      : focused.matches('[data-view-card]') ? row?.querySelector('[data-view-card]') : null;
    (control || row?.querySelector('.proposal-summary'))?.focus({preventScroll:true});
  }
  viewer.syncProposalAction();
}
function sortedCandidates() {
  return [...board.candidates].sort((a,b)=>compareVoteTotals(a,b,$('sort').value));
}
async function refresh(){
  const request=++boardRequest;
  const data=await api('community/board'+(selectedPeriod?'?window='+selectedPeriod:''));
  if(request!==boardRequest) return;
  const sameMember = data.username === board.username;
  const samePeriod = data.period?.id === board.period?.id;
  board=data; renderBoard(sameMember && samePeriod);
}
function signIn(){ clearAuthError(); $('auth').showModal(); }
function usable(){if(!active())throw Error('Voting has closed.');if(!board.username){signIn();return false;}return true;}
function previous(card,next){
  const mine=board.mine.find(v=>v.card===card);
  if(mine && mine.candidate!==next){
    const old=board.candidates.find(c=>c.id===mine.candidate);
    if(old.starter===board.username && old.committed)throw Error('Your proposal has received a vote and its slot is committed.');
    if(!confirm(`Move your slot off “${old.name} to ${statuses[old.target]}” and onto this proposal?${old.starter===board.username?' This withdraws your earlier proposal.':''}`))return null;
  }
  return mine?.candidate||0;
}
async function loadThread(details,cid){
  const thread=details.querySelector('.thread');
  const {comments}=await api('community/thread?candidate='+cid);
  details.querySelector('summary').textContent=`Comments (${comments.length})`;
  thread.innerHTML=comments.map(c=>`<div><p><b>${escape(c.username)}</b> <span>${escape(c.text)}</span></p>
    ${active() && c.editKey && c.username===board.username?`<div class="tools" data-comment-key="${escape(c.editKey)}">
      <button type="button" data-edit-comment>Edit comment</button><button type="button" data-delete-comment>Delete comment</button></div>`:''}</div>`).join('')||'<p>Be the first to comment.</p>';
  if(active()&&board.username)thread.insertAdjacentHTML('beforeend','<form><label>Comment<textarea required maxlength="1000" name="text" rows="2"></textarea></label><button>Post comment</button></form>');
}
function editText(path, fields, previous) {
  const dialog=$('text-editor'), form=dialog.querySelector('form');
  const field=form.elements.text, error=form.querySelector('[role=alert]');
  const save=form.querySelector('.primary'), cancel=form.querySelector('[data-close]');
  const comment=path==='edit-comment';
  $('edit-heading').textContent=comment?'Edit comment':'Edit proposal text';
  $('edit-label').textContent=comment?'Your comment':'Your reason';
  field.maxLength=comment?1000:200;
  field.value=previous;
  error.textContent='';
  const period=board.period.id;
  form.onsubmit=async event=>{
    event.preventDefault();
    if(save.disabled)return;
    const text=field.value.trim();
    if(!text){error.textContent='Enter some text to save.';field.focus();return;}
    save.disabled=cancel.disabled=true;
    try {
      await action(path,{...fields,window:period,previous,text});
      dialog.close();
      notice(comment?'Comment updated.':'Proposal text updated.');
      await refresh().catch(e=>notice(e.message));
    } catch(e){error.textContent=e.message;}
    finally{save.disabled=cancel.disabled=false;}
  };
  dialog.oncancel=event=>{if(save.disabled)event.preventDefault();};
  dialog.showModal();
  field.focus();
}
$('candidates').addEventListener('toggle',event=>{
  const details = event.target;
  if (!details.matches('.comments[open]')) return;
  loadThread(details,details.dataset.option||details.closest('article').dataset.id).then(()=>{
    const input = details.querySelector('textarea');
    if (input && details.dataset.draft) input.value = details.dataset.draft;
    delete details.dataset.draft;
  }).catch(e=>notice(e.message));
},true);
$('candidates').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target,candidate=Number(form.closest('.comments').dataset.option||form.closest('article').dataset.id),button=form.querySelector('button');
  const text=form.elements.text.value.trim(); if(!text)return;
  button.disabled=true;
  try{
    if(form.dataset.lastText!==text){form.dataset.key=crypto.randomUUID();form.dataset.lastText=text;}
    await action('comment',{candidate,text,requestId:form.dataset.key});
    const details=form.closest('details');await loadThread(details,candidate);
  }catch(e){notice(e.message);}finally{button.disabled=false;}
});
$('candidates').addEventListener('click',async event=>{
  const authorButton=event.target.closest('[data-edit-reason],[data-edit-comment],[data-delete-comment]');
  if(authorButton){
    try{
      if(!usable())return;
      if(authorButton.hasAttribute('data-edit-reason')){
        const candidate=board.candidates.find(c=>c.id===Number(authorButton.dataset.editReason));
        editText('edit-reason',{candidate:candidate.id},candidate.reason);
      }else{
        const details=authorButton.closest('.comments');
        const candidate=Number(details.dataset.option||details.closest('article').dataset.id);
        const controls=authorButton.closest('[data-comment-key]');
        const previous=controls.parentElement.querySelector('p span').textContent;
        const fields={candidate,editKey:controls.dataset.commentKey};
        if(authorButton.hasAttribute('data-edit-comment'))editText('edit-comment',fields,previous);
        else if(confirm('Delete your comment?')){
          authorButton.disabled=true;
          await action('delete-comment',{...fields,previous});
          notice('Comment deleted.');
          await refresh();
        }
      }
    }catch(e){notice(e.message);}finally{authorButton.disabled=false;}
    return;
  }
  if (event.target.closest('[data-view-card]')) {
    const candidate = board.candidates.find(c => c.id === Number(event.target.closest('article').dataset.id));
    if (candidate) viewer.openCardDetail({ id: candidate.card, name: candidate.name, status: candidate.published });
    return;
  }
  const modern=event.target.closest('[data-choice],[data-withdraw]');
  if(modern){
    try{
      if(!usable())return;
      const card=Number(modern.closest('article').dataset.card);
      if(modern.hasAttribute('data-withdraw')){
        if(!confirm('Withdraw this proposal and its discussion? The card still counts toward your proposal limit for this window.'))return;
        modern.disabled=true;
        await action('withdraw-nomination',{card,candidate:Number(modern.dataset.withdraw)});
      }else{
        const choice=modern.dataset.choice==='remove'?null:Number(modern.dataset.choice);
        const previous=board.mine.find(v=>v.card===card)?.choice??null;
        if(choice===previous || modern.getAttribute('aria-pressed')==='true')return;
        modern.disabled=true;
        await action('choose',{card,choice,previous});
      }
      notice('Saved.');
    }catch(e){notice(e.message);}finally{if(modern.disabled)await refresh().catch(e=>notice(e.message));}
    return;
  }
  const b=event.target.closest('[data-vote]'); if(!b)return;
  try{
    if(!usable())return;
    const c=board.candidates.find(c=>c.id===Number(b.closest('article').dataset.id));
    let direction=Number(b.dataset.vote);
    if(b.getAttribute('aria-pressed')==='true')direction=0;
    if(!direction && c.starter===board.username && !confirm('Withdraw this proposal and its discussion?'))return;
    const prior=previous(c.card,c.id);if(prior===null)return;
    b.disabled=true;await action('vote',{candidate:c.id,direction,previous:prior});notice('Vote updated.');
  }catch(e){notice(e.message);}finally{if(!b.closest('dialog') && b.disabled)await refresh().catch(e=>notice(e.message));}
});
async function proposeCard(card) {
  try{if(!usable())return;chosen=board.cardBallots?{...card,status:(await api('community/opening-limit?window='+board.period.id+'&card='+card.id)).status}:card;
    const f=$('compose');f.reset();f.querySelector('[role=alert]').textContent='';
    $('proposed-card').textContent=chosen.name+' · '+statuses[chosen.status];
    f.elements.target.innerHTML=Object.entries(statuses).filter(([s])=>s!==chosen.status).map(([s,l])=>`<option value="${s}">${l}</option>`).join('');
    $('proposal').showModal();
  }catch(e){notice(e.message);}
}
$('compose').onsubmit=async event=>{
  event.preventDefault();const f=event.target,b=f.querySelector('.primary');
  try{const target=f.elements.target.value,existing=board.candidates.find(c=>c.card===chosen.id&&c.target===target);
    if(existing){$('proposal').close();location.hash='candidate-'+existing.id;revealCandidate(location.hash);notice('This proposal already exists. You can vote on it here.');return;}
    const prior=board.cardBallots?0:previous(chosen.id,0);if(prior===null)return;
    b.disabled=true;await action(board.cardBallots?'nominate':'propose',{card:chosen.id,target,reason:f.elements.reason.value,previous:prior});
    $('proposal').close();await refresh();notice('Your proposal is open.');
  }catch(e){f.querySelector('[role=alert]').textContent=e.message;}finally{b.disabled=false;}
};
const hex=buf=>Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,'0')).join('');
async function proof(password,salt){const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(salt),iterations:310000},key,256));}
const auth=$('credentials');
const usernameField=auth.elements.username;
const passwordField=auth.elements.password, codeField=auth.elements.code;
const authError=auth.querySelector('[role=alert]'), authButton=auth.querySelector('.primary');
function clearAuthError(){
  auth.querySelector('[aria-invalid]')?.removeAttribute('aria-invalid');
  authError.textContent='';
}
function invalidField(field,message){
  field.setAttribute('aria-invalid','true');
  field.focus();
  authError.textContent=message;
}
auth.addEventListener('input',clearAuthError);
auth.elements.mode.onchange=()=>{
  const login=auth.elements.mode.value==='login';
  clearAuthError();
  $('code-field').hidden=login;
  codeField.required=!login;
  passwordField.minLength=login?1:12;
  passwordField.autocomplete=login?'current-password':'new-password';
  $('password-help').hidden=login;
};
auth.onsubmit=async event=>{
  event.preventDefault();
  if(authButton.disabled)return;
  clearAuthError();
  const mode=auth.elements.mode.value;
  const username=usernameField.value.replace(/^[\s\u200B]+|[\s\u200B]+$/g,'');
  usernameField.value=username;
  if(!/^[A-Za-z0-9_-]{3,32}$/.test(username))
    return invalidField(usernameField,'Choose a username of 3–32 characters using A–Z, a–z, 0–9, hyphens or underscores.');
  const password=passwordField.value, code=codeField.value.trim();
  if(!password || (mode!=='login' && password.length<12))
    return invalidField(passwordField,mode==='login'?'Enter your password.':'Use at least 12 characters for your password.');
  if(mode!=='login' && !code)return invalidField(codeField,'Enter your one-use code.');
  authButton.disabled=true;
  authButton.textContent=mode==='join'?'Creating account…':mode==='recover'?'Resetting password…':'Signing in…';
  try{
    const salt=mode==='login'?(await api('community/salt?username='+encodeURIComponent(username))).salt:hex(crypto.getRandomValues(new Uint8Array(16)));
    await action(mode,{username,code,salt,proof:await proof(password,salt)});
    auth.reset();auth.elements.mode.onchange();$('auth').close();
  }catch(e){authError.textContent=e.message;return;}
  finally{authButton.disabled=false;authButton.textContent='Continue';}
  notice('Signed in.');
  await refresh().catch(e=>notice('Signed in. '+e.message));
};
$('account').onclick=async()=>{if(!board.username){signIn();return;}try{await action('logout',{});await refresh();notice('Signed out.');}catch(e){notice(e.message);}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('period').onchange=e=>{selectedPeriod=e.target.value;refresh().catch(e=>notice(e.message));};
$('sort').onchange=()=>{
  if(board.cardBallots){renderBoard(true);return;}
  for (const c of sortedCandidates()) $('candidates').append($('candidate-'+c.id));
};
function revealCandidate(hash) {
  if (!/^#candidate-\d+$/.test(hash)) return;
  const row = $(hash.slice(1))?.closest('article');
  if (!row) return;
  row.querySelector('.proposal').open = true;
  row.scrollIntoView({block:'nearest'});
}
$('board').addEventListener('click',event=>{
  const link = event.target.closest('a[href^="#candidate-"]');
  if (link) revealCandidate(link.hash);
});
window.addEventListener('hashchange',()=>revealCandidate(location.hash));
function openScannedInvite(){
  if(!location.hash.startsWith('#invite='))return;
  const code=location.hash.slice('#invite='.length);
  history.replaceState(history.state,'',location.pathname+location.search);
  auth.elements.mode.value='join';
  auth.elements.mode.onchange();
  const valid=/^[a-f0-9]{32}$/.test(code);
  auth.elements.code.value=valid?code:'';
  signIn();
  if(!valid)auth.querySelector('[role=alert]').textContent='This invitation link is incomplete. Scan it again or enter your one-use code.';
}
window.addEventListener('hashchange',openScannedInvite);
const catalogue = $('catalogue').attachShadow({ mode: 'open' });
catalogue.innerHTML = `
  <link rel="stylesheet" href="/gog/styles.css">
  <link rel="stylesheet" href="/gog/house-format/house-format.css">
  <link rel="stylesheet" href="/gog/voting/viewer.css">
  <div class="house-format-page"><div id="viewer"></div><div id="toast-region" class="toast-region" role="status"></div></div>`;
const viewer = mountCardViewer(catalogue.getElementById('viewer'), { onPropose: proposeCard, canPropose: active });
openScannedInvite();
refresh().then(()=>{revealCandidate(location.hash);if(location.hash==='#account'&&!board.username)signIn();}).catch(e=>notice(e.message));
setInterval(()=>{if(document.hidden)return;
  if(board.period?.active&&!active() || (!document.querySelector('dialog[open],.comments[open]')&&!catalogue.querySelector('dialog[open]')&&!selectedPeriod))refresh().catch(e=>notice(e.message));
},20000);
