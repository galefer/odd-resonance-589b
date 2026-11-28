CREATE TABLE IF NOT EXISTS jush_profiles (
  member INTEGER PRIMARY KEY REFERENCES jush_members(id), display TEXT NOT NULL DEFAULT '',
  real_name TEXT NOT NULL DEFAULT '', show_real INTEGER NOT NULL DEFAULT 0, art INTEGER,
  suspended INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jush_favourites (
  member INTEGER NOT NULL REFERENCES jush_members(id), slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
  share TEXT NOT NULL UNIQUE, name TEXT NOT NULL, zones TEXT NOT NULL, PRIMARY KEY(member,slot)
);
CREATE TABLE IF NOT EXISTS jush_duel_events (
  id TEXT PRIMARY KEY, day TEXT NOT NULL, title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'calendar' CHECK(mode IN ('calendar','open','closed','paused')),
  paused_at INTEGER, created INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS jush_attendance (
  event TEXT NOT NULL REFERENCES jush_duel_events(id), member INTEGER NOT NULL REFERENCES jush_members(id),
  actor TEXT NOT NULL, at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(event,member)
);
CREATE TABLE IF NOT EXISTS jush_matches (
  id INTEGER PRIMARY KEY, event TEXT NOT NULL REFERENCES jush_duel_events(id),
  reporter INTEGER NOT NULL REFERENCES jush_members(id), opponent INTEGER NOT NULL REFERENCES jush_members(id),
  result TEXT NOT NULL CHECK(result IN ('W','L','D')), status TEXT NOT NULL
    CHECK(status IN ('pending','review','confirmed','auto','corrected','withdrawn','void')),
  requested TEXT NOT NULL, created INTEGER NOT NULL DEFAULT(unixepoch()), due INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, actor TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  CHECK(reporter<>opponent), UNIQUE(reporter,requested)
);
CREATE UNIQUE INDEX IF NOT EXISTS jush_duel_pair ON jush_matches(event,min(reporter,opponent),max(reporter,opponent));
CREATE INDEX IF NOT EXISTS jush_matches_due ON jush_matches(status,due);
CREATE INDEX IF NOT EXISTS jush_matches_opp ON jush_matches(opponent,event);
CREATE TABLE IF NOT EXISTS jush_duel_audit (
  id INTEGER PRIMARY KEY, event TEXT, match_id INTEGER, actor TEXT NOT NULL, action TEXT NOT NULL,
  previous TEXT, current TEXT, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS jush_duel_clock (id INTEGER PRIMARY KEY CHECK(id=1), last_run INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jush_event_byes (
 id INTEGER PRIMARY KEY, event TEXT NOT NULL, member INTEGER NOT NULL, reason TEXT NOT NULL,
 actor TEXT NOT NULL, created INTEGER NOT NULL DEFAULT(unixepoch()), active INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(event) REFERENCES jush_duel_events(id), FOREIGN KEY(member) REFERENCES jush_members(id)
);
CREATE INDEX IF NOT EXISTS jush_byes_player ON jush_event_byes(event,member,active);
CREATE TRIGGER IF NOT EXISTS jush_bye_limit BEFORE INSERT ON jush_event_byes BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM jush_matches WHERE event=NEW.event AND NEW.member IN (reporter,opponent)
   AND status NOT IN ('withdrawn','void'))+(SELECT count(*) FROM jush_event_byes WHERE event=NEW.event AND member=NEW.member AND active=1)>=4
 THEN RAISE(ABORT,'All four matches used') END;
END;
CREATE TRIGGER IF NOT EXISTS jush_match_insert BEFORE INSERT ON jush_matches BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM jush_attendance WHERE event=NEW.event AND member IN (NEW.reporter,NEW.opponent))<>2
    THEN RAISE(ABORT,'Both players must check in') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM jush_profiles WHERE suspended=1 AND member IN (NEW.reporter,NEW.opponent))
    THEN RAISE(ABORT,'Member reporting suspended') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM jush_matches WHERE event=NEW.event AND
    min(reporter,opponent)=min(NEW.reporter,NEW.opponent) AND max(reporter,opponent)=max(NEW.reporter,NEW.opponent))
    THEN RAISE(ABORT,'These players already have an event match') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM jush_attendance a WHERE a.event=NEW.event AND a.member IN (NEW.reporter,NEW.opponent)
    AND (SELECT count(*) FROM jush_matches m WHERE m.event=a.event AND a.member IN (m.reporter,m.opponent)
    AND m.status NOT IN ('withdrawn','void'))+(SELECT count(*) FROM jush_event_byes b WHERE b.event=a.event AND b.member=a.member AND active=1)>=4) THEN RAISE(ABORT,'All four matches used') END;
END;
CREATE TRIGGER IF NOT EXISTS jush_match_restore BEFORE UPDATE OF status ON jush_matches
WHEN OLD.status IN ('void','withdrawn') AND NEW.status NOT IN ('void','withdrawn') BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM jush_attendance a WHERE a.event=NEW.event AND a.member IN (NEW.reporter,NEW.opponent)
    AND (SELECT count(*) FROM jush_matches m WHERE m.event=a.event AND a.member IN (m.reporter,m.opponent)
    AND m.status NOT IN ('withdrawn','void'))+(SELECT count(*) FROM jush_event_byes b WHERE b.event=a.event AND b.member=a.member AND active=1)>=4) THEN RAISE(ABORT,'All four matches used') END;
END;
CREATE TRIGGER IF NOT EXISTS jush_match_record AFTER INSERT ON jush_matches BEGIN
  INSERT INTO jush_duel_audit(event,match_id,actor,action,current,reason)
  VALUES(NEW.event,NEW.id,NEW.actor,'filed',NEW.status||'/'||NEW.result,NEW.reason);
END;
CREATE TRIGGER IF NOT EXISTS jush_match_change AFTER UPDATE ON jush_matches BEGIN
  INSERT INTO jush_duel_audit(event,match_id,actor,action,previous,current,reason)
  VALUES(NEW.event,NEW.id,NEW.actor,'revised',OLD.status||'/'||OLD.result,NEW.status||'/'||NEW.result,NEW.reason);
END;
