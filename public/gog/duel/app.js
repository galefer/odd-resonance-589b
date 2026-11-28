import {api,esc,avatar,nameButton,resultName,statusName,artUrl} from './common.js';
import {DeckDatabase} from '../deckbuilder/persistence.js';
const $=id=>document.getElementById(id),dlg=$('player-dialog'),content=$('dialog-body');
const signIn='/gog/voting/?return=duel#account';
let board,sequence=0,offset=0,currentProfile=null,search='',selectedArt=null,localDecks,searchTimer,dialogVersion=0,usedRequest=null;
const notice=message=>{$(dlg.open?'dialog-error':'feedback').textContent=message;};
const btn=(label,key,id,primary=false)=>'<button type="button" data-action="'+key+'" data-id="'+Number(id||0)+'" class="'+(primary?'primary':'')+'">'+esc(label)+'</button>';
const textDate=day=>new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric'}).format(new Date(day+'T12:00:00Z'));
const stats=p=>(p.n<4?'Provisional · ':'')+esc(p.rank)+' · '+p.w+'W / '+p.l+'L / '+p.d+'D · '+p.n+' matches · '+(p.winRate===null?'—':p.winRate+'%')+' wins';
function timer(m){return m.paused?'Approval timer paused':'Auto-approves in <span class="timer" data-due="'+m.due+'"></span>';}
function clocks(){for(const el of document.querySelectorAll('[data-due]')){const t=Math.max(0,Math.ceil(Number(el.dataset.due)-Date.now()/1000-offset));el.textContent=Math.floor(t/60)+'m '+String(t%60).padStart(2,'0')+'s';}}
function receipt(m,actions=false){let controls='';
 if(actions&&m.status==='pending'&&!m.paused)controls=m.incoming?btn('Review result','review',m.id,true):btn('Withdraw report','withdraw',m.id);
 if(actions&&['confirmed','auto','corrected'].includes(m.status))controls=btn('Ask for a correction','challenge',m.id);
 return '<article class="item"><div class="row between"><span><strong>'+resultName[m.result]+' vs '+esc(m.peer.name)+'</strong><br><small>'+textDate(m.day)+' · '+statusName[m.status]+'</small></span>'+controls+'</div>'+(m.status==='pending'?'<small>'+timer(m)+'</small>':'')+'</article>';}
const pending=()=>board.mine.filter(m=>m.incoming&&m.status==='pending');
function searchResults(){const out=$('opponents');if(!out)return;
 const q=search.trim().toLocaleLowerCase();if(!q){out.textContent='';return;}
 const found=board.roster.filter(p=>p.id!==board.me.id&&[p.name,p.username,p.real].some(s=>s?.toLocaleLowerCase().includes(q))).slice(0,15);
 out.innerHTML=found.map(p=>'<div class="row between item">'+nameButton(p)+'<small>'+(p.present?'Checked in':'Awaiting check-in')+'</small></div>').join('')||'<p>No matching players.</p>';}
function controls(){
 if(!board.live)return '';
 const me=board.me,top='<p class="muted">'+esc(board.event.title)+' · '+textDate(board.event.day)+' · Reporting open</p>';
 if(!me)return top+'<a class="act primary" href="'+signIn+'">Sign in to check in</a>';
 const tonight=board.mine.filter(m=>m.event===board.event.id),history=board.mine.filter(m=>m.event!==board.event.id);
 return top+'<section class="panel"><h2>Pending approvals</h2>'+(pending().map(m=>receipt(m,true)).join('')||'<p>Nothing waiting for your approval.</p>')+'</section><section><h2>Find an opponent</h2>'+
 (me.present?'':'<p>Check in for this event to report a result.</p>'+btn('Check in','attend',0,true))+
 '<label for="find">Player name or username</label><input id="find" type="search" autocomplete="off" placeholder="Search players"><div id="opponents"></div></section>'+
 '<section class="panel"><div class="row between"><h2>My matches</h2><strong>'+me.used+' of 4 places used</strong></div>'+(tonight.map(m=>receipt(m,true)).join('')+board.byes.map(b=>'<p>Unrated place · '+esc(b.reason)+'</p>').join('')||'<p>No matches recorded tonight.</p>')+
 '</section><details><summary>Opponent history ('+history.length+')</summary>'+history.map(m=>receipt(m,true)).join('')+'</details>';}
function render(){
 const focus=document.activeElement?.id==='find',start=focus?$('find').selectionStart:0;
 $('duel-controls').innerHTML=controls();
 if($('find')){$('find').value=search;searchResults();if(focus){$('find').focus({preventScroll:true});$('find').setSelectionRange(start,start);}}
 $('standings').innerHTML=board.players.map(p=>'<article class="item"><div class="row between"><div class="row"><strong>#'+p.place+'</strong>'+nameButton(p)+'</div><strong class="score">'+p.score+' pts</strong></div><small class="muted">'+stats(p)+'</small></article>').join('')||'<strong>Standings start after the first rated matches.</strong><p class="muted">Players appear here after four confirmed results.</p>';
 $('account').textContent=board.me?(pending().length?'My account · '+pending().length+' pending':'My account'):'Sign in';
 clocks();}
async function refresh(){const seq=++sequence;const data=await api('board');if(seq!==sequence)return;board=data;offset=board.serverTime-Date.now()/1000;render();}
function modal(title,html){dialogVersion++;$('dialog-title').textContent=title;$('dialog-error').textContent='';content.innerHTML=html;if(!dlg.open)dlg.showModal();clocks();}
function end(){if(dlg.open)dlg.close();}
dlg.addEventListener('close',()=>{dialogVersion++;currentProfile=null;usedRequest=null;});$('close-dialog').onclick=end;
function eligibility(p){const me=board.me,r=board.roster.find(x=>x.id===p.id);
 if(!board.live||!me||me.id===p.id)return '';
 if(!r||!me.present||!r.present)return 'Both players must check in first.';
 if(me.suspended||r.suspended)return 'Reporting is suspended for this pairing.';
 if(board.mine.some(m=>m.event===board.event.id&&m.peer.id===p.id))return 'You already have a match record together for this event.';
 if(me.used>=4||r.used>=4)return 'One player has used all four places.';
 return 'ready';}
async function profile(id){
 if(!id&&!board.me){location.assign(signIn);return;}
 const stamp=++dialogVersion,p=await api('profile?id='+(id||board.me.id));if(stamp!==dialogVersion)return;
 currentProfile=p;const player=p.player,eligible=eligibility(player),own=p.own;
 const fav=p.favourites.map(f=>'<div class="item"><a href="/gog/deckbuilder/shared/?id='+encodeURIComponent(f.share)+'">'+esc(f.name)+'</a></div>').join('');
 modal(own?'My account':'Player profile','<div class="row">'+avatar(player)+'<div><strong>'+esc(player.name)+'</strong><br>@'+esc(player.username)+(p.real?' · '+esc(p.real):'')+'</div></div><p><b class="score">'+player.score+' pts</b> · '+stats(player)+'</p>'+
 (eligible==='ready'?'<section><h3>Your result against '+esc(player.name)+'</h3><div class="row">'+['W','L','D'].map(x=>btn(resultName[x],'choose-'+x,player.id)).join('')+'</div></section>':eligible?'<p>'+esc(eligible)+'</p>':'')+
 '<section><h3>Favourite decks</h3>'+(fav||'<p>No published decks.</p>')+'</section>'+
 (own?'<div class="row">'+btn('Edit profile','edit')+btn('Manage favourite decks','decks')+'</div><section><h3>My matches</h3>'+ (board.mine.map(m=>receipt(m,true)).join('')||'<p>No matches yet.</p>')+'</section><div class="row">'+btn('Sign out','logout')+btn('Sign out on all devices','logout-all')+'</div>':''));
}
function editor(){const p=currentProfile;selectedArt=p.player.art;modal('Edit player profile','<form id="edit-profile"><label>Display name<input name="name" maxlength="32" required value="'+esc(p.player.name)+'"></label><label>Real name (optional)<input name="real" maxlength="64" value="'+esc(p.real)+'"></label><label><input type="checkbox" name="show" '+(p.showReal?'checked':'')+'> Show real name to signed-in players</label><h3>Profile artwork</h3><div id="chosen-art">'+avatar(p.player)+'</div><label>Find card artwork<input id="art-query" type="search" placeholder="Search card names"></label><div id="art-results" class="ja-arts"></div><p>'+btn('Clear artwork','clear-art')+'</p><button class="primary">Save profile</button></form>');}
async function decks(){const version=dialogVersion;const db=await new DeckDatabase().open();try{localDecks=await db.list();}finally{db.db.close();db.channel?.close();}
 if(version!==dialogVersion)return;modal('Favourite decks',[1,2,3].map(slot=>{const f=currentProfile.favourites.find(d=>d.slot===slot);return '<form class="item" data-slot="'+slot+'"><label>Favourite '+slot+(f?' · '+esc(f.name):'')+'<select name="deck" required><option value="">Choose a saved deck</option>'+localDecks.map((d,i)=>'<option value="'+i+'">'+esc(d.name)+'</option>').join('')+'</select></label><div class="row"><button>Publish snapshot</button>'+(f?btn('Remove','remove-deck',slot):'')+'</div></form>';}).join('')+(localDecks.length?'':'<p>No decks saved on this device. <a href="/gog/deckbuilder/">Open Builder</a></p>'));}
async function changed(path,body){await api(path,body);await refresh();end();}
function review(m,kind){let form='';
 if(kind==='review')form='<p>Approving records this '+resultName[m.result].toLowerCase()+' in your matches. It uses one of your four places.</p><div class="row">'+btn('Approve result','approve',m.id,true)+btn('Reject for Office review','reject',m.id)+'</div>';
 if(kind==='withdraw')form=btn('Withdraw this report','do-withdraw',m.id,true);
 if(kind==='challenge')form='<form id="challenge" data-id="'+m.id+'"><label>What needs correcting?<textarea required maxlength="240" name="reason"></textarea></label><button>Send to JUSH Office</button></form>';
 modal('Match with '+m.peer.name,receipt(m)+form);}
document.addEventListener('input',e=>{if(e.target.id==='find'){search=e.target.value;searchResults();}
 if(e.target.id==='art-query'){clearTimeout(searchTimer);const q=e.target.value,el=e.target;searchTimer=setTimeout(async()=>{try{const {cards}=await api('art?q='+encodeURIComponent(q));if(!el.isConnected||el.value!==q)return;$('art-results').innerHTML=cards.flatMap(c=>c.art.map((id,i)=>'<button type="button" data-action="art" data-id="'+id+'" aria-label="'+esc(c.name+' art '+(i+1))+'" title="'+esc(c.name)+'"><img src="'+artUrl(id)+'" alt="">'+esc(c.name)+'</button>')).join('')||(q.length>=2?'No matching artwork.':'');}catch(err){notice(err.message);}},250);}});
document.addEventListener('click',async e=>{
 const p=e.target.closest('[data-profile]'),b=e.target.closest('[data-action]');if(!board||(!p&&!b&&e.target.id!=='account'))return;
 try{if(e.target.id==='account'||p){await profile(p?Number(p.dataset.profile):0);return;}const a=b.dataset.action,id=Number(b.dataset.id);b.disabled=true;
 const match=board.mine.find(m=>m.id===id);
 if(a==='attend'){await api('check-in',{event:board.event.id});await refresh();}
 else if(['review','withdraw','challenge'].includes(a))review(match,a);
 else if(['approve','reject','do-withdraw'].includes(a))await changed(a==='do-withdraw'?'withdraw':a,{event:match.event,match:id,revision:match.revision});
 else if(a.startsWith('choose-')){const out=a.slice(-1);usedRequest={event:board.event.id,opponent:id,result:out,requestId:crypto.randomUUID()};modal('Confirm your result','<p>Report a <b>'+resultName[out].toLowerCase()+'</b> against <b>'+esc(currentProfile.player.name)+'</b> (@'+esc(currentProfile.player.username)+')?</p><p>This reserves one match place for each of you. Your opponent has 60 minutes to respond.</p>'+btn('Send result','submit',id,true));}
 else if(a==='submit')await changed('report',usedRequest);
 else if(a==='edit')editor();
 else if(a==='decks')await decks();
 else if(a==='art'||a==='clear-art'){selectedArt=a==='art'?id:null;$('chosen-art').innerHTML=avatar({...currentProfile.player,art:selectedArt});}
 else if(a==='remove-deck'){const f=currentProfile.favourites.find(x=>x.slot===id);await api('favourite',{slot:id,previous:f.share,remove:true});await profile(0);}
 else if(a==='logout'||a==='logout-all'){if(a==='logout') {const r=await fetch('/gog/api/community/logout',{method:'POST',headers:{'Content-Type':'application/json','X-JUSH-Action':'member'},body:'{}'});if(!r.ok)throw Error('Could not sign out.');}else await api('logout-all',{});end();await refresh();}
 }catch(err){notice(err.message);}finally{if(b?.isConnected)b.disabled=false;}
});
content.addEventListener('submit',async e=>{e.preventDefault();const form=e.target,submit=form.querySelector('button:not([type=button])');if(submit.disabled)return;submit.disabled=true;
 try{if(form.id==='edit-profile'){await api('profile',{name:form.elements.name.value,real:form.elements.real.value,showReal:form.elements.show.checked,art:selectedArt,revision:currentProfile.revision});await refresh();await profile(0);}
 else if(form.id==='challenge'){const m=board.mine.find(x=>x.id===Number(form.dataset.id));await changed('challenge',{match:m.id,event:m.event,reason:form.elements.reason.value});$('feedback').textContent='Correction request sent to the JUSH Office.';}
 else if(form.dataset.slot){const slot=Number(form.dataset.slot),d=localDecks[Number(form.elements.deck.value)],zones=Object.fromEntries(['main','extra','side'].map(z=>[z,d[z].map(c=>c.artworkId||c.canonicalId||c.originalImportId)]));
 await api('favourite',{slot,previous:currentProfile.favourites.find(f=>f.slot===slot)?.share||'',name:d.name,zones});await profile(0);}
 }catch(err){notice(err.message);}finally{if(submit.isConnected)submit.disabled=false;}
});
async function start(){try{await refresh();const id=new URLSearchParams(location.search).get('profile');if(id==='me'||Number(id)>0)await profile(id==='me'?0:Number(id));}catch(e){notice(e.message);}}
start();setInterval(clocks,1000);setInterval(()=>{if(!document.hidden&&!dlg.open)refresh().catch(e=>notice(e.message));},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!dlg.open)refresh().catch(e=>notice(e.message));});
