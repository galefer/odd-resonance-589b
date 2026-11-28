export const ratedStates = new Set(['confirmed','auto','corrected']);
export const reverseOutcome = result => ({W:'L',L:'W',D:'D'}[result]);
export const tier = score => score >= 1300 ? 'Pharoah' : score >= 1200 ? 'Obelisk Diamond' : score >= 1125 ? 'Ra Gold' : score >= 1050 ? 'Slifer Red' : 'Duelist';

// Freeze both players' starting scores and experience for each occurrence.
// Replaying the ledger also corrects later opponents after a historical ruling.
export function standings(members, matches) {
  const byId = new Map(members.map(p=>[p.id,{...p, rating:1000,w:0,l:0,d:0}]));
  let event = null, opening = new Map();
  for (const m of matches) {
    if (!ratedStates.has(m.status)) continue;
    if (event !== m.event) { event=m.event; opening=new Map(); }
    for (const id of [m.reporter,m.opponent]) {
      const p=byId.get(id);
      if (!opening.has(id)) opening.set(id,{rating:p.rating,k:p.w+p.l+p.d<12?40:24});
    }
    for (const [id,other,out] of [[m.reporter,m.opponent,m.result],[m.opponent,m.reporter,reverseOutcome(m.result)]]) {
      const p=byId.get(id), start=opening.get(id), rival=opening.get(other);
      const expected=1/(1+10**((rival.rating-start.rating)/400));
      p.rating+=start.k*(({W:1,D:.5,L:0}[out])-expected);
      p[out.toLowerCase()]++;
    }
  }
  const rows=[...byId.values()].map(({rating,...p})=>{
    const n=p.w+p.l+p.d,score=Math.round(rating);
    return {...p,score,rank:tier(score),n,winRate:n?Math.round(1000*p.w/n)/10:null,place:null};
  }).sort((a,b)=>b.score-a.score||b.n-a.n||b.w-a.w||a.username.localeCompare(b.username));
  let count=0,prev;
  for (const row of rows) {
    if(row.n<4||row.suspended)continue;
    count++;
    row.place=prev&&prev.score===row.score&&prev.n===row.n&&prev.w===row.w?prev.place:count;
    prev=row;
  }
  return rows;
}
