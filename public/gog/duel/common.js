export const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export async function api(path, body) {
  const r = await fetch('/gog/api/community/app/' + path, {
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-JUSH-Action': 'member' },
          body: JSON.stringify(body),
        }),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || 'Request failed. Please try again.');
  return data;
}
export const artUrl = (id) => '/gog/api/cards/' + Number(id) + '/image?size=cover&purpose=profile';
export const avatar = (p) =>
  p.art
    ? '<img class="avatar" src="' + artUrl(p.art) + '" alt="">'
    : '<span class="avatar" aria-hidden="true">' +
      esc(Array.from(p.name || p.username || '?')[0].toUpperCase()) +
      '</span>';
export const nameButton = (p) =>
  '<button type="button" class="name" data-profile="' +
  Number(p.id) +
  '">' +
  avatar(p) +
  '<span>' +
  esc(p.name) +
  '<small>@' +
  esc(p.username) +
  '</small></span></button>';
export const resultName = { W: 'Win', L: 'Loss', D: 'Draw' };
export const statusName = {
  pending: 'Pending approval',
  confirmed: 'Approved',
  auto: 'Automatically approved',
  review: 'In Office review',
  corrected: 'Director ruling',
  withdrawn: 'Withdrawn',
  void: 'Voided',
};
