const tabs=[['Home','/gog/','house'],['Cards','/gog/cards/','layers'],['Voting','/gog/voting/','vote'],['Duel','/gog/duel/','swords'],['Builder','/gog/deckbuilder/','panels-top-left']];
const nav=document.createElement('nav');nav.className='j-app-nav';nav.ariaLabel='JUSH navigation';
for(const [label,path,icon] of tabs){const a=document.createElement('a');a.href=path;a.textContent=label.toUpperCase();
 const pic=document.createElement('i');pic.ariaHidden='true';pic.style.setProperty('--nav-icon','url("/gog/assets/app/'+icon+'.svg")');a.prepend(pic);
 if(path==='/gog/'?location.pathname===path:(location.pathname.startsWith(path)||label==='Cards'&&location.pathname.startsWith('/gog/house-format/')))a.setAttribute('aria-current','page');nav.append(a);}
const header=document.querySelector('body>header');if(header)header.after(nav);else document.body.prepend(nav);document.body.classList.add('j-nav-ready');
if(location.pathname==='/gog/deckbuilder/'){
 document.body.classList.add('j-builder');const button=document.createElement('button'),menu=document.querySelector('#mobile-actions-button'),count=document.querySelector('#mobile-count');
 button.className='j-view-deck';button.type='button';button.setAttribute('aria-controls','deck-workspace');
 function refresh(){const open=document.body.classList.contains('j-deck-open');button.textContent=open?'Close deck':'View deck';button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',button.textContent+' · '+count.textContent);}
 function toggle(){document.body.classList.toggle('j-deck-open');refresh();}
 button.onclick=toggle;menu.before(button);refresh();new MutationObserver(refresh).observe(count,{childList:true,subtree:true,characterData:true});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('j-deck-open')&&!document.querySelector('dialog[open]')){toggle();button.focus();}});
 const top=menu.closest('.deck-toolbar')||menu.parentElement;new ResizeObserver(()=>document.body.style.setProperty('--j-header-height',top.getBoundingClientRect().bottom+'px')).observe(top);
}
if('serviceWorker' in navigator)navigator.serviceWorker.register('/gog/sw.js',{scope:'/gog/'}).catch(()=>{});
