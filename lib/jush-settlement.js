export async function settleDue(db, heartbeat = false) {
  const settle =
    db.prepare(`UPDATE jush_matches SET status='auto',actor='clock',reason='Approval deadline reached',revision=revision+1
    WHERE status='pending' AND due<=unixepoch() AND event IN (SELECT id FROM jush_duel_events WHERE mode<>'paused')`);
  if (heartbeat)
    await db.batch([
      settle,
      db.prepare(
        'INSERT INTO jush_duel_clock VALUES(1,unixepoch()) ON CONFLICT(id) DO UPDATE SET last_run=excluded.last_run',
      ),
    ]);
  else await settle.run();
}
