import { mountCardViewer } from '/gog/card-viewer.js';

const $ = id => document.getElementById(id);
const escape = x => String(x ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const statuses = {forbidden:'Forbidden (0)', limited:'Limited (1)', semi_limited:'Semi-Limited (2)', unlimited:'Unlimited (3)'};
const date = seconds => new Date(seconds*1000).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/London'})+' UK';
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
function renderBoard(){
  const w=board.period, open=active();
  $('window').textContent=w ? (open?'Voting open until ':'Voting closed · ')+date(w.closed??w.deadline) : 'Voting is closed';
  $('period').innerHTML=board.history.map((p,i)=>`<option value="${i?p.id:''}">${i?'Period '+p.id:'Latest period'} · ${date(p.opened)}${p.reset_from?' · reset':''}</option>`).join('')||'<option>No periods yet</option>';
  $('period').value=selectedPeriod;
  $('period').parentElement.hidden=board.history.length<2;
  $('sort').parentElement.hidden=board.candidates.length<2;
  $('candidate-count').hidden=!board.candidates.length;
  $('candidate-count').textContent=String(board.candidates.length);
  $('window').parentElement.classList.toggle('open',open);
  $('account').textContent=board.username?'Sign out · '+board.username:'Player sign in';
  $('mine').hidden=!board.username;
  $('mine').querySelector('summary').textContent=`My votes · ${board.mine.length} of 3 used`;
  $('mine').querySelector('div').innerHTML=board.mine.map(v=>{
    const c=board.candidates.find(c=>c.id===v.candidate);
    return c?`<a href="#candidate-${c.id}">${escape(c.name)} · ${statuses[c.target]} · ${v.direction===1?'Upvote':'Downvote'}</a>`:'';
  }).join('')||'<p>You have three available slots.</p>';
  const score=c=>({participation:c.up+c.down,up:c.up,down:c.down,new:c.id})[$('sort').value];
  $('candidates').innerHTML=[...board.candidates].sort((a,b)=>score(b)-score(a)||b.id-a.id).map(c=>{
    const mine=board.mine.find(v=>v.candidate===c.id);
    const starter=mine && c.starter===board.username;
    const disabled=!open || Boolean(starter && c.committed);
    const btn=(direction,label,count)=>`<button data-vote="${direction}" aria-pressed="${mine?.direction===direction}" ${disabled||(starter&&direction<0)?'disabled':''}>${label} ${count}${mine?.direction===direction?' · Yours':''}</button>`;
    const others=board.candidates.filter(o=>o.card===c.card && o.id!==c.id);
    return `<article class="candidate" id="candidate-${c.id}" data-id="${c.id}">
      <div class="proposal-head"><button type="button" class="candidate-art" data-view-card aria-label="View details for ${escape(c.name)}">${cardArt(c.card)}</button><div><h3><button type="button" class="candidate-name" data-view-card>${escape(c.name)}</button></h3>
      <div class="limits"><div><small>Published</small>${limitBadge(c.published)}</div>${icon('arrow-right')}<div><small>Proposed</small>${limitBadge(c.target)}</div></div></div></div>
      <div class="case"><strong>${escape(c.starter)}</strong><p>${escape(c.reason)}</p></div>
      ${c.ruling?`<p class="ruling"><b>Ruling</b> ${escape(c.ruling)}</p>`:''}
      <div class="votes">${btn(1,'Upvote',c.up)}${btn(-1,'Downvote',c.down)}${mine&&open&&!disabled?`<button data-vote="0">${starter?'Withdraw proposal':'Remove my vote'}</button>`:''}</div>
      ${others.length?`<p>Other proposals · ${others.map(o=>`<a href="#candidate-${o.id}">${statuses[o.target]}</a>`).join(' · ')}</p>`:''}
      <details><summary>Comments (${c.comments})</summary><div class="thread"></div></details></article>`;
  }).join('')||`<div class="empty">${icon('card-stack')}<div><h3>${open?'Start the first proposal':'No proposals this period'}</h3><p>${open?'Choose a card in the catalogue and propose its new limit.':'Browse the published card limits below.'}</p></div></div>`;
  viewer.syncProposalAction();
}
async function refresh(){
  const request=++boardRequest;
  const data=await api('community/board'+(selectedPeriod?'?window='+selectedPeriod:''));
  if(request!==boardRequest) return;
  board=data; renderBoard();
}
function signIn(){ clearUsernameError(); $('credentials').querySelector('[role=alert]').textContent=''; $('auth').showModal(); }
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
  thread.innerHTML=comments.map(c=>`<p><b>${escape(c.username)}</b> ${escape(c.text)}</p>`).join('')||'<p>Be the first to comment.</p>';
  if(active()&&board.username)thread.insertAdjacentHTML('beforeend','<form><label>Comment<textarea required maxlength="1000" name="text" rows="2"></textarea></label><button>Post comment</button></form>');
}
$('candidates').addEventListener('toggle',event=>{
  if(event.target.matches('details[open]'))loadThread(event.target,event.target.closest('article').dataset.id).catch(e=>notice(e.message));
},true);
$('candidates').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target,candidate=Number(form.closest('article').dataset.id),button=form.querySelector('button');
  const text=form.elements.text.value.trim(); if(!text)return;
  button.disabled=true;
  try{
    if(form.dataset.lastText!==text){form.dataset.key=crypto.randomUUID();form.dataset.lastText=text;}
    await action('comment',{candidate,text,requestId:form.dataset.key});
    const details=form.closest('details');await loadThread(details,candidate);
    const data=await api('community/thread?candidate='+candidate);
    details.querySelector('summary').textContent=`Comments (${data.comments.length})`;
  }catch(e){notice(e.message);}finally{button.disabled=false;}
});
$('candidates').addEventListener('click',async event=>{
  if (event.target.closest('[data-view-card]')) {
    const candidate = board.candidates.find(c => c.id === Number(event.target.closest('article').dataset.id));
    if (candidate) viewer.openCardDetail({ id: candidate.card, name: candidate.name, status: candidate.published });
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
function proposeCard(card) {
  try{if(!usable())return;chosen=card;
    const f=$('compose');f.reset();f.querySelector('[role=alert]').textContent='';
    $('proposed-card').textContent=chosen.name+' · '+statuses[chosen.status];
    f.elements.target.innerHTML=Object.entries(statuses).filter(([s])=>s!==chosen.status).map(([s,l])=>`<option value="${s}">${l}</option>`).join('');
    $('proposal').showModal();
  }catch(e){notice(e.message);}
}
$('compose').onsubmit=async event=>{
  event.preventDefault();const f=event.target,b=f.querySelector('.primary');
  try{const target=f.elements.target.value,existing=board.candidates.find(c=>c.card===chosen.id&&c.target===target);
    if(existing){$('proposal').close();location.hash='candidate-'+existing.id;notice('This proposal already exists. You can vote on it here.');return;}
    const prior=previous(chosen.id,0);if(prior===null)return;
    b.disabled=true;await action('propose',{card:chosen.id,target,reason:f.elements.reason.value,previous:prior});
    $('proposal').close();await refresh();notice('Your proposal is open.');
  }catch(e){f.querySelector('[role=alert]').textContent=e.message;}finally{b.disabled=false;}
};
const hex=buf=>Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,'0')).join('');
async function proof(password,salt){const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(salt),iterations:310000},key,256));}
const auth=$('credentials');
const usernameField=auth.elements.username;
function clearUsernameError(){
  if(usernameField.hasAttribute('aria-invalid')){
    usernameField.removeAttribute('aria-invalid');
    auth.querySelector('[role=alert]').textContent='';
  }
}
usernameField.addEventListener('input',clearUsernameError);
auth.elements.mode.onchange=()=>{const login=auth.elements.mode.value==='login';$('code-field').hidden=login;auth.elements.code.required=!login;auth.elements.password.minLength=login?1:12;auth.elements.password.autocomplete=login?'current-password':'new-password';};
auth.onsubmit=async event=>{
  event.preventDefault();
  const username=usernameField.value.replace(/^[\s\u200B]+|[\s\u200B]+$/g,'');
  usernameField.value=username;
  clearUsernameError();
  if(!/^[A-Za-z0-9_-]{3,32}$/.test(username)){
    usernameField.setAttribute('aria-invalid','true');
    auth.querySelector('[role=alert]').textContent='Choose a username of 3–32 characters using A–Z, a–z, 0–9, hyphens or underscores.';
    usernameField.focus();
    return;
  }
  const b=auth.querySelector('.primary');b.disabled=true;
  try{const mode=auth.elements.mode.value;
    const salt=mode==='login'?(await api('community/salt?username='+encodeURIComponent(username))).salt:hex(crypto.getRandomValues(new Uint8Array(16)));
    await action(mode,{username,code:auth.elements.code.value.trim(),salt,proof:await proof(auth.elements.password.value,salt)});
    auth.reset();auth.elements.mode.onchange();$('auth').close();await refresh();notice('Signed in.');
  }catch(e){auth.querySelector('[role=alert]').textContent=e.message;}finally{b.disabled=false;}
};
$('account').onclick=async()=>{if(!board.username){signIn();return;}try{await action('logout',{});await refresh();notice('Signed out.');}catch(e){notice(e.message);}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('period').onchange=e=>{selectedPeriod=e.target.value;refresh().catch(e=>notice(e.message));};
$('sort').onchange=renderBoard;
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
refresh().then(()=>{if(location.hash==='#account'&&!board.username)signIn();}).catch(e=>notice(e.message));
setInterval(()=>{if(document.hidden)return;
  if(board.period?.active&&!active() || (!document.querySelector('dialog[open],article details[open]')&&!catalogue.querySelector('dialog[open]')&&!selectedPeriod))refresh().catch(e=>notice(e.message));
},20000);
