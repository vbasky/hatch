use rusqlite::{params_from_iter, Connection, ToSql};
use serde_json::{json, Map, Number, Value};
use std::path::Path;
use std::sync::Mutex;

pub struct HostDb {
  conn: Mutex<Connection>,
}

impl HostDb {
  pub fn open(path: &Path) -> Result<Self, String> {
    let conn = if path.as_os_str() == ":memory:" {
      Connection::open_in_memory().map_err(|e| e.to_string())?
    } else {
      Connection::open(path).map_err(|e| e.to_string())?
    };
    conn
      .pragma_update(None, "journal_mode", "WAL")
      .map_err(|e| e.to_string())?;
    conn
      .pragma_update(None, "busy_timeout", 5000)
      .map_err(|e| e.to_string())?;
    Ok(Self {
      conn: Mutex::new(conn),
    })
  }

  pub fn query(&self, sql: &str, params: Option<&Value>) -> Result<Value, String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
    let bound = bind(params);
    let refs: Vec<&dyn ToSql> = bound.iter().map(|value| value as &dyn ToSql).collect();
    let mut rows = stmt.query(params_from_iter(refs)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
      let mut object = Map::new();
      for (index, name) in names.iter().enumerate() {
        object.insert(name.clone(), sql_to_json(row.get_ref(index).map_err(|e| e.to_string())?));
      }
      out.push(Value::Object(object));
    }
    Ok(Value::Array(out))
  }

  pub fn get(&self, sql: &str, params: Option<&Value>) -> Result<Value, String> {
    match self.query(sql, params)? {
      Value::Array(mut rows) => Ok(rows.pop().unwrap_or(Value::Null)),
      other => Ok(other),
    }
  }

  pub fn run(&self, sql: &str, params: Option<&Value>) -> Result<Value, String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    let bound = bind(params);
    let refs: Vec<&dyn ToSql> = bound.iter().map(|value| value as &dyn ToSql).collect();
    conn.execute(sql, params_from_iter(refs)).map_err(|e| e.to_string())?;
    Ok(json!({
      "changes": conn.changes(),
      "lastInsertRowid": conn.last_insert_rowid(),
    }))
  }

  pub fn exec(&self, sql: &str) -> Result<(), String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch(sql).map_err(|e| e.to_string())
  }
}

enum Bound {
  Null,
  Integer(i64),
  Real(f64),
  Text(String),
}

impl ToSql for Bound {
  fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
    match self {
      Self::Null => Ok(rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Null)),
      Self::Integer(value) => Ok(rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Integer(*value))),
      Self::Real(value) => Ok(rusqlite::types::ToSqlOutput::Owned(rusqlite::types::Value::Real(*value))),
      Self::Text(value) => Ok(rusqlite::types::ToSqlOutput::Borrowed(rusqlite::types::ValueRef::Text(value.as_bytes()))),
    }
  }
}

fn bind(params: Option<&Value>) -> Vec<Bound> {
  match params {
    None | Some(Value::Null) => Vec::new(),
    Some(Value::Array(items)) => items.iter().map(value_to_bound).collect(),
    Some(other) => vec![value_to_bound(other)],
  }
}

fn value_to_bound(value: &Value) -> Bound {
  match value {
    Value::Null => Bound::Null,
    Value::Bool(value) => Bound::Integer(i64::from(*value)),
    Value::Number(number) => number
      .as_i64()
      .map(Bound::Integer)
      .or_else(|| number.as_f64().map(Bound::Real))
      .unwrap_or(Bound::Null),
    Value::String(value) => Bound::Text(value.clone()),
    other => Bound::Text(other.to_string()),
  }
}

fn sql_to_json(value: rusqlite::types::ValueRef<'_>) -> Value {
  match value {
    rusqlite::types::ValueRef::Null => Value::Null,
    rusqlite::types::ValueRef::Integer(value) => Value::Number(Number::from(value)),
    rusqlite::types::ValueRef::Real(value) => Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null),
    rusqlite::types::ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
    rusqlite::types::ValueRef::Blob(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
  }
}
