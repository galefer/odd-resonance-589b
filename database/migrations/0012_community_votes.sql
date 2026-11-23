CREATE TABLE IF NOT EXISTS jush_members (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  salt TEXT NOT NULL, verifier TEXT NOT NULL, joined INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS jush_codes (
  id INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  recipient INTEGER REFERENCES jush_members, claimed_by INTEGER REFERENCES jush_members,
  revoked INTEGER NOT NULL DEFAULT 0, issued INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS jush_sessions (
  digest TEXT PRIMARY KEY, member INTEGER NOT NULL REFERENCES jush_members,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jush_windows (
  id INTEGER PRIMARY KEY, opened INTEGER NOT NULL, deadline INTEGER NOT NULL,
  closed INTEGER, reset_from INTEGER UNIQUE REFERENCES jush_windows
);
CREATE TABLE IF NOT EXISTS jush_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, window INTEGER NOT NULL REFERENCES jush_windows,
  card INTEGER NOT NULL, name TEXT NOT NULL, published TEXT NOT NULL,
  target TEXT NOT NULL CHECK(target IN ('forbidden','limited','semi_limited','unlimited')),
  starter INTEGER NOT NULL REFERENCES jush_members, reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
  created INTEGER NOT NULL DEFAULT (unixepoch()), committed INTEGER NOT NULL DEFAULT 0,
  ruling TEXT NOT NULL DEFAULT '', UNIQUE(window,card,target), UNIQUE(id,window,card)
);
CREATE TABLE IF NOT EXISTS jush_votes (
  window INTEGER NOT NULL, member INTEGER NOT NULL REFERENCES jush_members, card INTEGER NOT NULL,
  candidate INTEGER NOT NULL, direction INTEGER NOT NULL CHECK(direction IN (-1,1)),
  PRIMARY KEY(window,member,card),
  FOREIGN KEY(candidate,window,card) REFERENCES jush_candidates(id,window,card) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS jush_tally ON jush_votes(candidate,direction);
CREATE TRIGGER IF NOT EXISTS jush_three_slots BEFORE INSERT ON jush_votes
WHEN (SELECT count(*) FROM jush_votes WHERE window=NEW.window AND member=NEW.member)>=3
BEGIN SELECT RAISE(ABORT,'Three slots are already in use'); END;
CREATE TRIGGER IF NOT EXISTS jush_commit_proposal AFTER INSERT ON jush_votes
WHEN NEW.member<>(SELECT starter FROM jush_candidates WHERE id=NEW.candidate)
BEGIN UPDATE jush_candidates SET committed=1 WHERE id=NEW.candidate; END;
CREATE TABLE IF NOT EXISTS jush_comments (
  id INTEGER PRIMARY KEY, candidate INTEGER NOT NULL REFERENCES jush_candidates ON DELETE CASCADE,
  member INTEGER NOT NULL REFERENCES jush_members, text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 1000),
  request_id TEXT NOT NULL, created INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(member,request_id)
);
CREATE INDEX IF NOT EXISTS jush_thread ON jush_comments(candidate,id);
CREATE TABLE IF NOT EXISTS jush_corrections (
  id INTEGER PRIMARY KEY, window INTEGER NOT NULL, candidate INTEGER NOT NULL, member INTEGER NOT NULL,
  direction INTEGER NOT NULL, reason TEXT NOT NULL, after_close INTEGER NOT NULL,
  created INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Evaluate transaction preconditions inside the D1 batch, including deadline and stale-screen checks.
CREATE TABLE IF NOT EXISTS jush_precondition (valid INTEGER NOT NULL CHECK(valid=1));
CREATE TRIGGER IF NOT EXISTS jush_discard_check AFTER INSERT ON jush_precondition
BEGIN DELETE FROM jush_precondition WHERE rowid=NEW.rowid; END;
