-- Add the reviewed pre-cutoff TCG cards omitted by incomplete upstream release metadata.

-- Repeat-safe and additive: restriction versions, administrators, sessions, events and image ledgers are untouched.

PRAGMA foreign_keys = ON;

INSERT INTO cards_cache(card_id,name,sort_name,category,subtype,card_type,race,attribute,level,atk,def,description,image_source_url,canonical_id,artwork_ids_json,tcg_date,frame_type,placement,link_rating,pendulum_scale,archetype,treated_as,copy_limit_key,pool_verified,metadata_revision,updated_at) VALUES
(483,'Parallel Teleport','parallel teleport','Spell','Spell','Spell Card','Quick-Play',NULL,NULL,NULL,NULL,'Tribute 1 Psychic monster with a Level; Special Summon 1 Level 7 or lower Psychic monster from your Deck or Extra Deck, then if the original Level of the Tributed monster is different from that of the Special Summoned monster on the field, you lose LP equal to the difference x 1000. You cannot Special Summon the turn you activate this card, except Psychic monsters. You can only activate 1 "Parallel Teleport" per turn.','https://images.ygoprodeck.com/images/cards_small/483.jpg',483,'[483]','2025-07-03','spell','main',NULL,NULL,'Teleport',NULL,'parallel teleport',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(336601,'Moon Gardna','moon gardna','Monster','Effect','Effect Monster','Spellcaster','LIGHT',4,100,2000,'If your opponent controls 2 or more monsters, you can Special Summon this card (from your hand). You can only Special Summon "Moon Gardna" once per turn this way. If this card is Normal or Special Summoned and your opponent controls a monster: You can target 1 Level 4 LIGHT monster in your GY, except "Moon Gardna"; add it to your hand. You can only use this effect of "Moon Gardna" once per turn.','https://images.ygoprodeck.com/images/cards_small/336601.jpg',336601,'[336601]','2025-07-03','effect','main',NULL,NULL,NULL,NULL,'moon gardna',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(1122030,'Artmage Vandalism -Assault-','artmage vandalism assault','Spell','Spell','Spell Card','Continuous',NULL,NULL,NULL,NULL,'When this card is activated: You can add 1 "Medius the Pure" from your Deck to your hand. You can target 1 face-up monster you control; if that face-up monster would be used as Fusion Material this turn, it can be treated as an "Artmage" monster. You can only use this effect of "Artmage Vandalism -Assault-" once per turn. If "Artmage Academic Arcane Arts Acropolis" you control would be destroyed by card effect, you can send this card you control to the GY instead. You can only activate 1 "Artmage Vandalism -Assault-" per turn.','https://images.ygoprodeck.com/images/cards_small/1122030.jpg',1122030,'[1122030]','2025-07-03','spell','main',NULL,NULL,'Artmage',NULL,'artmage vandalism assault',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(2344618,'Lunalight Masquerade','lunalight masquerade','Spell','Spell','Spell Card','Continuous',NULL,NULL,NULL,NULL,'During your Main Phase, if this card was activated this turn: You can send 1 "Lunalight" monster from your Deck to the GY. If you Fusion Summon a "Lunalight" monster: You can add 1 "Polymerization" from your GY or banishment to your hand, then you can discard 1 card, and if you do, once, if you Fusion Summon a "Lunalight" monster this turn, you can also banish monsters from your GY as material. You can only use each effect of "Lunalight Masquerade" once per turn.','https://images.ygoprodeck.com/images/cards_small/2344618.jpg',2344618,'[2344618]','2025-07-03','spell','main',NULL,NULL,'Lunalight',NULL,'lunalight masquerade',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(9283801,'The Monarchs Revolt','the monarchs revolt','Spell','Spell','Spell Card','Normal',NULL,NULL,NULL,NULL,'Discard 1 card; reveal 3 monsters from your Deck, with 2400 or more ATK and 1000 DEF, and/or 800 ATK/1000 DEF, your opponent chooses 1 for you to add to your hand, and you send the rest to the GY, also for the rest of this turn after this card resolves, you cannot Special Summon from the Extra Deck. You can banish this card from your GY; Special Summon 1 monster with 800 ATK/1000 DEF from your hand. You can only use each effect of "The Monarchs Revolt" once per turn.','https://images.ygoprodeck.com/images/cards_small/9283801.jpg',9283801,'[9283801]','2025-07-03','spell','main',NULL,NULL,'Monarch',NULL,'the monarchs revolt',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(12067160,'Gorgon of Zilofthonia','gorgon of zilofthonia','Monster','Link','Link Monster','Reptile','DARK',NULL,100,NULL,'2+ Effect Monsters
You cannot Summon/Set monsters to a zone(s) this card points to. Monsters this card points to cannot attack, also their activated effects are negated. Gains ATK equal to the total original ATK of monsters this card points to. Cannot be destroyed by battle or monster effects, while this card points to no monsters.','https://images.ygoprodeck.com/images/cards_small/12067160.jpg',12067160,'[12067160]','2025-07-03','link','extra',3,NULL,NULL,NULL,'gorgon of zilofthonia',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(19316241,'Galaxy War Drake','galaxy war drake','Monster','Effect','Effect Monster','Dragon','LIGHT',4,1500,1000,'If a Level 4 LIGHT monster(s) is Special Summoned to your field (except during the Damage Step): You can Special Summon this card from your hand or GY, but banish it when it leaves the field. You can target 1 other Level 4 LIGHT monster you control; the Levels of both that monster and this card become 8 until the end of this turn. You can only use each effect of "Galaxy War Drake" once per turn, also you cannot Special Summon the turn you activate either of this card''s effects, except LIGHT monsters.','https://images.ygoprodeck.com/images/cards_small/19316241.jpg',19316241,'[19316241]','2025-07-03','effect','main',NULL,NULL,'Galaxy',NULL,'galaxy war drake',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(22377092,'Trap Holic','trap holic','Trap','Trap','Trap Card','Normal',NULL,NULL,NULL,NULL,'Target 1 Spell/Trap you control; destroy it, and if you do, Set 1 Normal Trap from your Deck, except "Trap Holic". It can be activated this turn, while you have 3 or more Traps in your GY. You can only activate 1 "Trap Holic" per turn.','https://images.ygoprodeck.com/images/cards_small/22377092.jpg',22377092,'[22377092]','2025-07-03','trap','main',NULL,NULL,NULL,NULL,'trap holic',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(23599634,'Artmage Pact -Awakening-','artmage pact awakening','Trap','Trap','Trap Card','Normal',NULL,NULL,NULL,NULL,'Special Summon 1 "Artmage" monster or 1 "Medius the Pure" from your Deck, also for the rest of this turn, the activation of your cards and effects that include an effect that Fusion Summons a Fusion Monster cannot be negated, also your opponent cannot activate cards or effects when a monster is Fusion Summoned this way. You can banish this card from your GY, then target 1 "Artmage" monster you control; return that monster to the hand/Extra Deck, and if you do, destroy 1 card your opponent controls. You can only use 1 "Artmage Pact -Awakening-" effect per turn, and only once that turn.','https://images.ygoprodeck.com/images/cards_small/23599634.jpg',23599634,'[23599634]','2025-07-03','trap','main',NULL,NULL,'Artmage',NULL,'artmage pact awakening',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(23611122,'Sudden Thunder Swamp','sudden thunder swamp','Spell','Spell','Spell Card','Continuous',NULL,NULL,NULL,NULL,'When this card is activated: You can discard 1 card, and if you do, Set 1 Continuous Trap from your Deck or GY, with an effect that Special Summons itself as a monster, except the discarded card. If a card(s) you control is destroyed by battle or card effect, and sent to the GY or banished face-up: You can target 1 of them; add 1 card with the same name from your Deck to your hand. You can only use this effect of "Sudden Thunder Swamp" once per turn. You can only activate 1 "Sudden Thunder Swamp" per turn.','https://images.ygoprodeck.com/images/cards_small/23611122.jpg',23611122,'[23611122]','2025-07-03','spell','main',NULL,NULL,NULL,NULL,'sudden thunder swamp',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(34433770,'Sky Striker Special Maneuver - Lemnisgate!','sky striker special maneuver lemnisgate','Spell','Spell','Spell Card','Quick-Play',NULL,NULL,NULL,NULL,'Target an equal number of "Sky Striker Ace" monsters and "Sky Striker" Spells in your GY; shuffle them into the Deck, then, for every 3 shuffled cards, you can return up to 1 card on the field to the hand. If a "Sky Striker" monster(s) is Special Summoned to your field, while this card is in your GY (except during the Damage Step): You can banish this card; immediately after this effect resolves, Link Summon 1 "Sky Striker Ace" Link Monster. You can only use each effect of "Sky Striker Special Maneuver - Lemnisgate!" once per turn.','https://images.ygoprodeck.com/images/cards_small/34433770.jpg',34433770,'[34433770]','2025-07-03','spell','main',NULL,NULL,'Sky Striker',NULL,'sky striker special maneuver lemnisgate',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(36494597,'Teleport Fusion','teleport fusion','Spell','Spell','Spell Card','Quick-Play',NULL,NULL,NULL,NULL,'During the Main Phase: Fusion Summon 1 Psychic Fusion Monster from your Extra Deck, by banishing Psychic monsters from your field or GY as material. If a face-up Psychic monster(s) you control that was Special Summoned from the Extra Deck is destroyed by battle or card effect: You can banish this card from your GY, then target 1 of your banished Psychic monsters; Special Summon it. You can only use each effect of "Teleport Fusion" once per turn.','https://images.ygoprodeck.com/images/cards_small/36494597.jpg',36494597,'[36494597]','2025-07-03','spell','main',NULL,NULL,'Fusion',NULL,'teleport fusion',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z')
ON CONFLICT(card_id) DO UPDATE SET name=excluded.name,sort_name=excluded.sort_name,category=excluded.category,subtype=excluded.subtype,card_type=excluded.card_type,race=excluded.race,attribute=excluded.attribute,level=excluded.level,atk=excluded.atk,def=excluded.def,description=excluded.description,image_source_url=excluded.image_source_url,canonical_id=excluded.canonical_id,artwork_ids_json=excluded.artwork_ids_json,tcg_date=excluded.tcg_date,frame_type=excluded.frame_type,placement=excluded.placement,link_rating=excluded.link_rating,pendulum_scale=excluded.pendulum_scale,archetype=excluded.archetype,treated_as=excluded.treated_as,copy_limit_key=excluded.copy_limit_key,pool_verified=excluded.pool_verified,metadata_revision=excluded.metadata_revision,updated_at=excluded.updated_at;

INSERT INTO cards_cache(card_id,name,sort_name,category,subtype,card_type,race,attribute,level,atk,def,description,image_source_url,canonical_id,artwork_ids_json,tcg_date,frame_type,placement,link_rating,pendulum_scale,archetype,treated_as,copy_limit_key,pool_verified,metadata_revision,updated_at) VALUES
(36672909,'Regenesis Cycle','regenesis cycle','Spell','Spell','Spell Card','Normal',NULL,NULL,NULL,NULL,'If you control a monster with 2500 original ATK or DEF: Target 1 card your opponent controls, or you can target 2 if you control "Regenesis Lord"; banish that card(s). If this card is in your GY, except the turn it was sent there: You can banish it; Special Summon 1 monster with 2500 ATK or DEF from your hand. You can only use each effect of "Regenesis Cycle" once per turn.','https://images.ygoprodeck.com/images/cards_small/36672909.jpg',36672909,'[36672909]','2025-07-03','spell','main',NULL,NULL,'Regenesis',NULL,'regenesis cycle',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(37517035,'Artmage Masterwork -Succession-','artmage masterwork succession','Spell','Spell','Spell Card','Quick-Play',NULL,NULL,NULL,NULL,'During the Main Phase: Fusion Summon 1 Fusion Monster from your Extra Deck, using monsters from your hand or field, including an "Artmage" monster, and if a card is in the Field Zone, that monster gains 500 ATK. During your Main Phase: You can banish this card from your GY, then target 3 "Artmage" cards with different names in your GY; shuffle them into the Deck. You can only use each effect of "Artmage Masterwork -Succession-" once per turn.','https://images.ygoprodeck.com/images/cards_small/37517035.jpg',37517035,'[37517035]','2025-07-03','spell','main',NULL,NULL,'Artmage',NULL,'artmage masterwork succession',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(48739627,'Theorealize','theorealize','Spell','Spell','Spell Card','Normal',NULL,NULL,NULL,NULL,'Send 1 "Medius the Pure" from your Deck to the GY; look at the top card of your opponent''s Deck, and place it on the top or bottom of the Deck. You can banish this card from your GY, then target 1 face-up monster you control and declare 1 Monster Type and 1 Attribute; that monster becomes that Type and Attribute, until the end of your opponent''s turn. You can only use each effect of "Theorealize" once per turn.','https://images.ygoprodeck.com/images/cards_small/48739627.jpg',48739627,'[48739627]','2025-07-03','spell','main',NULL,NULL,NULL,NULL,'theorealize',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(58761791,'Shipping Error','shipping error','Trap','Trap','Trap Card','Normal',NULL,NULL,NULL,NULL,'When a card or effect is activated that includes an effect that adds a card(s) from the Deck to the hand: The activated effect becomes "Your opponent takes 1 card from their Deck for you to add to your hand, and you must keep that card revealed. During the End Phase of this turn, shuffle it into the Deck, and if you do, draw 1 card".','https://images.ygoprodeck.com/images/cards_small/58761791.jpg',58761791,'[58761791]','2025-07-03','trap','main',NULL,NULL,NULL,NULL,'shipping error',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(59983249,'Monarchic Perfection','monarchic perfection','Trap','Trap','Trap Card','Continuous',NULL,NULL,NULL,NULL,'Once per Chain, if your opponent Special Summons a monster(s), and you control a Tribute Summoned monster (except during the Damage Step): You can banish 1 "Monarch" Spell/Trap from your GY, then activate 1 of these effects (but you can only use each effect of "Monarchic Perfection" once per turn);
● Destroy 1 monster on the field.
● Destroy up to 2 Spells/Traps on the field.
● Discard 1 random card from your opponent''s hand.
● Destroy 1 face-down card on the field.
● Place 1 card from the field on top of the Deck.
● Banish 1 card on the field.','https://images.ygoprodeck.com/images/cards_small/59983249.jpg',59983249,'[59983249]','2025-07-03','trap','main',NULL,NULL,'Monarch',NULL,'monarchic perfection',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(60600821,'Spring','spring','Spell','Spell','Spell Card','Field',NULL,NULL,NULL,NULL,'Once per turn: You can choose any number of your unused Main Monster Zones, and if you do, place that number of Season Counters on this card, also those zones cannot be used while this card is on the field. Monsters you control gain 400 ATK for each Season Counter on this card. Once per turn, during your opponent''s End Phase: You can take 1 Field Spell from your Deck that you can place a Season Counter on, and place it face-up on your field (but neither player can activate its effects this turn), and if you do, place all Season Counters on this card on that card.','https://images.ygoprodeck.com/images/cards_small/60600821.jpg',60600821,'[60600821]','2025-07-03','spell','main',NULL,NULL,NULL,NULL,'spring',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(61822419,'Guilt-Gripping Morganite','guilt gripping morganite','Spell','Spell','Spell Card','Normal',NULL,NULL,NULL,NULL,'For the rest of this Duel, apply the following effects.
● You cannot activate monster effects in the hand.
● You can Normal Summon Level 5 or higher monsters without Tributing.
● You do not pay LP to activate Spell/Trap Cards.
You can banish this card from your GY, then reveal 1 "Morganite" card in your hand; place the revealed card on the bottom of the Deck, then draw 1 card.','https://images.ygoprodeck.com/images/cards_small/61822419.jpg',61822419,'[61822419]','2025-07-03','spell','main',NULL,NULL,'Morganite',NULL,'guilt gripping morganite',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(61944066,'Nouvelles Recipe Book "Recettes de Nouvellez"','nouvelles recipe book recettes de nouvellez','Spell','Spell','Spell Card','Continuous',NULL,NULL,NULL,NULL,'While you control a "Nouvelles" Monster Card, all face-up monsters your opponent controls are changed to Attack Position. Each time a monster(s) is Tributed by a Ritual Monster''s effect, your opponent pays 850 LP. Once per turn, if you Special Summon a Ritual Monster(s) (except during the Damage Step): You can target 1 of them; add 1 "Recipe" or "Nouvelles" card from your Deck to your hand, except a Continuous Spell, and if you do, increase that monster''s Level by 1. You can only activate 1 "Nouvelles Recipe Book "Recettes de Nouvellez"" per turn.','https://images.ygoprodeck.com/images/cards_small/61944066.jpg',61944066,'[61944066]','2025-07-03','spell','main',NULL,NULL,'Nouvelles',NULL,'nouvelles recipe book recettes de nouvellez',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(62767644,'Inferno of the Ashened','inferno of the ashened','Spell','Spell','Spell Card','Continuous',NULL,NULL,NULL,NULL,'When this card is activated: You can place 1 "Obsidim, the Ashened City" from your Deck, face-up in either Field Zone. You can target 1 face-up card your opponent controls and 1 Level 8 or higher DARK Pyro monster in your GY; send that card on the field to the GY, and if you do, Special Summon that other monster from your GY to your opponent''s field in Defense Position. You can only use this effect of "Inferno of the Ashened" once per turn. You can only activate 1 "Inferno of the Ashened" per turn.','https://images.ygoprodeck.com/images/cards_small/62767644.jpg',62767644,'[62767644]','2025-07-03','spell','main',NULL,NULL,'Ashened',NULL,'inferno of the ashened',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(74011784,'Artmage Varnish -Alteration-','artmage varnish alteration','Spell','Spell','Spell Card','Normal',NULL,NULL,NULL,NULL,'Place 1 "Artmage Academic Arcane Arts Acropolis" from your Deck or GY, face-up in your Field Zone, or if you control "Artmage Academic Arcane Arts Acropolis", add 1 "Artmage" card from your Deck to your hand instead, except "Artmage Varnish -Alteration-". When your "Artmage" monster is targeted for an attack: You can banish this card from your GY; negate that attack, then you can Special Summon 1 "Medius the Pure" from your hand. You can only use each effect of "Artmage Varnish -Alteration-" once per turn.','https://images.ygoprodeck.com/images/cards_small/74011784.jpg',74011784,'[74011784]','2025-07-03','spell','main',NULL,NULL,'Artmage',NULL,'artmage varnish alteration',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(74941992,'Moon Magician','moon magician','Monster','Effect','Effect Monster','Spellcaster','LIGHT',4,1800,1500,'If your opponent controls an Xyz Monster, you can Special Summon this card (from your hand). You can only Special Summon "Moon Magician" once per turn this way. If this card is Normal or Special Summoned: You can target 1 Level 4 LIGHT monster in your GY, except "Moon Magician"; Special Summon it, but negate its effects. You can only use this effect of "Moon Magician" once per turn.','https://images.ygoprodeck.com/images/cards_small/74941992.jpg',74941992,'[74941992]','2025-07-03','effect','main',NULL,NULL,NULL,NULL,'moon magician',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(75956913,'Gagaga Utopic Tactics','gagaga utopic tactics','Spell','Spell','Spell Card','Continuous',NULL,NULL,NULL,NULL,'"Utopia" and "Utopic" Xyz Monsters you control whose original Attribute is LIGHT cannot be destroyed by card effects, also your opponent cannot target them with card effects. You can only use each of the following effects of "Gagaga Utopic Tactics" once per turn. You can declare a Level from 1 to 12, then target 2 face-up monsters you control, including a "Gagaga" monster; they become that Level. If you Xyz Summon a "Utopia" or "Utopic" Xyz Monster whose original Attribute is LIGHT: You can target 1 card your opponent controls; destroy it.','https://images.ygoprodeck.com/images/cards_small/75956913.jpg',75956913,'[75956913]','2025-07-03','spell','main',NULL,NULL,'Gagaga',NULL,'gagaga utopic tactics',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z')
ON CONFLICT(card_id) DO UPDATE SET name=excluded.name,sort_name=excluded.sort_name,category=excluded.category,subtype=excluded.subtype,card_type=excluded.card_type,race=excluded.race,attribute=excluded.attribute,level=excluded.level,atk=excluded.atk,def=excluded.def,description=excluded.description,image_source_url=excluded.image_source_url,canonical_id=excluded.canonical_id,artwork_ids_json=excluded.artwork_ids_json,tcg_date=excluded.tcg_date,frame_type=excluded.frame_type,placement=excluded.placement,link_rating=excluded.link_rating,pendulum_scale=excluded.pendulum_scale,archetype=excluded.archetype,treated_as=excluded.treated_as,copy_limit_key=excluded.copy_limit_key,pool_verified=excluded.pool_verified,metadata_revision=excluded.metadata_revision,updated_at=excluded.updated_at;

INSERT INTO cards_cache(card_id,name,sort_name,category,subtype,card_type,race,attribute,level,atk,def,description,image_source_url,canonical_id,artwork_ids_json,tcg_date,frame_type,placement,link_rating,pendulum_scale,archetype,treated_as,copy_limit_key,pool_verified,metadata_revision,updated_at) VALUES
(85150300,'Spirit Poacher','spirit poacher','Trap','Trap','Trap Card','Continuous',NULL,NULL,NULL,NULL,'Once per turn, during your opponent''s Standby Phase: You can activate 1 of these effects;
● Place 1 monster from your Deck in your Spell & Trap Zone as a face-up Continuous Spell.
● Your opponent can Special Summon 1 Monster Card with less original ATK than their LP from your Spell & Trap Zone to their field, then they pay LP equal to its original ATK.
If an Effect Monster(s) you own is Special Summoned to your opponent''s field: You can send this face-up card from the Spell & Trap Zone to the GY; Special Summon 1 Level 4 or lower monster from your Deck.','https://images.ygoprodeck.com/images/cards_small/85150300.jpg',85150300,'[85150300]','2025-07-03','trap','main',NULL,NULL,NULL,NULL,'spirit poacher',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(87640391,'Migratory Zereort','migratory zereort','Monster','Effect','Effect Monster','Winged Beast','WATER',5,1000,2200,'If a WATER Xyz Monster is on the field: You can Special Summon this card from your hand. During your Main Phase: You can detach 1 Xyz Material from a monster you control, then you can Special Summon 1 Level 3 or 4 WATER monster from your hand or GY, but its effects are negated, also if it is used for the Xyz Summon of a WATER monster this turn, it can be treated as a Level 5 monster. You can only use each effect of "Zereort Migrator" once per turn.','https://images.ygoprodeck.com/images/cards_small/87640391.jpg',87640391,'[87640391]','2025-05-01','effect','main',NULL,NULL,NULL,NULL,'migratory zereort',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(93413793,'Ukanomitsune-no-Tamayura','ukanomitsune no tamayura','Monster','Effect','Tuner Monster','Beast','LIGHT',3,1500,300,'If you control a Level 4 or lower LIGHT Beast, Plant, or Fairy monster: You can Special Summon this card from your hand. A monster that was Synchro Summoned using this card as material gains these effects.
● Gains 500 DEF.
● Your opponent cannot target this Defense Position card with card effects.
You can only use each effect of "Ukanomitsune-no-Tamayura" once per turn.','https://images.ygoprodeck.com/images/cards_small/93413793.jpg',93413793,'[93413793]','2025-07-03','effect','main',NULL,NULL,NULL,NULL,'ukanomitsune no tamayura',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(95382988,'Regenesis Commands','regenesis commands','Trap','Trap','Trap Card','Normal',NULL,NULL,NULL,NULL,'Apply these effects to all cards your opponent controls in the same column as your "Regenesis" monsters.
● Face-up cards: Negate their effects.
● Face-down monsters: Cannot change their battle positions.
● Face-down Spells/Traps: Cannot be activated until the end of the next turn.
You can only activate 1 "Regenesis Commands" per turn.','https://images.ygoprodeck.com/images/cards_small/95382988.jpg',95382988,'[95382988]','2025-07-03','trap','main',NULL,NULL,'Regenesis',NULL,'regenesis commands',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(96004535,'Unbreakable Xyz Barrier','unbreakable xyz barrier','Trap','Trap','Trap Card','Counter',NULL,NULL,NULL,NULL,'When a Spell/Trap Card, or monster effect, is activated while you control an Xyz Monster: Negate the activation, then you can detach 2 materials from a monster(s) you control, then destroy 1 card on the field. You can banish this card from your GY, then target 1 Xyz Monster you control; attach 1 LIGHT "Utopia" or "Utopic" Xyz Monster from your GY to it. You can only use each effect of "Unbreakable Xyz Barrier" once per turn.','https://images.ygoprodeck.com/images/cards_small/96004535.jpg',96004535,'[96004535]','2025-07-03','trap','main',NULL,NULL,'Xyz',NULL,'unbreakable xyz barrier',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(97227123,'Return of the Duelist','return of the duelist','Spell','Spell','Spell Card','Normal',NULL,NULL,NULL,NULL,'If an Xyz Monster is on the field or in either GY: Add 1 Equip Spell from your Deck or GY to your hand. You can only activate 1 "Return of the Duelist" per turn.','https://images.ygoprodeck.com/images/cards_small/97227123.jpg',97227123,'[97227123]','2025-07-03','spell','main',NULL,NULL,NULL,NULL,'return of the duelist',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(98349765,'Layer 19 "Sudden Incursion! Super Quantum Black!!"','layer 19 sudden incursion super quantum black','Spell','Spell','Spell Card','Quick-Play',NULL,NULL,NULL,NULL,'Activate 1 of these effects (but you can only use each effect of "Layer 19: "Preventing the Invasion! The Pitch-Black Super Quantum!!"" once per turn);
● Target 1 Attack Position monster on the field; change it to Defense Position.
● If you control a "Super Quant" monster: Special Summon 1 "Super Quant" monster from your Deck in Defense Position, with a different original Attribute from the monsters you control.
● Set 1 "Super Quant" Trap from your Deck. It can be activated this turn.','https://images.ygoprodeck.com/images/cards_small/98349765.jpg',98349765,'[98349765]','2025-07-03','spell','main',NULL,NULL,'Super Quant',NULL,'layer 19 sudden incursion super quantum black',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z'),
(99161253,'Primite Fusion','primite fusion','Spell','Spell','Spell Card','Normal',NULL,NULL,NULL,NULL,'Fusion Summon 1 Dragon Fusion Monster from your Extra Deck, by shuffling its materials from your field, GY, and/or banishment into the Deck, including a Normal Monster. You can banish this card from your GY; add 1 Level 5 or higher "Primite" monster from your Deck or GY to your hand. You can only use each effect of "Primite Fusion" once per turn.','https://images.ygoprodeck.com/images/cards_small/99161253.jpg',99161253,'[99161253]','2025-07-03','spell','main',NULL,NULL,'Polymerization',NULL,'primite fusion',1,'2026-10-22T21:28:04.060Z','2026-10-22T21:28:04.060Z')
ON CONFLICT(card_id) DO UPDATE SET name=excluded.name,sort_name=excluded.sort_name,category=excluded.category,subtype=excluded.subtype,card_type=excluded.card_type,race=excluded.race,attribute=excluded.attribute,level=excluded.level,atk=excluded.atk,def=excluded.def,description=excluded.description,image_source_url=excluded.image_source_url,canonical_id=excluded.canonical_id,artwork_ids_json=excluded.artwork_ids_json,tcg_date=excluded.tcg_date,frame_type=excluded.frame_type,placement=excluded.placement,link_rating=excluded.link_rating,pendulum_scale=excluded.pendulum_scale,archetype=excluded.archetype,treated_as=excluded.treated_as,copy_limit_key=excluded.copy_limit_key,pool_verified=excluded.pool_verified,metadata_revision=excluded.metadata_revision,updated_at=excluded.updated_at;

INSERT INTO card_artworks(artwork_id,canonical_id,is_default,updated_at) VALUES
(483,483,1,'2026-10-22T21:28:04.060Z'),
(336601,336601,1,'2026-10-22T21:28:04.060Z'),
(1122030,1122030,1,'2026-10-22T21:28:04.060Z'),
(2344618,2344618,1,'2026-10-22T21:28:04.060Z'),
(9283801,9283801,1,'2026-10-22T21:28:04.060Z'),
(12067160,12067160,1,'2026-10-22T21:28:04.060Z'),
(19316241,19316241,1,'2026-10-22T21:28:04.060Z'),
(22377092,22377092,1,'2026-10-22T21:28:04.060Z'),
(23599634,23599634,1,'2026-10-22T21:28:04.060Z'),
(23611122,23611122,1,'2026-10-22T21:28:04.060Z'),
(34433770,34433770,1,'2026-10-22T21:28:04.060Z'),
(36494597,36494597,1,'2026-10-22T21:28:04.060Z'),
(36672909,36672909,1,'2026-10-22T21:28:04.060Z'),
(37517035,37517035,1,'2026-10-22T21:28:04.060Z'),
(48739627,48739627,1,'2026-10-22T21:28:04.060Z'),
(58761791,58761791,1,'2026-10-22T21:28:04.060Z'),
(59983249,59983249,1,'2026-10-22T21:28:04.060Z'),
(60600821,60600821,1,'2026-10-22T21:28:04.060Z'),
(61822419,61822419,1,'2026-10-22T21:28:04.060Z'),
(61944066,61944066,1,'2026-10-22T21:28:04.060Z'),
(62767644,62767644,1,'2026-10-22T21:28:04.060Z'),
(74011784,74011784,1,'2026-10-22T21:28:04.060Z'),
(74941992,74941992,1,'2026-10-22T21:28:04.060Z'),
(75956913,75956913,1,'2026-10-22T21:28:04.060Z'),
(85150300,85150300,1,'2026-10-22T21:28:04.060Z'),
(87640391,87640391,1,'2026-10-22T21:28:04.060Z'),
(93413793,93413793,1,'2026-10-22T21:28:04.060Z'),
(95382988,95382988,1,'2026-10-22T21:28:04.060Z'),
(96004535,96004535,1,'2026-10-22T21:28:04.060Z'),
(97227123,97227123,1,'2026-10-22T21:28:04.060Z'),
(98349765,98349765,1,'2026-10-22T21:28:04.060Z'),
(99161253,99161253,1,'2026-10-22T21:28:04.060Z')
ON CONFLICT(artwork_id) DO UPDATE SET canonical_id=excluded.canonical_id,is_default=excluded.is_default,updated_at=excluded.updated_at;

INSERT INTO card_id_evidence(input_id,canonical_id,tcg_date,eligible,reason,updated_at) VALUES
(483,483,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(336601,336601,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(1122030,1122030,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(2344618,2344618,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(9283801,9283801,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(12067160,12067160,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(19316241,19316241,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(22377092,22377092,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(23599634,23599634,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(23611122,23611122,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(34433770,34433770,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(36494597,36494597,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(36672909,36672909,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(37517035,37517035,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(48739627,48739627,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(58761791,58761791,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(59983249,59983249,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(60600821,60600821,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(61822419,61822419,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(61944066,61944066,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(62767644,62767644,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(74011784,74011784,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(74941992,74941992,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(75956913,75956913,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(85150300,85150300,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(87640391,87640391,'2025-05-01',1,'eligible','2026-10-22T21:28:04.060Z'),
(93413793,93413793,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(95382988,95382988,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(96004535,96004535,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(97227123,97227123,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(98349765,98349765,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z'),
(99161253,99161253,'2025-07-03',1,'eligible','2026-10-22T21:28:04.060Z')
ON CONFLICT(input_id) DO UPDATE SET canonical_id=excluded.canonical_id,tcg_date=excluded.tcg_date,eligible=excluded.eligible,reason=excluded.reason,updated_at=excluded.updated_at;

INSERT INTO card_name_search(search_text,card_id) VALUES
('parallel teleport',483),
('teleport',483),
('gardna',336601),
('moon gardna',336601),
('artmage vandalism assault',1122030),
('assault',1122030),
('vandalism assault',1122030),
('lunalight masquerade',2344618),
('masquerade',2344618),
('monarchs revolt',9283801),
('revolt',9283801),
('the monarchs revolt',9283801),
('gorgon of zilofthonia',12067160),
('of zilofthonia',12067160),
('zilofthonia',12067160),
('drake',19316241),
('galaxy war drake',19316241),
('war drake',19316241),
('holic',22377092),
('trap holic',22377092),
('artmage pact awakening',23599634),
('awakening',23599634),
('pact awakening',23599634),
('sudden thunder swamp',23611122),
('swamp',23611122),
('thunder swamp',23611122),
('lemnisgate',34433770),
('maneuver lemnisgate',34433770),
('sky striker special maneuver lemnisgate',34433770),
('special maneuver lemnisgate',34433770),
('striker special maneuver lemnisgate',34433770),
('fusion',36494597),
('teleport fusion',36494597),
('cycle',36672909),
('regenesis cycle',36672909),
('artmage masterwork succession',37517035),
('masterwork succession',37517035),
('succession',37517035),
('theorealize',48739627),
('error',58761791),
('shipping error',58761791),
('monarchic perfection',59983249),
('perfection',59983249),
('spring',60600821),
('gripping morganite',61822419),
('guilt gripping morganite',61822419),
('morganite',61822419),
('book recettes de nouvellez',61944066),
('de nouvellez',61944066),
('nouvelles recipe book recettes de nouvellez',61944066),
('nouvellez',61944066),
('recettes de nouvellez',61944066),
('recipe book recettes de nouvellez',61944066),
('ashened',62767644),
('inferno of the ashened',62767644),
('of the ashened',62767644),
('the ashened',62767644),
('alteration',74011784),
('artmage varnish alteration',74011784),
('varnish alteration',74011784),
('magician',74941992),
('moon magician',74941992),
('gagaga utopic tactics',75956913),
('tactics',75956913),
('utopic tactics',75956913),
('poacher',85150300),
('spirit poacher',85150300),
('migratory zereort',87640391),
('zereort',87640391),
('no tamayura',93413793),
('tamayura',93413793),
('ukanomitsune no tamayura',93413793),
('commands',95382988),
('regenesis commands',95382988),
('barrier',96004535),
('unbreakable xyz barrier',96004535),
('xyz barrier',96004535),
('duelist',97227123),
('of the duelist',97227123),
('return of the duelist',97227123),
('the duelist',97227123),
('19 sudden incursion super quantum black',98349765),
('black',98349765),
('incursion super quantum black',98349765),
('layer 19 sudden incursion super quantum black',98349765),
('quantum black',98349765),
('sudden incursion super quantum black',98349765),
('super quantum black',98349765),
('fusion',99161253),
('primite fusion',99161253)
ON CONFLICT(search_text,card_id) DO NOTHING;

INSERT INTO catalogue_meta(key,value) VALUES ('revision','2026-10-22T21:28:13.629Z-reviewed-release-evidence')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;

INSERT INTO catalogue_meta(key,value) VALUES ('source','YGOPRODeck API v7 + reviewed TCG release evidence')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;

UPDATE catalogue_meta SET value=CAST((SELECT COUNT(*) FROM cards_cache WHERE pool_verified=1) AS TEXT) WHERE key='eligible_cards';

UPDATE catalogue_meta SET value=CAST((SELECT COUNT(*) FROM card_artworks) AS TEXT) WHERE key='artwork_ids';

UPDATE catalogue_meta SET value=CAST((SELECT COUNT(*) FROM card_id_evidence) AS TEXT) WHERE key='evidence_cards';

UPDATE entries SET card_id=(SELECT c.card_id FROM cards_cache c WHERE c.pool_verified=1 AND c.sort_name=entries.sort_name ORDER BY c.card_id LIMIT 1)
  WHERE card_id IS NULL AND 1=(SELECT COUNT(*) FROM cards_cache c WHERE c.pool_verified=1 AND c.sort_name=entries.sort_name);

DELETE FROM search_cache;
