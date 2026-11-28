import { standings, reverseOutcome } from './jush-standings.js';
import { settleDue } from './jush-settlement.js';

const free = new Set(['withdrawn', 'void']);
const isHouse = (e) =>
  e.slug === 'yugioh-house-friday' || /\b(jush|house format)\b/i.test(e.title + ' ' + e.description);
const shortText = (s, n) => (typeof s === 'string' && [...s.trim()].length <= n ? s.trim() : null);
const identity = (m) => ({ id: m.id, username: m.username, name: m.name, art: m.art });
const snapshotSql =
  'SELECT m.*,e.day FROM jush_matches m JOIN jush_duel_events e ON e.id=m.event ORDER BY e.day,e.id,m.id';

export async function eventApp(path, ctx) {
  const {
    db,
    request,
    body,
    member,
    director,
    query,
    json,
    fail,
    stmt,
    all,
    one,
    check,
    sessionHash,
    getSchedule,
    londonNow,
  } = ctx;
  const write = request.method === 'POST';
  const now = londonNow(),
    actor = director ? 'director' : member ? 'member:' + member.id : 'guest';
  const requireUser = () => {
    if (!member && !director) throw fail(401, 'Sign in to use your player account.');
  };
  const reason = () => {
    const s = shortText(body.reason, 240);
    if (!s) throw fail(400, 'Enter a reason (up to 240 characters).');
    return s;
  };
  const ownGuard = () =>
    check('EXISTS(SELECT 1 FROM jush_sessions WHERE digest=? AND expires>unixepoch())', sessionHash);
  async function commit(statements) {
    try {
      await db.batch(director ? statements : [ownGuard(), ...statements]);
    } catch (e) {
      const msg = String(e.cause?.message || e.message);
      for (const detail of [
        'Both players must check in',
        'Member reporting suspended',
        'These players already have an event match',
        'All four matches used',
      ])
        if (msg.includes(detail)) throw fail(409, detail + '.');
      if (/constraint|precondition/i.test(msg))
        throw fail(409, 'This record changed or a limit was reached. Refresh and try again.');
      throw e;
    }
    return json({ ok: true });
  }
  const audit = (event, action, note, current = '') =>
    stmt(
      'INSERT INTO jush_duel_audit(event,actor,action,reason,current) VALUES(?,?,?,?,?)',
      event || null,
      actor,
      action,
      note,
      current,
    );
  if (write) requireUser();
  if (path === 'session' && !write)
    return json({ member: member ? { id: member.id, username: member.username } : null });
  if (path === 'inbox' && !write) {
    if (!member) return json({ pending: 0 });
    const row = await one(
      "SELECT count(*) n FROM jush_matches m JOIN jush_duel_events e ON e.id=m.event WHERE m.opponent=? AND m.status='pending' AND (m.due>unixepoch() OR e.mode='paused')",
      member.id,
    );
    return json({ pending: row.n });
  }
  if (path === 'logout-all' && write && !director)
    return commit([stmt('DELETE FROM jush_sessions WHERE member=?', member.id)]);
  if (path === 'profile' && write && !director) {
    const display = shortText(body.name, 32),
      real = shortText(body.real, 64),
      art = body.art === null ? null : Number(body.art);
    if (!display || real === null)
      throw fail(400, 'Enter a display name up to 32 characters and a real name up to 64.');
    if (
      art !== null &&
      (!Number.isSafeInteger(art) ||
        !(await one(
          'SELECT 1 FROM card_artworks WHERE artwork_id=? UNION SELECT 1 FROM cards_cache WHERE card_id=? LIMIT 1',
          art,
          art,
        )))
    )
      throw fail(400, 'Select artwork from the card catalogue.');
    return commit([
      check('COALESCE((SELECT revision FROM jush_profiles WHERE member=?),0)=?', member.id, body.revision ?? -1),
      stmt(
        `INSERT INTO jush_profiles(member,display,real_name,show_real,art,revision) VALUES(?,?,?,?,?,1)
      ON CONFLICT(member) DO UPDATE SET display=excluded.display,real_name=excluded.real_name,show_real=excluded.show_real,art=excluded.art,revision=revision+1`,
        member.id,
        display,
        real,
        body.showReal === true ? 1 : 0,
        art,
      ),
    ]);
  }
  if (path === 'favourite' && write && !director) {
    const slot = Number(body.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw fail(400, 'Choose a favourite slot.');
    const guards = [
      check(
        "COALESCE((SELECT share FROM jush_favourites WHERE member=? AND slot=?),'')=?",
        member.id,
        slot,
        String(body.previous || ''),
      ),
    ];
    if (body.remove)
      return commit([...guards, stmt('DELETE FROM jush_favourites WHERE member=? AND slot=?', member.id, slot)]);
    const name = shortText(body.name, 100),
      zones = {};
    if (!name) throw fail(400, 'Choose a saved deck with a name.');
    for (const [zone, maximum] of [
      ['main', 100],
      ['extra', 30],
      ['side', 30],
    ]) {
      const ids = body.zones?.[zone];
      if (
        !Array.isArray(ids) ||
        ids.length > maximum ||
        !ids.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 999999999)
      )
        throw fail(400, 'This deck contains invalid or too many cards.');
      zones[zone] = ids;
    }
    if (!Object.values(zones).some((ids) => ids.length)) throw fail(400, 'Choose a deck with at least one card.');
    return commit([
      ...guards,
      stmt(
        `INSERT INTO jush_favourites VALUES(?,?,?,?,?) ON CONFLICT(member,slot)
      DO UPDATE SET share=excluded.share,name=excluded.name,zones=excluded.zones`,
        member.id,
        slot,
        crypto.randomUUID(),
        name,
        JSON.stringify(zones),
      ),
    ]);
  }
  if (path === 'art' && !write) {
    requireUser();
    const q = (query.get('q') || '').trim().slice(0, 80);
    if (q.length < 2) return json({ cards: [] });
    const cards = await all(
      'SELECT card_id id,name FROM cards_cache WHERE instr(lower(name),lower(?))>0 ORDER BY length(name),name LIMIT 14',
      q,
    );
    if (cards.length) {
      const ids = cards.map((c) => c.id),
        arts = await all(
          'SELECT canonical_id,artwork_id FROM card_artworks WHERE canonical_id IN (' +
            ids.map(() => '?').join(',') +
            ') ORDER BY is_default DESC,artwork_id',
          ...ids,
        );
      for (const card of cards)
        card.art = [
          ...new Set([card.id, ...arts.filter((a) => a.canonical_id === card.id).map((a) => a.artwork_id)]),
        ];
    }
    return json({ cards });
  }
  if (path === 'deck' && !write) {
    const deck = await one(
      'SELECT share,name,zones,member FROM jush_favourites WHERE share=?',
      query.get('share'),
    );
    if (!deck) throw fail(404, 'This shared deck is no longer available.');
    return json({ ...deck, zones: JSON.parse(deck.zones) });
  }

  // The ledger is authoritative. Derive every read from the same settled matches.
  await settleDue(db);
  const membersSql = `SELECT m.id,m.username,COALESCE(NULLIF(p.display,''),m.username) name,p.art,COALESCE(p.suspended,0) suspended
    FROM jush_members m LEFT JOIN jush_profiles p ON p.member=m.id`;
  async function ladder() {
    const [members, matches] = await Promise.all([all(membersSql), all(snapshotSql)]);
    return { rows: standings(members, matches), matches };
  }
  if (!write && path === 'ladder') {
    const { rows } = await ladder();
    return json({ players: rows.filter((r) => r.place) });
  }
  if (!write && path === 'profile') {
    const id = Number(query.get('id') || member?.id);
    if (!id) throw fail(401, 'Sign in to open your account.');
    const { rows } = await ladder(),
      p = rows.find((r) => r.id === id);
    if (!p) throw fail(404, 'Player unavailable.');
    const own = id === member?.id,
      profile = await one('SELECT * FROM jush_profiles WHERE member=?', id);
    return json({
      player: p,
      real: own || director || (member && profile?.show_real) ? profile?.real_name || '' : '',
      showReal: own && !!profile?.show_real,
      own,
      revision: own ? profile?.revision || 0 : undefined,
      favourites: await all('SELECT slot,share,name FROM jush_favourites WHERE member=? ORDER BY slot', id),
    });
  }
  if (director && write && path === 'moderate') {
    const id = Number(body.member),
      why = reason();
    if (!(await one('SELECT id FROM jush_members WHERE id=?', id))) throw fail(404, 'Unknown member.');
    let change;
    switch (body.action) {
      case 'suspend':
      case 'reinstate':
        change = stmt(
          'INSERT INTO jush_profiles(member,suspended) VALUES(?,?) ON CONFLICT(member) DO UPDATE SET suspended=excluded.suspended,revision=revision+1',
          id,
          body.action === 'suspend' ? 1 : 0,
        );
        break;
      case 'reset-profile':
        change = stmt(
          "UPDATE jush_profiles SET display='',real_name='',show_real=0,art=NULL,revision=revision+1 WHERE member=?",
          id,
        );
        break;
      case 'unlist':
        change = stmt('DELETE FROM jush_favourites WHERE member=? AND slot=?', id, Number(body.slot));
        break;
      case 'revoke':
        change = stmt('DELETE FROM jush_sessions WHERE member=?', id);
        break;
      default:
        throw fail(400, 'Unknown account action.');
    }
    return commit([change, audit(null, body.action, why, String(id))]);
  }
  // Include the House occurrence through 22:00, even if its advertised finish was earlier.
  const schedule = (await getSchedule()).filter(isHouse);
  const stored = await all('SELECT * FROM jush_duel_events ORDER BY day DESC,id');
  const eventMap = new Map(stored.map((e) => [e.id, { ...e, scheduled: false }]));
  for (const e of schedule) {
    const saved = eventMap.get(e.id);
    eventMap.set(e.id, {
      ...saved,
      id: e.id,
      day: e.eventDate,
      title: e.title,
      mode: saved?.mode || 'calendar',
      scheduled: e.status === 'scheduled',
    });
  }
  const events = [...eventMap.values()],
    today = events.filter((e) => e.day === now.date && e.scheduled);
  const forced = events.filter((e) => e.mode === 'open' && e.day === now.date);
  const live =
    forced.length === 1
      ? forced[0]
      : today.length === 1 && today[0].mode === 'calendar' && now.time >= '17:00' && now.time < '22:00'
        ? today[0]
        : null;
  const wanted = write ? body.event : query.get('event');
  const event = wanted
    ? eventMap.get(wanted)
    : live ||
      today[0] ||
      events.filter((e) => e.scheduled && e.day >= now.date).sort((a, b) => a.day.localeCompare(b.day))[0] ||
      stored[0];
  const eventId = event?.id;
  const saveEvent = () =>
    stmt(
      'INSERT INTO jush_duel_events(id,day,title) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,title=excluded.title',
      event.id,
      event.day,
      event.title,
    );
  if (!write && (path === 'board' || (path === 'office' && director))) {
    const { rows, matches } = await ladder(),
      lookup = new Map(rows.map((p) => [p.id, p]));
    const attended = eventId ? await all('SELECT member FROM jush_attendance WHERE event=?', eventId) : [];
    const checked = new Set(attended.map((x) => x.member));
    const byes = eventId
      ? await all('SELECT id,member,reason FROM jush_event_byes WHERE event=? AND active=1 ORDER BY id', eventId)
      : [];
    const selected = matches.filter((m) => m.event === eventId),
      used = new Map();
    for (const b of byes) used.set(b.member, (used.get(b.member) || 0) + 1);
    for (const m of selected)
      if (!free.has(m.status)) for (const id of [m.reporter, m.opponent]) used.set(id, (used.get(id) || 0) + 1);
    const mine = member
      ? matches
          .filter((m) => m.reporter === member.id || m.opponent === member.id)
          .reverse()
          .map((m) => {
            const incoming = m.opponent === member.id;
            return {
              id: m.id,
              event: m.event,
              day: m.day,
              peer: identity(lookup.get(incoming ? m.reporter : m.opponent)),
              result: incoming ? reverseOutcome(m.result) : m.result,
              status: m.status,
              incoming,
              due: m.due,
              created: m.created,
              revision: m.revision,
              reason: m.reason,
              paused: eventMap.get(m.event)?.mode === 'paused',
            };
          })
      : [];
    const roster = rows.map((p) => ({
      ...identity(p),
      present: checked.has(p.id),
      used: used.get(p.id) || 0,
      suspended: !!p.suspended,
    }));
    if (member || director) {
      const names = await all("SELECT member,real_name FROM jush_profiles WHERE show_real=1 AND real_name<>''");
      const byId = new Map(names.map((p) => [p.member, p.real_name]));
      for (const p of roster) p.real = byId.get(p.id) || '';
    }
    const data = {
      serverTime: Math.floor(Date.now() / 1000),
      live: !!live && eventId === live.id,
      event: event || null,
      me: member
        ? { ...lookup.get(member.id), present: checked.has(member.id), used: used.get(member.id) || 0 }
        : null,
      mine,
      byes: director ? byes : byes.filter((b) => b.member === member?.id),
      players: rows.filter((r) => r.place),
      roster: director || (member && live && live.id === eventId) ? roster : [],
    };
    if (director)
      Object.assign(data, {
        events: events.sort((a, b) => b.day.localeCompare(a.day)),
        matches: selected,
        clock: await one('SELECT last_run FROM jush_duel_clock WHERE id=1'),
        audit: await all(
          'SELECT * FROM jush_duel_audit WHERE event=? OR event IS NULL ORDER BY id DESC LIMIT 150',
          eventId || '',
        ),
      });
    return json(data);
  }
  if (!write) throw fail(404, 'Unknown match action.');
  if (!event || !wanted || eventId !== wanted) throw fail(409, 'Select the event again.');
  if (path === 'bye' && director) {
    const id = Number(body.member),
      why = reason();
    return commit([
      check('EXISTS(SELECT 1 FROM jush_attendance WHERE event=? AND member=?)', eventId, id),
      stmt('INSERT INTO jush_event_byes(event,member,reason,actor) VALUES(?,?,?,?)', eventId, id, why, actor),
      audit(eventId, 'unrated place', why, String(id)),
    ]);
  }
  if (path === 'remove-bye' && director) {
    const id = Number(body.bye),
      why = reason();
    return commit([
      check('EXISTS(SELECT 1 FROM jush_event_byes WHERE id=? AND event=? AND active=1)', id, eventId),
      stmt('UPDATE jush_event_byes SET active=0 WHERE id=?', id),
      audit(eventId, 'release unrated place', why, String(id)),
    ]);
  }
  if (path === 'check-out' && director) {
    const id = Number(body.member),
      why = reason();
    return commit([
      check('EXISTS(SELECT 1 FROM jush_attendance WHERE event=? AND member=?)', eventId, id),
      check(
        "NOT EXISTS(SELECT 1 FROM jush_matches WHERE event=? AND ? IN (reporter,opponent) AND status NOT IN ('void','withdrawn'))",
        eventId,
        id,
      ),
      check('NOT EXISTS(SELECT 1 FROM jush_event_byes WHERE event=? AND member=? AND active=1)', eventId, id),
      stmt('DELETE FROM jush_attendance WHERE event=? AND member=?', eventId, id),
      audit(eventId, 'check-out', why, String(id)),
    ]);
  }
  if (path === 'check-in') {
    if (!director && live?.id !== eventId) throw fail(409, 'Check-in opens during the House reporting window.');
    const id = director ? Number(body.member) : member.id;
    if (!(await one('SELECT id FROM jush_members WHERE id=?', id))) throw fail(404, 'Unknown player.');
    return commit([
      saveEvent(),
      stmt('INSERT OR IGNORE INTO jush_attendance(event,member,actor) VALUES(?,?,?)', eventId, id, actor),
      audit(eventId, 'check-in', '', String(id)),
    ]);
  }
  if (path === 'event-mode' && director) {
    if (!['calendar', 'paused', 'closed', 'open'].includes(body.mode))
      throw fail(400, 'Choose a valid event mode.');
    const why = reason(),
      statements = [saveEvent(), check('(SELECT mode FROM jush_duel_events WHERE id=?)=?', eventId, event.mode)];
    if (event.mode === 'paused' && body.mode !== 'paused')
      statements.push(
        stmt(
          `UPDATE jush_matches SET due=due+unixepoch()-(SELECT paused_at FROM jush_duel_events WHERE id=?),revision=revision+1,actor=?,reason=?
      WHERE event=? AND status='pending'`,
          eventId,
          actor,
          why,
          eventId,
        ),
      );
    statements.push(
      stmt(
        "UPDATE jush_duel_events SET mode=?,paused_at=CASE WHEN ?='paused' THEN COALESCE(paused_at,unixepoch()) ELSE NULL END WHERE id=?",
        body.mode,
        body.mode,
        eventId,
      ),
      audit(eventId, 'event mode', why, body.mode),
    );
    return commit(statements);
  }
  if (path === 'report') {
    const reporter = director ? Number(body.reporter) : member.id,
      opponent = Number(body.opponent),
      out = body.result,
      key = body.requestId;
    if (
      !['W', 'L', 'D'].includes(out) ||
      reporter === opponent ||
      !Number.isSafeInteger(opponent) ||
      !key ||
      !/^[\w-]{12,80}$/.test(key)
    )
      throw fail(400, 'Choose another player and a valid match outcome.');
    const prior = await one('SELECT * FROM jush_matches WHERE reporter=? AND requested=?', reporter, key);
    if (prior) {
      if (prior.event !== eventId || prior.opponent !== opponent || prior.result !== out)
        throw fail(409, 'This receipt belongs to a different match.');
      return json({ ok: true, id: prior.id });
    }
    if (!director && live?.id !== eventId) throw fail(409, 'Reporting is closed for this event.');
    const why = director ? reason() : '';
    const guards = director
      ? []
      : [check("EXISTS(SELECT 1 FROM jush_duel_events WHERE id=? AND mode IN ('calendar','open'))", eventId)];
    return commit([
      ...guards,
      stmt(
        `INSERT INTO jush_matches(event,reporter,opponent,result,status,requested,due,actor,reason)
      VALUES(?,?,?,?,?,?,unixepoch()+3600,?,?)`,
        eventId,
        reporter,
        opponent,
        out,
        director ? 'corrected' : 'pending',
        key,
        actor,
        why,
      ),
    ]);
  }
  const m = await one('SELECT * FROM jush_matches WHERE id=? AND event=?', Number(body.match) || 0, eventId);
  if (!m) throw fail(404, 'Match unavailable.');
  if (path === 'reassign' && director) {
    const why = reason(),
      opponent = Number(body.opponent);
    if (!Number.isSafeInteger(opponent) || opponent === m.reporter || opponent === m.opponent)
      throw fail(400, 'Choose a different opponent.');
    return commit([
      check(
        "EXISTS(SELECT 1 FROM jush_matches WHERE id=? AND revision=? AND status NOT IN ('void','withdrawn'))",
        m.id,
        body.revision,
      ),
      stmt(
        "UPDATE jush_matches SET status='void',revision=revision+1,reason=?,actor=? WHERE id=?",
        why,
        actor,
        m.id,
      ),
      stmt(
        "INSERT INTO jush_matches(event,reporter,opponent,result,status,requested,due,actor,reason) VALUES(?,?,?,?,'pending',?,unixepoch()+3600,?,?)",
        eventId,
        m.reporter,
        opponent,
        m.result,
        crypto.randomUUID(),
        actor,
        'Reassigned from #' + m.id + ' · ' + why,
      ),
    ]);
  }
  if (path === 'deadline' && director) {
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120)
      throw fail(400, 'Choose an extension of 1–120 minutes.');
    return commit([
      check(
        "EXISTS(SELECT 1 FROM jush_matches WHERE id=? AND revision=? AND status='pending')",
        m.id,
        body.revision,
      ),
      stmt(
        'UPDATE jush_matches SET due=due+?,revision=revision+1,actor=?,reason=? WHERE id=?',
        minutes * 60,
        actor,
        reason(),
        m.id,
      ),
    ]);
  }
  if (path === 'preview' && director) {
    if (!['W', 'L', 'D', 'void'].includes(body.result)) throw fail(400, 'Choose a ruling.');
    const [members, matches] = await Promise.all([all(membersSql), all(snapshotSql)]),
      before = standings(members, matches);
    const after = standings(
      members,
      matches.map((row) =>
        row.id === m.id
          ? {
              ...row,
              status: body.result === 'void' ? 'void' : 'corrected',
              result: body.result === 'void' ? row.result : body.result,
            }
          : row,
      ),
    );
    return json({
      revision: m.revision,
      changes: after
        .map((p) => {
          const old = before.find((x) => x.id === p.id);
          return { id: p.id, name: p.name, before: old.score, after: p.score, from: old.n, to: p.n };
        })
        .filter((p) => p.id === m.reporter || p.id === m.opponent || p.before !== p.after),
    });
  }
  if (path === 'rule' && director) {
    if (!['W', 'L', 'D', 'void'].includes(body.result)) throw fail(400, 'Choose a ruling.');
    return commit([
      check('EXISTS(SELECT 1 FROM jush_matches WHERE id=? AND revision=?)', m.id, Number(body.revision) || 0),
      stmt(
        'UPDATE jush_matches SET status=?,result=?,actor=?,reason=?,revision=revision+1 WHERE id=?',
        body.result === 'void' ? 'void' : 'corrected',
        body.result === 'void' ? m.result : body.result,
        actor,
        reason(),
        m.id,
      ),
    ]);
  }
  const incoming = m.opponent === member?.id,
    outgoing = m.reporter === member?.id;
  if (path === 'challenge' && (incoming || outgoing)) {
    if (!['confirmed', 'corrected', 'auto'].includes(m.status)) throw fail(409, 'This result is not final.');
    return commit([audit(eventId, 'challenge', reason(), 'Match ' + m.id)]);
  }
  if (((path === 'approve' || path === 'reject') && !incoming) || (path === 'withdraw' && !outgoing))
    throw fail(403, 'Only the matching player may take this action.');
  const status = { approve: 'confirmed', reject: 'review', withdraw: 'withdrawn' }[path];
  if (!status || director) throw fail(404, 'Unknown match action.');
  if (m.status === status) return json({ ok: true });
  return commit([
    check(
      `EXISTS(SELECT 1 FROM jush_matches m JOIN jush_duel_events e ON e.id=m.event
    WHERE m.id=? AND m.status='pending' AND m.due>unixepoch() AND e.mode<>'paused' AND m.revision=?)`,
      m.id,
      Number(body.revision) || 0,
    ),
    stmt(
      'UPDATE jush_matches SET status=?,actor=?,reason=?,revision=revision+1 WHERE id=?',
      status,
      actor,
      shortText(body.reason || '', 240) || '',
      m.id,
    ),
  ]);
}
