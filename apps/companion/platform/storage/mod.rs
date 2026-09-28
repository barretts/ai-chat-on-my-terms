//! Local SQLite persistence for the desktop companion.
//!
//! The database is private to the companion process and is never exposed to the
//! relay. SQLite is linked from the host OS (SQLite ships with macOS).
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::Path,
};

#[link(name = "sqlite3")]
unsafe extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        db: *mut *mut Sqlite,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(db: *mut Sqlite) -> c_int;
    fn sqlite3_errmsg(db: *mut Sqlite) -> *const c_char;
    fn sqlite3_exec(
        db: *mut Sqlite,
        sql: *const c_char,
        callback: Option<
            unsafe extern "C" fn(*mut c_void, c_int, *mut *mut c_char, *mut *mut c_char) -> c_int,
        >,
        arg: *mut c_void,
        error: *mut *mut c_char,
    ) -> c_int;
    fn sqlite3_free(p: *mut c_void);
    fn sqlite3_prepare_v2(
        db: *mut Sqlite,
        sql: *const c_char,
        n: c_int,
        stmt: *mut *mut Statement,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_bind_text(
        stmt: *mut Statement,
        index: c_int,
        text: *const c_char,
        n: c_int,
        destructor: Option<unsafe extern "C" fn(*mut c_void)>,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut Statement) -> c_int;
    fn sqlite3_column_text(stmt: *mut Statement, index: c_int) -> *const u8;
    fn sqlite3_finalize(stmt: *mut Statement) -> c_int;
}
#[repr(C)]
struct Sqlite {
    _opaque: [u8; 0],
}
#[repr(C)]
struct Statement {
    _opaque: [u8; 0],
}
const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_OPEN_READWRITE: c_int = 0x2;
const SQLITE_OPEN_CREATE: c_int = 0x4;
const SQLITE_OPEN_FULLMUTEX: c_int = 0x10000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageError(pub String);
impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for StorageError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    pub wall_ms: u64,
    pub counter: u64,
    pub device_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityMeta {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: Revision,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chat {
    pub meta: EntityMeta,
    pub kind: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub binding_id: Option<String>,
    pub overrides_json: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    pub meta: EntityMeta,
    pub name: String,
    pub parent_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Persona {
    pub meta: EntityMeta,
    pub name: String,
    pub profile_json: String,
    pub photo_attachment_id: Option<String>,
    pub model_id: Option<String>,
    pub parameter_preset_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncState {
    pub peer_device_id: String,
    pub cursor: u64,
    pub updated_at: String,
}

/// A single-process connection. The FULLMUTEX SQLite mode also protects callers
/// that share this handle across threads. All entity writes use transactions.
pub struct CompanionStorage {
    db: *mut Sqlite,
}
unsafe impl Send for CompanionStorage {}
unsafe impl Sync for CompanionStorage {}
impl Drop for CompanionStorage {
    fn drop(&mut self) {
        unsafe {
            sqlite3_close(self.db);
        }
    }
}

impl CompanionStorage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path
            .as_ref()
            .to_str()
            .ok_or_else(|| StorageError("database path is not valid UTF-8".into()))?;
        let path = cstring(path)?;
        let mut db = std::ptr::null_mut();
        let rc = unsafe {
            sqlite3_open_v2(
                path.as_ptr(),
                &mut db,
                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                std::ptr::null(),
            )
        };
        if rc != SQLITE_OK {
            return Err(error(db, "open database"));
        }
        let store = Self { db };
        store.exec(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
        )?;
        store.migrate()?;
        Ok(store)
    }
    fn migrate(&self) -> Result<(), StorageError> {
        self.exec("BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
          CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('chat','group','arena')), title TEXT NOT NULL, folder_id TEXT, binding_id TEXT, overrides_json TEXT NOT NULL CHECK(json_valid(overrides_json)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision_wall_ms INTEGER NOT NULL CHECK(revision_wall_ms>=0), revision_counter INTEGER NOT NULL CHECK(revision_counter>=0), revision_device_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision_wall_ms INTEGER NOT NULL CHECK(revision_wall_ms>=0), revision_counter INTEGER NOT NULL CHECK(revision_counter>=0), revision_device_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS personas(id TEXT PRIMARY KEY, name TEXT NOT NULL, profile_json TEXT NOT NULL CHECK(json_valid(profile_json)), photo_attachment_id TEXT, model_id TEXT, parameter_preset_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision_wall_ms INTEGER NOT NULL CHECK(revision_wall_ms>=0), revision_counter INTEGER NOT NULL CHECK(revision_counter>=0), revision_device_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sync_state(peer_device_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL CHECK(cursor>=0), updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sync_tombstones(entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, revision_wall_ms INTEGER NOT NULL CHECK(revision_wall_ms>=0), revision_counter INTEGER NOT NULL CHECK(revision_counter>=0), revision_device_id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id));
          CREATE TABLE IF NOT EXISTS sync_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('upsert','tombstone')), revision_wall_ms INTEGER NOT NULL, revision_counter INTEGER NOT NULL, revision_device_id TEXT NOT NULL, created_at TEXT NOT NULL);
          INSERT OR IGNORE INTO schema_migrations(version,name) VALUES(1,'0001-local-entities');
          INSERT OR IGNORE INTO schema_migrations(version,name) VALUES(2,'0002-sync-state');
          COMMIT;")
    }
    fn exec(&self, sql: &str) -> Result<(), StorageError> {
        let sql = cstring(sql)?;
        let mut msg = std::ptr::null_mut();
        let rc =
            unsafe { sqlite3_exec(self.db, sql.as_ptr(), None, std::ptr::null_mut(), &mut msg) };
        if rc == SQLITE_OK {
            Ok(())
        } else {
            let detail = if msg.is_null() {
                self.message()
            } else {
                let s = unsafe { CStr::from_ptr(msg) }
                    .to_string_lossy()
                    .into_owned();
                unsafe {
                    sqlite3_free(msg.cast());
                }
                s
            };
            Err(StorageError(detail))
        }
    }
    fn message(&self) -> String {
        unsafe { CStr::from_ptr(sqlite3_errmsg(self.db)) }
            .to_string_lossy()
            .into_owned()
    }
    fn execute(&self, sql: &str, values: &[&str]) -> Result<(), StorageError> {
        let stmt = self.prepare(sql, values)?;
        let rc = unsafe { sqlite3_step(stmt) };
        unsafe {
            sqlite3_finalize(stmt);
        }
        if rc == SQLITE_DONE {
            Ok(())
        } else {
            Err(StorageError(self.message()))
        }
    }
    fn query_first(
        &self,
        sql: &str,
        values: &[&str],
        columns: usize,
    ) -> Result<Option<Vec<Option<String>>>, StorageError> {
        let stmt = self.prepare(sql, values)?;
        let rc = unsafe { sqlite3_step(stmt) };
        let result = if rc == SQLITE_ROW {
            let mut row = Vec::with_capacity(columns);
            for i in 0..columns {
                let p = unsafe { sqlite3_column_text(stmt, i as c_int) };
                row.push(if p.is_null() {
                    None
                } else {
                    Some(
                        unsafe { CStr::from_ptr(p.cast()) }
                            .to_string_lossy()
                            .into_owned(),
                    )
                });
            }
            Ok(Some(row))
        } else if rc == SQLITE_DONE {
            Ok(None)
        } else {
            Err(StorageError(self.message()))
        };
        unsafe {
            sqlite3_finalize(stmt);
        }
        result
    }
    fn prepare(&self, sql: &str, values: &[&str]) -> Result<*mut Statement, StorageError> {
        let sql = cstring(sql)?;
        let mut stmt = std::ptr::null_mut();
        let rc = unsafe {
            sqlite3_prepare_v2(self.db, sql.as_ptr(), -1, &mut stmt, std::ptr::null_mut())
        };
        if rc != SQLITE_OK {
            return Err(StorageError(self.message()));
        }
        for (i, value) in values.iter().enumerate() {
            let value = cstring(value)?;
            let rc = unsafe {
                sqlite3_bind_text(
                    stmt,
                    (i + 1) as c_int,
                    value.as_ptr(),
                    -1,
                    Some(std::mem::transmute::<
                        isize,
                        unsafe extern "C" fn(*mut c_void),
                    >(-1)),
                )
            };
            if rc != SQLITE_OK {
                unsafe {
                    sqlite3_finalize(stmt);
                }
                return Err(StorageError(self.message()));
            }
        }
        Ok(stmt)
    }
    pub fn upsert_chat(&self, chat: &Chat) -> Result<(), StorageError> {
        self.transaction(|| {
            if self.has_newer_revision("chats", &chat.meta)? {
                return Ok(());
            }
            self.execute("INSERT INTO chats(id,kind,title,folder_id,binding_id,overrides_json,created_at,updated_at,revision_wall_ms,revision_counter,revision_device_id) VALUES(?,?,?,NULLIF(?,''),NULLIF(?,''),?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,folder_id=excluded.folder_id,binding_id=excluded.binding_id,overrides_json=excluded.overrides_json,updated_at=excluded.updated_at,revision_wall_ms=excluded.revision_wall_ms,revision_counter=excluded.revision_counter,revision_device_id=excluded.revision_device_id WHERE (excluded.revision_wall_ms,excluded.revision_counter,excluded.revision_device_id)>(chats.revision_wall_ms,chats.revision_counter,chats.revision_device_id)", &[&chat.meta.id,&chat.kind,&chat.title,chat.folder_id.as_deref().unwrap_or(""),chat.binding_id.as_deref().unwrap_or(""),&chat.overrides_json,&chat.meta.created_at,&chat.meta.updated_at,&chat.meta.revision.wall_ms.to_string(),&chat.meta.revision.counter.to_string(),&chat.meta.revision.device_id])?;
            self.outbox("chat",&chat.meta)
        })
    }
    pub fn upsert_folder(&self, folder: &Folder) -> Result<(), StorageError> {
        self.transaction(|| {
            if self.has_newer_revision("folders", &folder.meta)? { return Ok(()); }
            self.execute("INSERT INTO folders VALUES(?,?,NULLIF(?,''),?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,updated_at=excluded.updated_at,revision_wall_ms=excluded.revision_wall_ms,revision_counter=excluded.revision_counter,revision_device_id=excluded.revision_device_id WHERE (excluded.revision_wall_ms,excluded.revision_counter,excluded.revision_device_id)>(folders.revision_wall_ms,folders.revision_counter,folders.revision_device_id)",&[&folder.meta.id,&folder.name,folder.parent_id.as_deref().unwrap_or(""),&folder.meta.created_at,&folder.meta.updated_at,&folder.meta.revision.wall_ms.to_string(),&folder.meta.revision.counter.to_string(),&folder.meta.revision.device_id])?;
            self.outbox("folder",&folder.meta)
        })
    }
    pub fn upsert_persona(&self, persona: &Persona) -> Result<(), StorageError> {
        self.transaction(|| {
            if self.has_newer_revision("personas", &persona.meta)? { return Ok(()); }
            self.execute("INSERT INTO personas VALUES(?,?,?,NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,profile_json=excluded.profile_json,photo_attachment_id=excluded.photo_attachment_id,model_id=excluded.model_id,parameter_preset_id=excluded.parameter_preset_id,updated_at=excluded.updated_at,revision_wall_ms=excluded.revision_wall_ms,revision_counter=excluded.revision_counter,revision_device_id=excluded.revision_device_id WHERE (excluded.revision_wall_ms,excluded.revision_counter,excluded.revision_device_id)>(personas.revision_wall_ms,personas.revision_counter,personas.revision_device_id)",&[&persona.meta.id,&persona.name,&persona.profile_json,persona.photo_attachment_id.as_deref().unwrap_or(""),persona.model_id.as_deref().unwrap_or(""),persona.parameter_preset_id.as_deref().unwrap_or(""),&persona.meta.created_at,&persona.meta.updated_at,&persona.meta.revision.wall_ms.to_string(),&persona.meta.revision.counter.to_string(),&persona.meta.revision.device_id])?;
            self.outbox("persona",&persona.meta)
        })
    }
    pub fn get_chat(&self, id: &str) -> Result<Option<Chat>, StorageError> {
        let r = self.query_first("SELECT id,kind,title,folder_id,binding_id,overrides_json,created_at,updated_at,revision_wall_ms,revision_counter,revision_device_id FROM chats WHERE id=?", &[id],11)?;
        Ok(r.map(|r| Chat {
            meta: meta(&r, 0, 6, 7, 8, 9, 10),
            kind: r[1].clone().unwrap(),
            title: r[2].clone().unwrap(),
            folder_id: nonempty(&r[3]),
            binding_id: nonempty(&r[4]),
            overrides_json: r[5].clone().unwrap(),
        }))
    }
    pub fn get_folder(&self, id: &str) -> Result<Option<Folder>, StorageError> {
        let r = self.query_first("SELECT id,name,parent_id,created_at,updated_at,revision_wall_ms,revision_counter,revision_device_id FROM folders WHERE id=?", &[id],8)?;
        Ok(r.map(|r| Folder {
            meta: meta(&r, 0, 3, 4, 5, 6, 7),
            name: r[1].clone().unwrap(),
            parent_id: nonempty(&r[2]),
        }))
    }
    pub fn get_persona(&self, id: &str) -> Result<Option<Persona>, StorageError> {
        let r = self.query_first(
            "SELECT id,name,profile_json,photo_attachment_id,model_id,parameter_preset_id,created_at,updated_at,revision_wall_ms,revision_counter,revision_device_id FROM personas WHERE id=?",
            &[id],
            11,
        )?;
        Ok(r.map(|r| Persona {
            meta: meta(&r, 0, 6, 7, 8, 9, 10),
            name: r[1].clone().unwrap(),
            profile_json: r[2].clone().unwrap(),
            photo_attachment_id: nonempty(&r[3]),
            model_id: nonempty(&r[4]),
            parameter_preset_id: nonempty(&r[5]),
        }))
    }
    pub fn set_sync_cursor(
        &self,
        peer: &str,
        cursor: u64,
        updated_at: &str,
    ) -> Result<(), StorageError> {
        self.execute("INSERT INTO sync_state(peer_device_id,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(peer_device_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at WHERE excluded.cursor>=sync_state.cursor", &[peer,&cursor.to_string(),updated_at])
    }
    pub fn get_sync_cursor(&self, peer: &str) -> Result<Option<SyncState>, StorageError> {
        let r = self.query_first(
            "SELECT peer_device_id,cursor,updated_at FROM sync_state WHERE peer_device_id=?",
            &[peer],
            3,
        )?;
        Ok(r.map(|r| SyncState {
            peer_device_id: r[0].clone().unwrap(),
            cursor: r[1].as_deref().unwrap().parse().unwrap_or(0),
            updated_at: r[2].clone().unwrap(),
        }))
    }
    fn has_newer_revision(&self, table: &str, meta: &EntityMeta) -> Result<bool, StorageError> {
        let sql = format!(
            "SELECT revision_wall_ms, revision_counter, revision_device_id FROM {table} WHERE id=?"
        );
        let Some(row) = self.query_first(&sql, &[&meta.id], 3)? else {
            return Ok(false);
        };
        let existing = Revision {
            wall_ms: row[0].as_deref().unwrap().parse().unwrap_or(0),
            counter: row[1].as_deref().unwrap().parse().unwrap_or(0),
            device_id: row[2].clone().unwrap(),
        };
        Ok(compare_revision(&existing, &meta.revision) != std::cmp::Ordering::Less)
    }
    fn outbox(&self, kind: &str, meta: &EntityMeta) -> Result<(), StorageError> {
        self.execute("INSERT INTO sync_outbox(entity_type,entity_id,operation,revision_wall_ms,revision_counter,revision_device_id,created_at) VALUES(?,?,'upsert',?,?,?,?)", &[kind,&meta.id,&meta.revision.wall_ms.to_string(),&meta.revision.counter.to_string(),&meta.revision.device_id,&meta.updated_at])
    }
    fn transaction<T>(
        &self,
        f: impl FnOnce() -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        self.exec("BEGIN IMMEDIATE")?;
        match f() {
            Ok(value) => match self.exec("COMMIT") {
                Ok(()) => Ok(value),
                Err(e) => {
                    let _ = self.exec("ROLLBACK");
                    Err(e)
                }
            },
            Err(e) => {
                let _ = self.exec("ROLLBACK");
                Err(e)
            }
        }
    }
}
fn meta(
    r: &[Option<String>],
    id: usize,
    created: usize,
    updated: usize,
    wall: usize,
    counter: usize,
    device: usize,
) -> EntityMeta {
    EntityMeta {
        id: r[id].clone().unwrap(),
        created_at: r[created].clone().unwrap(),
        updated_at: r[updated].clone().unwrap(),
        revision: Revision {
            wall_ms: r[wall].as_deref().unwrap().parse().unwrap_or(0),
            counter: r[counter].as_deref().unwrap().parse().unwrap_or(0),
            device_id: r[device].clone().unwrap(),
        },
    }
}
fn compare_revision(a: &Revision, b: &Revision) -> std::cmp::Ordering {
    (a.wall_ms, a.counter, &a.device_id).cmp(&(b.wall_ms, b.counter, &b.device_id))
}
fn nonempty(v: &Option<String>) -> Option<String> {
    v.as_ref().filter(|v| !v.is_empty()).cloned()
}
fn cstring(value: &str) -> Result<CString, StorageError> {
    CString::new(value).map_err(|_| StorageError("SQLite value contains NUL".into()))
}
fn error(db: *mut Sqlite, context: &str) -> StorageError {
    let detail = if db.is_null() {
        "unknown SQLite error".into()
    } else {
        unsafe { CStr::from_ptr(sqlite3_errmsg(db)) }
            .to_string_lossy()
            .into_owned()
    };
    StorageError(format!("{context}: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn database() -> String {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("locallab-companion-{nonce}.sqlite"))
            .to_string_lossy()
            .into_owned()
    }
    fn meta(id: &str) -> EntityMeta {
        EntityMeta {
            id: id.into(),
            created_at: "2026-09-26T12:00:00Z".into(),
            updated_at: "2026-09-26T12:00:00Z".into(),
            revision: Revision {
                wall_ms: 100,
                counter: 0,
                device_id: "0190abcd-1234-7000-8000-000000000001".into(),
            },
        }
    }
    #[test]
    fn chat_folder_and_sync_cursor_survive_restart_and_migration_is_idempotent() {
        let path = database();
        {
            let db = CompanionStorage::open(&path).unwrap();
            db.upsert_folder(&Folder {
                meta: meta("0190abcd-1234-7000-8000-000000000002"),
                name: "Inbox".into(),
                parent_id: None,
            })
            .unwrap();
            db.upsert_chat(&Chat {
                meta: meta("0190abcd-1234-7000-8000-000000000003"),
                kind: "chat".into(),
                title: "Local history".into(),
                folder_id: None,
                binding_id: None,
                overrides_json: "{}".into(),
            })
            .unwrap();
            db.upsert_persona(&Persona {
                meta: meta("0190abcd-1234-7000-8000-000000000004"),
                name: "Local persona".into(),
                profile_json: "{\"bio\":\"saved locally\"}".into(),
                photo_attachment_id: None,
                model_id: None,
                parameter_preset_id: None,
            })
            .unwrap();
            db.set_sync_cursor(
                "0190abcd-1234-7000-8000-000000000001",
                4,
                "2026-09-26T12:00:00Z",
            )
            .unwrap();
        }
        {
            let db = CompanionStorage::open(&path).unwrap();
            assert_eq!(
                db.get_chat("0190abcd-1234-7000-8000-000000000003")
                    .unwrap()
                    .unwrap()
                    .title,
                "Local history"
            );
            assert_eq!(
                db.get_folder("0190abcd-1234-7000-8000-000000000002")
                    .unwrap()
                    .unwrap()
                    .name,
                "Inbox"
            );
            assert_eq!(
                db.get_persona("0190abcd-1234-7000-8000-000000000004")
                    .unwrap()
                    .unwrap()
                    .name,
                "Local persona"
            );
            assert_eq!(
                db.get_sync_cursor("0190abcd-1234-7000-8000-000000000001")
                    .unwrap()
                    .unwrap()
                    .cursor,
                4
            );
        }
        let _ = fs::remove_file(path);
    }
    #[test]
    fn invalid_entity_rolls_back_and_stale_revision_does_not_overwrite_or_enqueue() {
        let path = database();
        let db = CompanionStorage::open(&path).unwrap();
        let id = "0190abcd-1234-7000-8000-000000000003";
        let invalid = Chat {
            meta: meta(id),
            kind: "chat".into(),
            title: "invalid".into(),
            folder_id: None,
            binding_id: None,
            overrides_json: "not-json".into(),
        };
        assert!(db.upsert_chat(&invalid).is_err());
        assert!(db.get_chat(id).unwrap().is_none());
        let good = Chat {
            overrides_json: "{}".into(),
            title: "new".into(),
            ..invalid
        };
        db.upsert_chat(&good).unwrap();
        let stale = Chat {
            title: "stale".into(),
            meta: EntityMeta {
                updated_at: "2026-09-26T11:00:00Z".into(),
                revision: Revision {
                    wall_ms: 99,
                    counter: 0,
                    device_id: good.meta.revision.device_id.clone(),
                },
                ..good.meta.clone()
            },
            ..good.clone()
        };
        db.upsert_chat(&stale).unwrap();
        assert_eq!(db.get_chat(id).unwrap().unwrap().title, "new");
        let count = db
            .query_first("SELECT count(*) FROM sync_outbox", &[], 1)
            .unwrap()
            .unwrap()[0]
            .as_deref()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert_eq!(count, 1);
        let _ = fs::remove_file(path);
    }
}
