-- index idx_vb_gold_author
CREATE INDEX "idx_vb_gold_author" ON "vb_gold"("author");

-- index idx_vb_gold_created_at
CREATE INDEX "idx_vb_gold_created_at" ON "vb_gold"("created_at");

-- index idx_vb_gold_people_created_at
CREATE INDEX "idx_vb_gold_people_created_at" ON "vb_gold_people"("created_at");

-- index idx_vb_gold_people_updated_at
CREATE INDEX "idx_vb_gold_people_updated_at" ON "vb_gold_people"("updated_at");

-- index idx_vb_gold_updated_at
CREATE INDEX "idx_vb_gold_updated_at" ON "vb_gold"("updated_at");

-- table vb_gold
CREATE TABLE "vb_gold" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "slug" TEXT UNIQUE,
  "body" TEXT,
  "contact" TEXT,
  "site" TEXT,
  "price" REAL,
  "active" INTEGER,
  "when" INTEGER,
  "stamp" INTEGER,
  "status" TEXT,
  "tags" TEXT,
  "meta" TEXT,
  "cover" TEXT,
  "docs" TEXT,
  "author" TEXT,
  "editors" TEXT,
  "pt" TEXT,
  "emb" TEXT,
  "hue" TEXT,
  "secret" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch()),
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

-- table vb_gold_fts
CREATE VIRTUAL TABLE "vb_gold_fts" USING fts5("title", "body", content="vb_gold", content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');

-- table vb_gold_fts_config
CREATE TABLE 'vb_gold_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- table vb_gold_fts_data
CREATE TABLE 'vb_gold_fts_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table vb_gold_fts_docsize
CREATE TABLE 'vb_gold_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table vb_gold_fts_idx
CREATE TABLE 'vb_gold_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table vb_gold_people
CREATE TABLE "vb_gold_people" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT,
  "role" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch()),
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

-- trigger vb_gold_fts_ad
CREATE TRIGGER "vb_gold_fts_ad" AFTER DELETE ON "vb_gold" BEGIN
         INSERT INTO "vb_gold_fts"("vb_gold_fts", rowid, "title", "body") VALUES ('delete', old.rowid, old."title", old."body");
       END;

-- trigger vb_gold_fts_ai
CREATE TRIGGER "vb_gold_fts_ai" AFTER INSERT ON "vb_gold" BEGIN
         INSERT INTO "vb_gold_fts"(rowid, "title", "body") VALUES (new.rowid, new."title", new."body");
       END;

-- trigger vb_gold_fts_au
CREATE TRIGGER "vb_gold_fts_au" AFTER UPDATE OF "title", "body" ON "vb_gold" BEGIN
         INSERT INTO "vb_gold_fts"("vb_gold_fts", rowid, "title", "body") VALUES ('delete', old.rowid, old."title", old."body");
         INSERT INTO "vb_gold_fts"(rowid, "title", "body") VALUES (new.rowid, new."title", new."body");
       END;

