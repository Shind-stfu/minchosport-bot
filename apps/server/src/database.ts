import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    margin_cop INTEGER NOT NULL CHECK (margin_cop IN (5000, 10000)),
    target_groups TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    raw_text TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    source_price_cop INTEGER,
    final_price_cop INTEGER,
    output_text TEXT,
    status TEXT NOT NULL CHECK (status IN ('needs_review', 'approved', 'simulated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(product_id, position)
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode = 'simulation'),
    status TEXT NOT NULL CHECK (status IN ('simulated', 'canceled')),
    created_at TEXT NOT NULL,
    UNIQUE(product_id, group_id, mode)
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_deliveries_product ON deliveries(product_id, created_at);`,
  `CREATE TABLE IF NOT EXISTS whatsapp_groups (
    jid TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS whatsapp_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source_group_id TEXT,
    target_group_ids TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO whatsapp_settings(id, source_group_id, target_group_ids, updated_at)
  VALUES (1, NULL, '[]', CURRENT_TIMESTAMP);`,
  `CREATE TABLE IF NOT EXISTS whatsapp_auth_meta (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS whatsapp_auth_records (
    record_type TEXT NOT NULL,
    record_id TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    PRIMARY KEY(record_type, record_id)
  );`,
  `CREATE TABLE IF NOT EXISTS whatsapp_source_messages (
    group_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    participant_jid TEXT NOT NULL DEFAULT '',
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    received_at TEXT NOT NULL,
    PRIMARY KEY(group_jid, message_id)
  );
  CREATE TABLE IF NOT EXISTS whatsapp_product_assemblies (
    product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    group_jid TEXT NOT NULL,
    participant_jid TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    media_count INTEGER NOT NULL DEFAULT 0,
    expected_media_count INTEGER,
    status TEXT NOT NULL CHECK(status IN ('open','closed'))
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_assemblies_open ON whatsapp_product_assemblies(group_jid, participant_jid, status, last_message_at);`,
  `CREATE TABLE IF NOT EXISTS outbound_publications (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
    status TEXT NOT NULL CHECK(status IN ('queued','in_progress','submitted','needs_review','failed','canceled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(product_id, group_id, generation)
  );
  CREATE TABLE IF NOT EXISTS outbound_units (
    id TEXT PRIMARY KEY,
    publication_id TEXT NOT NULL REFERENCES outbound_publications(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    media_asset_id TEXT NOT NULL REFERENCES media_assets(id),
    status TEXT NOT NULL CHECK(status IN ('pending','transmitting','submitted','uncertain','failed','canceled')),
    remote_message_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    UNIQUE(publication_id, position)
  );
  CREATE INDEX IF NOT EXISTS idx_outbound_publications_status ON outbound_publications(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_outbound_units_status ON outbound_units(status, publication_id, position);`,
  `CREATE TABLE IF NOT EXISTS distribution_control (
    id INTEGER PRIMARY KEY CHECK(id=1),
    status TEXT NOT NULL CHECK(status IN ('stopped','paused','running')),
    updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO distribution_control(id,status,updated_at) VALUES (1,'stopped',CURRENT_TIMESTAMP);`,
  `ALTER TABLE whatsapp_product_assemblies ADD COLUMN association_confident INTEGER NOT NULL DEFAULT 0 CHECK(association_confident IN (0,1));`,
  `CREATE TABLE whatsapp_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
  INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('main','Cuenta principal',CURRENT_TIMESTAMP);
  CREATE TABLE session_distribution_control (
    session_id TEXT PRIMARY KEY REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('stopped','paused','running')),
    updated_at TEXT NOT NULL
  );
  INSERT INTO session_distribution_control(session_id,status,updated_at) VALUES ('main','stopped',CURRENT_TIMESTAMP);
  CREATE TABLE whatsapp_session_settings (
    session_id TEXT PRIMARY KEY REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    target_group_ids TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  INSERT INTO whatsapp_session_settings(session_id,target_group_ids,updated_at)
    SELECT 'main',target_group_ids,updated_at FROM whatsapp_settings WHERE id=1;
  CREATE TABLE supplier_profiles (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id),
    source_group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    margin_cop INTEGER NOT NULL CHECK(margin_cop BETWEEN 0 AND 1000000),
    marker_text TEXT NOT NULL DEFAULT '🌎',
    default_position TEXT NOT NULL DEFAULT 'bottom_right' CHECK(default_position IN ('top_left','top_right','bottom_left','bottom_right')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(session_id,source_group_id)
  );
  ALTER TABLE products ADD COLUMN session_id TEXT REFERENCES whatsapp_sessions(id);
  UPDATE products SET session_id='main' WHERE session_id IS NULL;
  CREATE TRIGGER products_session_default AFTER INSERT ON products WHEN NEW.session_id IS NULL BEGIN UPDATE products SET session_id='main' WHERE id=NEW.id; END;
  CREATE TRIGGER products_session_required BEFORE UPDATE OF session_id ON products WHEN NEW.session_id IS NULL BEGIN SELECT RAISE(ABORT,'products.session_id is required'); END;
  ALTER TABLE products ADD COLUMN supplier_id TEXT REFERENCES supplier_profiles(id);
  ALTER TABLE products ADD COLUMN margin_cop_applied INTEGER;
  ALTER TABLE products ADD COLUMN shoe_code TEXT;
  ALTER TABLE products ADD COLUMN shoe_code_override INTEGER NOT NULL DEFAULT 0 CHECK(shoe_code_override IN (0,1));
  ALTER TABLE products ADD COLUMN marker_text_applied TEXT;
  ALTER TABLE products ADD COLUMN image_position TEXT CHECK(image_position IN ('top_left','top_right','bottom_left','bottom_right'));
  ALTER TABLE whatsapp_product_assemblies ADD COLUMN session_id TEXT REFERENCES whatsapp_sessions(id);
  UPDATE whatsapp_product_assemblies SET session_id='main' WHERE session_id IS NULL;
  CREATE TRIGGER assemblies_session_default AFTER INSERT ON whatsapp_product_assemblies WHEN NEW.session_id IS NULL BEGIN UPDATE whatsapp_product_assemblies SET session_id='main' WHERE product_id=NEW.product_id; END;
  CREATE TRIGGER assemblies_session_required BEFORE UPDATE OF session_id ON whatsapp_product_assemblies WHEN NEW.session_id IS NULL BEGIN SELECT RAISE(ABORT,'assemblies.session_id is required'); END;
  ALTER TABLE outbound_publications ADD COLUMN session_id TEXT REFERENCES whatsapp_sessions(id);
  UPDATE outbound_publications SET session_id='main' WHERE session_id IS NULL;
  CREATE TRIGGER publications_session_default AFTER INSERT ON outbound_publications WHEN NEW.session_id IS NULL BEGIN UPDATE outbound_publications SET session_id='main' WHERE id=NEW.id; END;
  CREATE TRIGGER publications_session_required BEFORE UPDATE OF session_id ON outbound_publications WHEN NEW.session_id IS NULL BEGIN SELECT RAISE(ABORT,'publications.session_id is required'); END;
  ALTER TABLE outbound_units ADD COLUMN rendered_file_name TEXT;
  ALTER TABLE outbound_units ADD COLUMN rendered_mime_type TEXT;
  ALTER TABLE outbound_units ADD COLUMN caption_snapshot TEXT;
  ALTER TABLE outbound_units ADD COLUMN session_id TEXT REFERENCES whatsapp_sessions(id);
  UPDATE outbound_units SET session_id='main' WHERE session_id IS NULL;
  CREATE TRIGGER units_session_default AFTER INSERT ON outbound_units WHEN NEW.session_id IS NULL BEGIN UPDATE outbound_units SET session_id='main' WHERE id=NEW.id; END;
  CREATE TRIGGER units_session_required BEFORE UPDATE OF session_id ON outbound_units WHEN NEW.session_id IS NULL BEGIN SELECT RAISE(ABORT,'outbound_units.session_id is required'); END;
  ALTER TABLE whatsapp_groups RENAME TO whatsapp_groups_legacy;
  CREATE TABLE whatsapp_groups (
    session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    jid TEXT NOT NULL,
    subject TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(session_id,jid)
  );
  INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) SELECT 'main',jid,subject,updated_at FROM whatsapp_groups_legacy;
  DROP TABLE whatsapp_groups_legacy;
  ALTER TABLE whatsapp_auth_records RENAME TO whatsapp_auth_records_legacy;
  CREATE TABLE whatsapp_auth_records (
    session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    record_type TEXT NOT NULL,
    record_id TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    PRIMARY KEY(session_id,record_type,record_id)
  );
  INSERT INTO whatsapp_auth_records(session_id,record_type,record_id,ciphertext) SELECT 'main',record_type,record_id,ciphertext FROM whatsapp_auth_records_legacy;
  DROP TABLE whatsapp_auth_records_legacy;
  ALTER TABLE whatsapp_source_messages RENAME TO whatsapp_source_messages_legacy;
  CREATE TABLE whatsapp_source_messages (
    session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    group_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    participant_jid TEXT NOT NULL DEFAULT '',
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    received_at TEXT NOT NULL,
    PRIMARY KEY(session_id,group_jid,message_id)
  );
  INSERT INTO whatsapp_source_messages(session_id,group_jid,message_id,participant_jid,product_id,received_at)
    SELECT 'main',group_jid,message_id,participant_jid,product_id,received_at FROM whatsapp_source_messages_legacy;
  DROP TABLE whatsapp_source_messages_legacy;
  CREATE INDEX idx_whatsapp_groups_session ON whatsapp_groups(session_id,subject COLLATE NOCASE);
  CREATE INDEX idx_products_session_supplier ON products(session_id,supplier_id,created_at DESC);
  CREATE INDEX idx_publications_session_status ON outbound_publications(session_id,status,created_at);
  INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at)
    SELECT 'supplier-main', 'main', ws.source_group_id, COALESCE((SELECT subject FROM whatsapp_groups WHERE session_id='main' AND jid=ws.source_group_id), 'Proveedor principal'), s.margin_cop, '🌎', 'bottom_right', ws.updated_at, ws.updated_at
    FROM whatsapp_settings ws CROSS JOIN settings s WHERE ws.id=1 AND ws.source_group_id IS NOT NULL AND s.id=1;
  UPDATE products SET supplier_id=(SELECT sp.id FROM supplier_profiles sp JOIN whatsapp_product_assemblies a ON a.group_jid=sp.source_group_id WHERE sp.session_id='main' AND a.product_id=products.id),
    margin_cop_applied=(SELECT margin_cop FROM supplier_profiles sp JOIN whatsapp_product_assemblies a ON a.group_jid=sp.source_group_id WHERE sp.session_id='main' AND a.product_id=products.id),
    marker_text_applied='🌎', image_position='bottom_right'
    WHERE EXISTS (SELECT 1 FROM whatsapp_product_assemblies a WHERE a.product_id=products.id);`,
  `CREATE TABLE application_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id),
    level TEXT NOT NULL CHECK(level IN ('info','warning','error')),
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_application_logs_session_created ON application_logs(session_id,created_at DESC,id DESC);
  CREATE INDEX idx_application_logs_category ON application_logs(session_id,category,created_at DESC);
  INSERT INTO application_logs(id,session_id,level,category,action,entity_type,entity_id,message,details_json,created_at)
    SELECT a.id,
      CASE
        WHEN a.entity_type IN ('whatsapp_session','distribution') AND EXISTS(SELECT 1 FROM whatsapp_sessions s WHERE s.id=a.entity_id) THEN a.entity_id
        WHEN a.entity_type='product' THEN COALESCE((SELECT p.session_id FROM products p WHERE p.id=a.entity_id),'main')
        WHEN a.entity_type='supplier' THEN COALESCE((SELECT p.session_id FROM supplier_profiles p WHERE p.id=a.entity_id),'main')
        ELSE 'main'
      END,
      CASE WHEN a.action LIKE '%.error%' OR a.action LIKE '%.failed%' OR a.action LIKE '%.uncertain%' THEN 'error' ELSE 'info' END,
      CASE a.entity_type WHEN 'product' THEN 'products' WHEN 'supplier' THEN 'suppliers' WHEN 'whatsapp_session' THEN 'connection' WHEN 'whatsapp' THEN 'connection' WHEN 'distribution' THEN 'distribution' ELSE 'settings' END,
      a.action,a.entity_type,a.entity_id,a.action,a.details_json,a.created_at
    FROM audit_events a;
  CREATE TRIGGER application_logs_no_update BEFORE UPDATE ON application_logs BEGIN SELECT RAISE(ABORT,'application logs are append-only'); END;`,
  `CREATE TABLE image_inspections (
    media_asset_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
    ocr_text TEXT NOT NULL,
    ocr_confidence REAL NOT NULL DEFAULT 0 CHECK(ocr_confidence BETWEEN 0 AND 1),
    ocr_error TEXT,
    code_candidates_json TEXT NOT NULL DEFAULT '[]',
    detected_code TEXT,
    code_confidence REAL NOT NULL DEFAULT 0 CHECK(code_confidence BETWEEN 0 AND 1),
    world_variant TEXT,
    world_confidence REAL NOT NULL DEFAULT 0 CHECK(world_confidence BETWEEN 0 AND 1),
    inspected_at TEXT NOT NULL
  );
  CREATE INDEX idx_image_inspections_detected_code ON image_inspections(detected_code) WHERE detected_code IS NOT NULL;`,
  `ALTER TABLE whatsapp_session_settings ADD COLUMN send_interval_ms INTEGER NOT NULL DEFAULT 10000 CHECK(send_interval_ms BETWEEN 5000 AND 120000);
  ALTER TABLE session_distribution_control ADD COLUMN last_send_at TEXT;`,
  `ALTER TABLE supplier_profiles ADD COLUMN box_margin_cop INTEGER NOT NULL DEFAULT 5000 CHECK(box_margin_cop BETWEEN 0 AND 1000000);
  ALTER TABLE products ADD COLUMN box_margin_cop_applied INTEGER;
  UPDATE products SET box_margin_cop_applied=5000 WHERE supplier_id IS NOT NULL;`,
  `CREATE TABLE image_brand_inspections (
    media_asset_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    candidates_json TEXT NOT NULL DEFAULT '[]',
    suggested_brand TEXT,
    score REAL NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 1),
    auto_eligible INTEGER NOT NULL DEFAULT 0 CHECK(auto_eligible IN (0,1)),
    reason TEXT NOT NULL,
    error TEXT,
    inspected_at TEXT NOT NULL
  );`,
  `CREATE TABLE product_image_analysis (
    product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
    error TEXT,
    updated_at TEXT NOT NULL
  );`,
  `DROP TABLE image_brand_inspections;
  DROP TABLE product_image_analysis;`,
  `CREATE TABLE image_marking_state (
    media_asset_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending','running','complete','failed')),
    regions_json TEXT NOT NULL DEFAULT '[]',
    manual_mode TEXT CHECK(manual_mode IN ('original','mark_all','mark_code','mark_world')),
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_image_marking_state_status ON image_marking_state(status,updated_at);`,
  `ALTER TABLE whatsapp_session_settings ADD COLUMN reception_start_time TEXT NOT NULL DEFAULT '09:00';
  ALTER TABLE whatsapp_session_settings ADD COLUMN reception_end_time TEXT NOT NULL DEFAULT '21:00';
  ALTER TABLE whatsapp_session_settings ADD COLUMN reception_timezone TEXT NOT NULL DEFAULT 'America/Bogota';
  ALTER TABLE whatsapp_source_messages RENAME TO whatsapp_source_messages_legacy;
  CREATE TABLE whatsapp_source_messages (
    session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    group_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    participant_jid TEXT NOT NULL DEFAULT '',
    product_id TEXT,
    received_at TEXT NOT NULL,
    PRIMARY KEY(session_id,group_jid,message_id)
  );
  INSERT INTO whatsapp_source_messages(session_id,group_jid,message_id,participant_jid,product_id,received_at)
    SELECT session_id,group_jid,message_id,participant_jid,product_id,received_at FROM whatsapp_source_messages_legacy;
  DROP TABLE whatsapp_source_messages_legacy;
  CREATE TABLE supplier_inbox_messages (
    session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    group_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    participant_jid TEXT NOT NULL DEFAULT '',
    message_timestamp_ms INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    image_file_name TEXT,
    image_mime_type TEXT,
    expected_album_images INTEGER,
    status TEXT NOT NULL CHECK(status IN ('pending','processing','processed','failed','ignored')),
    error TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    PRIMARY KEY(session_id,group_jid,message_id)
  );
  CREATE INDEX idx_supplier_inbox_pending ON supplier_inbox_messages(session_id,status,message_timestamp_ms);
  CREATE TABLE supplier_reception_state (
    session_id TEXT PRIMARY KEY REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    recovery_status TEXT NOT NULL DEFAULT 'idle' CHECK(recovery_status IN ('idle','waiting','received','unavailable')),
    recovery_started_at TEXT,
    recovery_finished_at TEXT,
    recovery_message_count INTEGER NOT NULL DEFAULT 0,
    recovery_warning TEXT,
    last_supplier_message_at TEXT,
    last_supplier_group_jid TEXT,
    last_supplier_result TEXT
  );
  INSERT INTO supplier_reception_state(session_id) SELECT id FROM whatsapp_sessions;
  CREATE TRIGGER whatsapp_session_reception_state AFTER INSERT ON whatsapp_sessions BEGIN
    INSERT OR IGNORE INTO supplier_reception_state(session_id) VALUES (NEW.id);
  END;`,
  `ALTER TABLE supplier_inbox_messages ADD COLUMN reception_mode TEXT NOT NULL DEFAULT 'recovery' CHECK(reception_mode IN ('live','recovery'));
  UPDATE whatsapp_session_settings SET reception_start_time='16:00',reception_end_time='19:00'
    WHERE reception_start_time='09:00' AND reception_end_time='21:00';
  CREATE TRIGGER whatsapp_recovery_schedule_defaults AFTER INSERT ON whatsapp_session_settings
    WHEN NEW.reception_start_time='09:00' AND NEW.reception_end_time='21:00' BEGIN
    UPDATE whatsapp_session_settings SET reception_start_time='16:00',reception_end_time='19:00' WHERE session_id=NEW.session_id;
  END;`,
  `CREATE TABLE whatsapp_history_anchors (
    session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    group_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_timestamp_ms INTEGER NOT NULL,
    from_me INTEGER NOT NULL DEFAULT 0 CHECK(from_me IN (0,1)),
    participant_jid TEXT,
    PRIMARY KEY(session_id,group_jid)
  );
  INSERT INTO whatsapp_history_anchors(session_id,group_jid,message_id,message_timestamp_ms,participant_jid)
    SELECT session_id,group_jid,message_id,message_timestamp_ms,participant_jid FROM (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY session_id,group_jid ORDER BY message_timestamp_ms DESC,message_id DESC) AS position
      FROM supplier_inbox_messages
    ) WHERE position=1;
  ALTER TABLE supplier_reception_state ADD COLUMN recovery_requested_groups INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE supplier_reception_state ADD COLUMN recovery_missing_anchors INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE supplier_reception_state ADD COLUMN recovery_failed_requests INTEGER NOT NULL DEFAULT 0;`,
];

export type AppDatabase = InstanceType<typeof Database>;

// Migration 9 was briefly applied before its final category mapping was added.
// Accept that exact published checksum so existing local databases can start safely.
const KNOWN_MIGRATION_CHECKSUMS: Readonly<Record<number, readonly string[]>> = {
  9: ['5d98f4041e780ec21ffefd5f24596f056e6228e355ee58688298e714d7bf0923'],
};

export function openDatabase(filePath: string, defaultMarginCop: 5000 | 10000 = 10000): AppDatabase {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);`);
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) as version FROM schema_migrations').get() as { version: number };
  if (current.version > MIGRATIONS.length) throw new Error('La base de datos fue creada por una versión más reciente.');
  const storedMigrations = db.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{ version: number; checksum: string }>;
  for (const migration of storedMigrations) {
    const expected = createHash('sha256').update(MIGRATIONS[migration.version - 1] ?? '').digest('hex');
    const knownHistoricalChecksum = KNOWN_MIGRATION_CHECKSUMS[migration.version]?.includes(migration.checksum) ?? false;
    if (migration.checksum !== expected && !knownHistoricalChecksum) throw new Error(`La migración ${migration.version} cambió después de aplicarse.`);
  }
  for (let i = current.version; i < MIGRATIONS.length; i += 1) {
    const version = i + 1;
    const checksum = createHash('sha256').update(MIGRATIONS[i]!).digest('hex');
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)').run(version, checksum, new Date().toISOString());
    })();
  }
  db.prepare(`INSERT OR IGNORE INTO settings(id, margin_cop, target_groups, updated_at) VALUES (1, ?, '[]', ?)`).run(defaultMarginCop, new Date().toISOString());
  return db;
}
