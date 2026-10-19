//! Custom Tauri commands backing the desktop bridge used by the Expo web
//! export running inside the WebView (see the TS side in
//! `apps/mobile/platform/desktop/`):
//!
//! - SQLite: one shared `rusqlite` connection at `app_data_dir()/locallab.sqlite`,
//!   held in managed `State<Mutex<Connection>>`; the JS `sharedMobileDatabase`
//!   port queue serializes access, so a single mutex suffices.
//! - Secrets: OS keyring under the fixed service
//!   `com.locallab.provider-secrets` (mirrors apps/companion/src/secrets.rs:4;
//!   the per-OS keyring features in Cargo.toml mirror apps/companion/Cargo.toml).
//! - Files: native save dialog (`rfd`) for archive exports.
//!
//! Every command returns `Result<T, String>`; the error string surfaces to the
//! JS `invoke` rejection. Wire shapes match the contract in
//! `local://desktop-bridge-contract.md` / plans §Desktop.

use base64::Engine as _;
use rusqlite::types::ValueRef;
use rusqlite::{params_from_iter, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

/// Keyring service constant, shared with the companion process
/// (apps/companion/src/secrets.rs:4). There is deliberately no service
/// parameter on the commands — accounts are opaque IDs chosen by JS.
const SERVICE: &str = "com.locallab.provider-secrets";

/// A bound SQLite parameter as sent by the JS adapter.
///
/// Untagged so JSON maps directly: `null`, booleans (bound as 0/1), integers,
/// reals, strings, and `{"type":"blob","base64":"..."}` for `Uint8Array`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DbValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Blob { r#type: String, base64: String },
}

/// Result of `db_run`, serialized camelCase for the expo-sqlite-style port.
#[derive(Debug, Clone, Serialize)]
pub struct DbRunResult {
    #[serde(rename = "lastInsertRowId")]
    pub last_insert_row_id: u64,
    pub changes: u64,
}

fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|err| format!("invalid base64 blob parameter: {err}"))
}

/// SQLite blob column → `{"type":"blob","base64":...}` (JS revives to Uint8Array).
fn blob_json(bytes: &[u8]) -> Value {
    let mut map = Map::new();
    map.insert("type".to_string(), Value::String("blob".to_string()));
    map.insert(
        "base64".to_string(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
    );
    Value::Object(map)
}

fn value_ref_to_json(value: ValueRef<'_>) -> Result<Value, String> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(f.to_string())),
        // TEXT columns are validated UTF-8 by SQLite, but lossy decoding avoids
        // an error path on exotic data instead of failing the whole query.
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => blob_json(b),
    })
}

/// JS bind value → owned SQLite value (bools become 0/1 integers).
fn to_sql_value(value: &DbValue) -> Result<rusqlite::types::Value, String> {
    Ok(match value {
        DbValue::Null => rusqlite::types::Value::Null,
        DbValue::Bool(b) => rusqlite::types::Value::Integer(i64::from(u8::from(*b))),
        DbValue::Int(i) => rusqlite::types::Value::Integer(*i),
        DbValue::Float(f) => rusqlite::types::Value::Real(*f),
        DbValue::Text(s) => rusqlite::types::Value::Text(s.clone()),
        DbValue::Blob { base64, .. } => rusqlite::types::Value::Blob(decode_base64(base64)?),
    })
}

fn build_bindings(params: &[DbValue]) -> Result<Vec<rusqlite::types::Value>, String> {
    params.iter().map(to_sql_value).collect()
}

fn row_to_map(row: &Row<'_>, columns: &[String]) -> Result<Map<String, Value>, String> {
    let mut map = Map::with_capacity(columns.len());
    for (index, name) in columns.iter().enumerate() {
        let value = row
            .get_ref(index)
            .map_err(|err| format!("failed to read column {name}: {err}"))?;
        map.insert(name.clone(), value_ref_to_json(value)?);
    }
    Ok(map)
}

fn query_rows(
    conn: &Connection,
    sql: &str,
    bindings: &[rusqlite::types::Value],
) -> Result<Vec<Map<String, Value>>, String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| format!("prepare failed: {err}"))?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt
        .query(params_from_iter(bindings))
        .map_err(|err| format!("query failed: {err}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|err| format!("row read failed: {err}"))? {
        out.push(row_to_map(row, &columns)?);
    }
    Ok(out)
}

/// Open the shared database file with the contract pragmas (WAL, FKs, busy
/// timeout). Parent directories are created on demand.
pub fn open_connection(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create app data dir {}: {err}", parent.display()))?;
    }
    let conn =
        Connection::open(path).map_err(|err| format!("failed to open db {}: {err}", path.display()))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000;")
        .map_err(|err| format!("failed to apply pragmas: {err}"))?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Idempotent: the connection is opened once during app setup and cached in
/// managed state; this exists so the JS port has an explicit open step and
/// re-applies the pragmas defensively.
#[tauri::command]
pub fn db_open(state: tauri::State<'_, std::sync::Mutex<Connection>>) -> Result<String, String> {
    let conn = state
        .lock()
        .map_err(|_| "database state poisoned".to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000;")
        .map_err(|err| format!("failed to apply pragmas: {err}"))?;
    Ok("ok".to_string())
}

/// Run one or more statements (schema batches from the JS migration runner).
#[tauri::command]
pub fn db_exec(
    sql: String,
    state: tauri::State<'_, std::sync::Mutex<Connection>>,
) -> Result<(), String> {
    let conn = state
        .lock()
        .map_err(|_| "database state poisoned".to_string())?;
    conn.execute_batch(&sql)
        .map_err(|err| format!("exec failed: {err}"))
}

/// Run one statement with bind params; report `lastInsertRowId` + `changes`.
#[tauri::command]
pub fn db_run(
    sql: String,
    params: Vec<DbValue>,
    state: tauri::State<'_, std::sync::Mutex<Connection>>,
) -> Result<DbRunResult, String> {
    let bindings = build_bindings(&params)?;
    let conn = state
        .lock()
        .map_err(|_| "database state poisoned".to_string())?;
    let changes = conn
        .execute(&sql, params_from_iter(&bindings))
        .map_err(|err| format!("run failed: {err}"))?;
    Ok(DbRunResult {
        last_insert_row_id: conn.last_insert_rowid() as u64,
        changes: changes as u64,
    })
}

/// Select all rows as JSON objects (blob columns as {"type":"blob","base64":...}).
#[tauri::command]
pub fn db_all(
    sql: String,
    params: Vec<DbValue>,
    state: tauri::State<'_, std::sync::Mutex<Connection>>,
) -> Result<Vec<Map<String, Value>>, String> {
    let bindings = build_bindings(&params)?;
    let conn = state
        .lock()
        .map_err(|_| "database state poisoned".to_string())?;
    query_rows(&conn, &sql, &bindings)
}

/// Select the first row, or `null` if none.
#[tauri::command]
pub fn db_get(
    sql: String,
    params: Vec<DbValue>,
    state: tauri::State<'_, std::sync::Mutex<Connection>>,
) -> Result<Option<Map<String, Value>>, String> {
    let bindings = build_bindings(&params)?;
    let conn = state
        .lock()
        .map_err(|_| "database state poisoned".to_string())?;
    Ok(query_rows(&conn, &sql, &bindings)?.into_iter().next())
}

#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|err| err.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    keyring::Entry::new(SERVICE, &account)
        .map_err(|err| err.to_string())?
        .set_password(&value)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    match keyring::Entry::new(SERVICE, &account)
        .map_err(|err| err.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// Show a native save dialog pre-filled with `name` (sanitization already
/// enforced by the JS callers), then write the decoded bytes. `None` means the
/// user canceled.
#[tauri::command]
pub fn files_save(
    name: String,
    base64_data: String,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    let bytes = decode_base64(&base64_data)?;
    let mut dialog = rfd::FileDialog::new().set_file_name(&name);
    if let Some(dir) = default_dir.as_deref() {
        dialog = dialog.set_directory(dir);
    }
    let Some(path) = dialog.save_file() else {
        return Ok(None);
    };
    std::fs::write(&path, bytes)
        .map_err(|err| format!("failed to write {}: {err}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn temp_db_path(label: &str) -> std::path::PathBuf {
        let unique = format!(
            "locallab-desktop-test-{}-{}",
            label.replace(['(', ')', ' '], "_"),
            std::process::id()
        );
        std::env::temp_dir().join(unique).join("locallab.sqlite")
    }

    #[test]
    fn db_roundtrip_in_temp_dir_db() {
        let path = temp_db_path("roundtrip");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        let conn = open_connection(&path).expect("open temp db");

        // Pragmas per contract.
        let journal: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
        let busy: i64 = conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!(busy, 15000);

        // exec: multi-statement batch.
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, flag INTEGER, data BLOB);",
        )
        .unwrap();

        // run with mixed bind params, including a blob.
        let blob = vec![0u8, 1, 2, 250, 255];
        let bindings = build_bindings(&[
            DbValue::Text("hello".into()),
            DbValue::Float(1.5),
            DbValue::Bool(true),
            DbValue::Blob {
                r#type: "blob".into(),
                base64: base64::engine::general_purpose::STANDARD.encode(&blob),
            },
        ])
        .unwrap();
        let changes = conn
            .execute(
                "INSERT INTO t (name, score, flag, data) VALUES (?, ?, ?, ?)",
                params_from_iter(&bindings),
            )
            .unwrap();
        assert_eq!(changes, 1);
        let row_id = conn.last_insert_rowid() as u64;
        assert!(row_id >= 1);

        // all: value mapping per contract.
        let rows = query_rows(
            &conn,
            "SELECT id, name, score, flag, data FROM t WHERE id = ?",
            &build_bindings(&[DbValue::Int(row_id as i64)]).unwrap(),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row["id"], Value::Number(row_id.into()));
        assert_eq!(row["name"], Value::String("hello".into()));
        assert_eq!(
            row["score"],
            serde_json::Number::from_f64(1.5).map(Value::Number).unwrap()
        );
        assert_eq!(row["flag"], Value::Number(1.into()));
        assert_eq!(row["data"], blob_json(&blob));

        // blob parameter roundtrip survives base64 encode/decode.
        let fetched = row["data"].as_object().unwrap();
        assert_eq!(fetched["type"], Value::String("blob".into()));
        assert_eq!(decode_base64(fetched["base64"].as_str().unwrap()).unwrap(), blob);

        // get: first row or None.
        let mut one = query_rows(
            &conn,
            "SELECT name FROM t WHERE name = ?",
            &build_bindings(&[DbValue::Text("hello".into())]).unwrap(),
        )
        .unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one.remove(0)["name"], Value::String("hello".into()));
        assert!(query_rows(
            &conn,
            "SELECT name FROM t WHERE name = ?",
            &build_bindings(&[DbValue::Text("missing".into())]).unwrap(),
        )
        .unwrap()
        .is_empty());

        // NULL maps to JSON null.
        conn.execute("INSERT INTO t (name) VALUES (NULL)", []).unwrap();
        let null_row = query_rows(&conn, "SELECT name FROM t WHERE id = ?", &build_bindings(&[DbValue::Int(conn.last_insert_rowid())]).unwrap()).unwrap();
        assert_eq!(null_row[0]["name"], Value::Null);

        // Idempotent reopen (db_open caches; a second open on the same file sees
        // the data and re-applies pragmas).
        let conn2 = open_connection(&path).expect("reopen");
        let count: i64 = conn2
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        drop(conn);
        drop(conn2);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn transaction_via_exec_batch() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "BEGIN IMMEDIATE; CREATE TABLE tx (v TEXT); INSERT INTO tx VALUES ('a'); COMMIT;",
        )
        .unwrap();
        let rows = query_rows(&conn, "SELECT v FROM tx", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["v"], Value::String("a".into()));
    }

    #[test]
    fn db_value_json_wire_shapes() {
        // Deserialize exactly the shapes the JS adapter produces.
        let vals: Vec<DbValue> = serde_json::from_str(
            r#"[null, true, 1, -2, 1.5, "s", {"type":"blob","base64":"AAEC/8I="}]"#,
        )
        .unwrap();
        assert_eq!(vals[0], DbValue::Null);
        assert_eq!(vals[1], DbValue::Bool(true));
        assert_eq!(vals[2], DbValue::Int(1));
        assert_eq!(vals[3], DbValue::Int(-2));
        assert_eq!(vals[4], DbValue::Float(1.5));
        assert_eq!(vals[5], DbValue::Text("s".into()));
        let DbValue::Blob { r#type, base64 } = &vals[6] else {
            panic!("expected blob variant, got {:?}", &vals[6]);
        };
        assert_eq!(r#type, "blob");
        assert_eq!(decode_base64(base64).unwrap(), vec![0, 1, 2, 0xff, 0xc2]);

        // bool binds as 0/1, per contract.
        let bindings = build_bindings(&[DbValue::Bool(false), DbValue::Bool(true)]).unwrap();
        assert_eq!(bindings[0], rusqlite::types::Value::Integer(0));
        assert_eq!(bindings[1], rusqlite::types::Value::Integer(1));
    }

    #[test]
    fn db_run_result_serializes_camel_case() {
        let json = serde_json::to_value(DbRunResult {
            last_insert_row_id: 7,
            changes: 3,
        })
        .unwrap();
        assert_eq!(json["lastInsertRowId"], 7);
        assert_eq!(json["changes"], 3);
    }

    #[test]
    fn invalid_base64_is_an_error_string() {
        assert!(build_bindings(&[DbValue::Blob {
            r#type: "blob".into(),
            base64: "!!!not base64!!!".into(),
        }])
        .is_err());
    }

    #[test]
    fn poison_guard_shape_of_managed_state() {
        // lib.rs manages exactly this type; keep the command signature honest.
        let _state: Mutex<Connection> = Mutex::new(Connection::open_in_memory().unwrap());
    }

    /// Keyring roundtrip against the real Windows credential manager. Marked
    /// `#[ignore]` because headless/CI sessions may not have keyring access;
    /// run locally with `cargo test -- --ignored keyring`.
    #[test]
    #[ignore = "requires an interactive OS keyring session"]
    fn keyring_roundtrip() {
        let account = format!("locallab-desktop-test-{}", std::process::id());
        assert_eq!(secret_get(account.clone()).unwrap(), None);
        secret_set(account.clone(), "hunter2".into()).unwrap();
        assert_eq!(secret_get(account.clone()).unwrap().as_deref(), Some("hunter2"));
        secret_set(account.clone(), "hunter3".into()).unwrap();
        assert_eq!(secret_get(account.clone()).unwrap().as_deref(), Some("hunter3"));
        secret_delete(account.clone()).unwrap();
        secret_delete(account.clone()).unwrap(); // delete of missing entry is ok
        assert_eq!(secret_get(account).unwrap(), None);
    }
}
