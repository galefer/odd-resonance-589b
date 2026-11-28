-- The single flagged member has extra nomination slots. Office access is separate.
CREATE TABLE IF NOT EXISTS jush_proposal_admin (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  member INTEGER NOT NULL UNIQUE REFERENCES jush_members(id) ON DELETE CASCADE
);
CREATE VIEW IF NOT EXISTS jush_member_nomination_limits AS
SELECT m.id AS member, CASE WHEN a.member IS NULL THEN 3 ELSE 10 END AS nomination_limit
FROM jush_members m LEFT JOIN jush_proposal_admin a ON a.member=m.id;

DROP TRIGGER IF EXISTS jush_nomination_quota;
CREATE TRIGGER jush_nomination_quota BEFORE INSERT ON jush_nomination_cards
WHEN NOT EXISTS(SELECT 1 FROM jush_nomination_cards WHERE window=NEW.window AND member=NEW.member AND card=NEW.card)
 AND NOT EXISTS(SELECT 1 FROM jush_candidates WHERE window=NEW.window AND card=NEW.card AND starter=NEW.member)
 AND (SELECT count(*) FROM jush_nomination_cards WHERE window=NEW.window AND member=NEW.member)
     >= (SELECT nomination_limit FROM jush_member_nomination_limits WHERE member=NEW.member)
BEGIN SELECT RAISE(ABORT,'Nomination quota constraint'); END;
