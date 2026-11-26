-- Install first. Activate once the website serving card ballots is deployed.
CREATE TABLE IF NOT EXISTS jush_ballot_activation (id INTEGER PRIMARY KEY CHECK(id=1));
CREATE TABLE IF NOT EXISTS jush_ballot_rules (
  window INTEGER PRIMARY KEY REFERENCES jush_windows, minimum INTEGER NOT NULL CHECK(minimum>=3),
  percent INTEGER NOT NULL DEFAULT 60, history TEXT NOT NULL, version INTEGER REFERENCES versions,
  comparable INTEGER NOT NULL, discarded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jush_nomination_cards (
  window INTEGER NOT NULL REFERENCES jush_windows, member INTEGER NOT NULL REFERENCES jush_members,
  card INTEGER NOT NULL, PRIMARY KEY(window,member,card)
);
-- Positive = named candidate, zero = keep opening limit, negative = preserved legacy opposition.
CREATE TABLE IF NOT EXISTS jush_card_ballots (
  window INTEGER NOT NULL REFERENCES jush_windows, member INTEGER NOT NULL REFERENCES jush_members,
  card INTEGER NOT NULL, choice INTEGER NOT NULL, corrected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(window,member,card)
);
CREATE INDEX IF NOT EXISTS jush_card_choice ON jush_card_ballots(window,card,choice);
CREATE TABLE IF NOT EXISTS jush_voted_changes (
  window INTEGER NOT NULL,card INTEGER NOT NULL,candidate INTEGER NOT NULL,name TEXT NOT NULL,
  published TEXT NOT NULL,target TEXT NOT NULL,supporters INTEGER NOT NULL,card_ballots INTEGER NOT NULL,
  PRIMARY KEY(window,card)
);
CREATE TABLE IF NOT EXISTS jush_card_corrections (
  id INTEGER PRIMARY KEY, window INTEGER NOT NULL,card INTEGER NOT NULL, member INTEGER NOT NULL,
  choice INTEGER NOT NULL,reason TEXT NOT NULL,after_close INTEGER NOT NULL,created INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE VIEW IF NOT EXISTS jush_threshold_at_open AS
WITH recent AS (
  SELECT w.id,(SELECT count(DISTINCT member) FROM jush_card_ballots b WHERE b.window=w.id) AS turnout
  FROM jush_windows w JOIN jush_ballot_rules r ON r.window=w.id
  WHERE r.comparable=1 AND r.discarded=0 AND w.deadline<=unixepoch()
    AND (w.closed IS NULL OR w.closed>=w.deadline)
  ORDER BY w.id DESC LIMIT 3
)
SELECT CASE WHEN count(*)=3 THEN max(3,((SELECT turnout FROM recent ORDER BY turnout LIMIT 1 OFFSET 1)+19)/20)
  ELSE 3 END AS minimum, json_group_array(json_object('window',id,'voters',turnout)) AS history FROM recent;

CREATE VIEW IF NOT EXISTS jush_exact_majorities AS
WITH counts AS (
  SELECT window,card,choice,count(*) AS supporters,sum(count(*)) OVER(PARTITION BY window,card) AS ballots
    FROM jush_card_ballots GROUP BY window,card,choice
)
SELECT n.window,n.card,c.id AS candidate,c.name,c.published,c.target,n.supporters,n.ballots AS card_ballots
FROM counts n JOIN jush_candidates c ON c.id=n.choice AND c.window=n.window AND c.card=n.card
JOIN jush_ballot_rules r ON r.window=n.window
WHERE n.supporters>=r.minimum AND 100*n.supporters>=r.percent*n.ballots AND r.discarded=0;

CREATE TRIGGER IF NOT EXISTS jush_choice_insert AFTER INSERT ON jush_card_ballots
BEGIN
  UPDATE jush_candidates SET committed=1 WHERE window=NEW.window AND card=NEW.card AND starter<>NEW.member AND committed=0;
  DELETE FROM jush_voted_changes WHERE window=NEW.window AND card=NEW.card;
  INSERT INTO jush_voted_changes SELECT * FROM jush_exact_majorities WHERE window=NEW.window AND card=NEW.card;
END;
CREATE TRIGGER IF NOT EXISTS jush_choice_delete AFTER DELETE ON jush_card_ballots
BEGIN
  DELETE FROM jush_voted_changes WHERE window=OLD.window AND card=OLD.card;
  INSERT INTO jush_voted_changes SELECT * FROM jush_exact_majorities WHERE window=OLD.window AND card=OLD.card;
END;
CREATE TRIGGER IF NOT EXISTS jush_nomination_quota BEFORE INSERT ON jush_nomination_cards
WHEN NOT EXISTS(SELECT 1 FROM jush_nomination_cards WHERE window=NEW.window AND member=NEW.member AND card=NEW.card)
 AND NOT EXISTS(SELECT 1 FROM jush_candidates WHERE window=NEW.window AND card=NEW.card AND starter=NEW.member)
 AND (SELECT count(*) FROM jush_nomination_cards WHERE window=NEW.window AND member=NEW.member)>=3
BEGIN SELECT RAISE(ABORT,'Three nomination cards already used'); END;

CREATE TRIGGER IF NOT EXISTS jush_open_card_ballots AFTER INSERT ON jush_windows
WHEN EXISTS(SELECT 1 FROM jush_ballot_activation)
BEGIN
  INSERT INTO jush_ballot_rules(window,minimum,history,version,comparable)
  SELECT NEW.id,coalesce(parent.minimum,base.minimum),coalesce(parent.history,base.history),
    coalesce(parent.version,(SELECT max(id) FROM versions WHERE status='published')), NEW.reset_from IS NULL
  FROM jush_threshold_at_open base LEFT JOIN jush_ballot_rules parent ON parent.window=NEW.reset_from
  WHERE NEW.closed IS NULL AND NEW.deadline>unixepoch();
  UPDATE jush_ballot_rules SET discarded=1 WHERE window=NEW.reset_from AND EXISTS
    (SELECT 1 FROM jush_windows WHERE id=NEW.reset_from AND closed IS NULL AND deadline>unixepoch());
  DELETE FROM jush_voted_changes WHERE window=NEW.reset_from AND EXISTS
    (SELECT 1 FROM jush_ballot_rules WHERE window=NEW.reset_from AND discarded=1);
END;

-- Atomic opt-in preserves the current window and copies its ballots exactly once.
CREATE TRIGGER IF NOT EXISTS jush_adopt_open_window AFTER INSERT ON jush_ballot_activation
BEGIN
  INSERT INTO jush_ballot_rules(window,minimum,history,version,comparable)
  SELECT w.id,3,'[]',coalesce((SELECT max(id) FROM versions WHERE status='published'
    AND unixepoch(coalesce(published_at,created_at))<=w.opened),(SELECT max(id) FROM versions WHERE status='published')),0
    FROM jush_windows w WHERE id=(SELECT max(id) FROM jush_windows) AND closed IS NULL AND deadline>unixepoch();
  INSERT OR IGNORE INTO jush_nomination_cards SELECT DISTINCT c.window,c.starter,c.card FROM jush_candidates c
    JOIN jush_ballot_rules r ON c.window=r.window;
  INSERT INTO jush_card_ballots(window,member,card,choice)
    SELECT v.window,v.member,v.card,v.direction*v.candidate FROM jush_votes v JOIN jush_ballot_rules r ON v.window=r.window;
  INSERT INTO jush_precondition SELECT NOT EXISTS (
    SELECT v.window,v.member,v.card,v.direction*v.candidate FROM jush_votes v JOIN jush_ballot_rules r ON v.window=r.window
    EXCEPT SELECT window,member,card,choice FROM jush_card_ballots);
END;
-- A stale deployment must never mutate legacy ballots belonging to an upgraded period.
CREATE TRIGGER IF NOT EXISTS jush_legacy_insert_guard BEFORE INSERT ON jush_votes
WHEN EXISTS(SELECT 1 FROM jush_ballot_rules WHERE window=NEW.window)
BEGIN SELECT RAISE(ABORT,'Reload the voting board'); END;
CREATE TRIGGER IF NOT EXISTS jush_legacy_delete_guard BEFORE DELETE ON jush_votes
WHEN EXISTS(SELECT 1 FROM jush_ballot_rules WHERE window=OLD.window)
 AND EXISTS(SELECT 1 FROM jush_candidates WHERE id=OLD.candidate)
BEGIN SELECT RAISE(ABORT,'Reload the voting board'); END;
