// ── Google Sheets v4 ──────────────────────────────────────────────────
// Tabs and sizes, ranges as TSV, writes that keep formulas live
// (`USER_ENTERED`, so `=SUM(A1:A9)` stays a formula), and a handful of
// formatting ops. A1 notation in, A1 notation out: it is what both the
// model and the person in the sheet already speak.

use super::{encode, Google};
use serde_json::{json, Value};

const API: &str = "https://sheets.googleapis.com/v4/spreadsheets";
/// Rows of a read shown to the model; the rest is summarized.
const READ_ROWS: usize = 500;

pub fn edit_url(id: &str) -> String {
    format!("https://docs.google.com/spreadsheets/d/{id}/edit")
}

/// One tab of a spreadsheet.
#[derive(Debug, Clone, PartialEq)]
pub struct Tab {
    pub id: i64,
    pub title: String,
    pub rows: i64,
    pub columns: i64,
}

async fn tabs(google: &Google, id: &str) -> Result<(String, Vec<Tab>), String> {
    let value = google
        .get_json(&format!(
            "{API}/{}?fields=properties.title,sheets.properties",
            encode(id)
        ))
        .await?;
    Ok(parse_tabs(&value))
}

fn parse_tabs(value: &Value) -> (String, Vec<Tab>) {
    let title = value
        .pointer("/properties/title")
        .and_then(Value::as_str)
        .unwrap_or("(untitled)")
        .to_string();
    let tabs = value
        .get("sheets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|sheet| {
            let props = sheet.get("properties")?;
            Some(Tab {
                id: props.get("sheetId").and_then(Value::as_i64).unwrap_or(0),
                title: props.get("title").and_then(Value::as_str)?.to_string(),
                rows: props
                    .pointer("/gridProperties/rowCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                columns: props
                    .pointer("/gridProperties/columnCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            })
        })
        .collect();
    (title, tabs)
}

pub async fn meta(google: &Google, id: &str) -> Result<String, String> {
    let (title, tabs) = tabs(google, id).await?;
    let mut lines = vec![
        format!("Spreadsheet: {title} — {}", edit_url(id)),
        "Tabs:".to_string(),
    ];
    for tab in &tabs {
        lines.push(format!(
            "- {} ({} rows × {} columns)",
            quote_title(&tab.title),
            tab.rows,
            tab.columns
        ));
    }
    Ok(lines.join("\n"))
}

/// A tab title as A1 notation wants it: quoted when it has to be.
pub fn quote_title(title: &str) -> String {
    if title.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        title.to_string()
    } else {
        format!("'{}'", title.replace('\'', "''"))
    }
}

pub async fn read(
    google: &Google,
    id: &str,
    range: Option<&str>,
    formulas: bool,
) -> Result<String, String> {
    let range = match range.map(str::trim).filter(|range| !range.is_empty()) {
        Some(range) => range.to_string(),
        None => {
            let (_, tabs) = tabs(google, id).await?;
            let first = tabs.first().ok_or("The spreadsheet has no tabs")?;
            quote_title(&first.title)
        }
    };
    let render = if formulas {
        "FORMULA"
    } else {
        "FORMATTED_VALUE"
    };
    let value = google
        .get_json(&format!(
            "{API}/{}/values/{}?valueRenderOption={render}",
            encode(id),
            encode(&range)
        ))
        .await?;
    let rows = grid(&value);
    let actual = value.get("range").and_then(Value::as_str).unwrap_or(&range);
    if rows.is_empty() {
        return Ok(format!("{actual} is empty."));
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let shown = rows.len().min(READ_ROWS);
    let mut text = format!(
        "{actual} — {} rows × {width} columns{} (tab-separated, untrusted content):\n{}",
        rows.len(),
        if formulas { ", formulas" } else { "" },
        crate::text::tsv(&rows[..shown])
    );
    if shown < rows.len() {
        text.push_str(&format!(
            "\n… {} more rows — read a narrower range to see them.",
            rows.len() - shown
        ));
    }
    Ok(text)
}

fn grid(value: &Value) -> Vec<Vec<String>> {
    value
        .get("values")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|row| {
            row.as_array()
                .into_iter()
                .flatten()
                .map(|cell| match cell {
                    Value::String(text) => text.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                })
                .collect()
        })
        .collect()
}

/// Write `rows` at `range` (replace) or after the table at `range` (append).
pub async fn write(
    google: &Google,
    id: &str,
    range: &str,
    rows: &[Vec<Value>],
    append: bool,
) -> Result<String, String> {
    if rows.is_empty() {
        return Err("No values to write.".to_string());
    }
    let body = json!({ "range": range, "majorDimension": "ROWS", "values": rows });
    let target = format!("{API}/{}/values/{}", encode(id), encode(range));
    let reply = if append {
        google
            .post_json(
                &format!(
                    "{target}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
                ),
                &body,
            )
            .await?
    } else {
        google
            .put_json(&format!("{target}?valueInputOption=USER_ENTERED"), &body)
            .await?
    };
    let updates = if append {
        reply.get("updates").cloned().unwrap_or(Value::Null)
    } else {
        reply
    };
    let written = updates
        .get("updatedRange")
        .and_then(Value::as_str)
        .unwrap_or(range);
    let cells = updates
        .get("updatedCells")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Ok(format!(
        "{} {cells} cell(s) in {written}. {}",
        if append { "Appended" } else { "Wrote" },
        edit_url(id)
    ))
}

pub async fn create(
    google: &Google,
    title: &str,
    rows: Option<&[Vec<Value>]>,
) -> Result<String, String> {
    let created = google
        .post_json(API, &json!({ "properties": { "title": title } }))
        .await?;
    let id = created
        .get("spreadsheetId")
        .and_then(Value::as_str)
        .ok_or("Google created no spreadsheet id")?
        .to_string();
    let first = created
        .pointer("/sheets/0/properties/title")
        .and_then(Value::as_str)
        .unwrap_or("Sheet1")
        .to_string();
    if let Some(rows) = rows.filter(|rows| !rows.is_empty()) {
        write(
            google,
            &id,
            &format!("{}!A1", quote_title(&first)),
            rows,
            false,
        )
        .await?;
    }
    Ok(format!("Created \"{title}\": {}", edit_url(&id)))
}

/// A cell range in A1 notation, resolved to a tab and zero-based bounds
/// (`None` = unbounded, as in `A:A` or `1:1`).
#[derive(Debug, Clone, PartialEq)]
pub struct A1 {
    pub tab: Option<String>,
    pub start_row: Option<i64>,
    pub end_row: Option<i64>,
    pub start_col: Option<i64>,
    pub end_col: Option<i64>,
}

pub fn parse_a1(range: &str) -> Option<A1> {
    let range = range.trim();
    let (tab, cells) = match range.rsplit_once('!') {
        Some((tab, cells)) => {
            let tab = tab.trim();
            let tab = tab
                .strip_prefix('\'')
                .and_then(|t| t.strip_suffix('\''))
                .map(|t| t.replace("''", "'"))
                .unwrap_or_else(|| tab.to_string());
            (Some(tab), cells)
        }
        None => (None, range),
    };
    let (from, to) = cells.split_once(':').unwrap_or((cells, cells));
    let (start_col, start_row) = cell(from)?;
    let (end_col, end_row) = cell(to)?;
    Some(A1 {
        tab,
        start_row,
        end_row: end_row.map(|row| row + 1),
        start_col,
        end_col: end_col.map(|col| col + 1),
    })
}

/// `C7` → (2, 6); `C` → (2, None); `7` → (None, 6).
fn cell(text: &str) -> Option<(Option<i64>, Option<i64>)> {
    let text = text.trim().replace('$', "");
    if text.is_empty() {
        return None;
    }
    let letters: String = text.chars().take_while(char::is_ascii_alphabetic).collect();
    let digits = &text[letters.len()..];
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let col = if letters.is_empty() {
        None
    } else {
        Some(
            letters
                .to_ascii_uppercase()
                .bytes()
                .try_fold(0i64, |acc, b| {
                    acc.checked_mul(26)?.checked_add(i64::from(b - b'A' + 1))
                })?
                - 1,
        )
    };
    let row = match digits {
        "" => None,
        digits => Some(
            digits
                .parse::<i64>()
                .ok()?
                .checked_sub(1)
                .filter(|row| *row >= 0)?,
        ),
    };
    if col.is_none() && row.is_none() {
        return None;
    }
    Some((col, row))
}

fn grid_range(a1: &A1, tabs: &[Tab]) -> Result<Value, String> {
    let tab = match &a1.tab {
        Some(title) => tabs
            .iter()
            .find(|tab| &tab.title == title)
            .ok_or_else(|| format!("No tab named \"{title}\""))?,
        None => tabs.first().ok_or("The spreadsheet has no tabs")?,
    };
    let mut range = json!({ "sheetId": tab.id });
    for (key, value) in [
        ("startRowIndex", a1.start_row),
        ("endRowIndex", a1.end_row),
        ("startColumnIndex", a1.start_col),
        ("endColumnIndex", a1.end_col),
    ] {
        if let Some(value) = value {
            range[key] = json!(value);
        }
    }
    Ok(range)
}

/// One formatting op, in the vocabulary `sheet_format` offers.
#[derive(Debug, Clone, PartialEq)]
pub enum FormatOp {
    Bold {
        range: String,
        on: bool,
    },
    NumberFormat {
        range: String,
        pattern: String,
    },
    Freeze {
        tab: Option<String>,
        rows: i64,
        columns: i64,
    },
    AutoSize {
        tab: Option<String>,
    },
}

impl FormatOp {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        let range =
            || text("range").ok_or_else(|| "this op needs \"range\" (A1 notation)".to_string());
        match value.get("op").and_then(Value::as_str).unwrap_or_default() {
            "bold" => Ok(FormatOp::Bold {
                range: range()?,
                on: value.get("on").and_then(Value::as_bool).unwrap_or(true),
            }),
            "number_format" => Ok(FormatOp::NumberFormat {
                range: range()?,
                pattern: text("pattern")
                    .ok_or("number_format needs \"pattern\", e.g. \"$#,##0.00\" or \"0.0%\"")?,
            }),
            "freeze" => Ok(FormatOp::Freeze {
                tab: text("tab"),
                rows: value
                    .get("rows")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0),
                columns: value
                    .get("columns")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0),
            }),
            "autosize" => Ok(FormatOp::AutoSize { tab: text("tab") }),
            other => Err(format!(
                "Unknown op \"{other}\" — use bold, number_format, freeze or autosize"
            )),
        }
    }
}

fn tab_named<'a>(tabs: &'a [Tab], title: Option<&str>) -> Result<&'a Tab, String> {
    match title {
        Some(title) => tabs
            .iter()
            .find(|tab| tab.title == title)
            .ok_or_else(|| format!("No tab named \"{title}\"")),
        None => tabs
            .first()
            .ok_or_else(|| "The spreadsheet has no tabs".to_string()),
    }
}

fn format_request(op: &FormatOp, tabs: &[Tab]) -> Result<Value, String> {
    let resolve = |range: &str| {
        let a1 = parse_a1(range).ok_or_else(|| format!("\"{range}\" is not A1 notation"))?;
        grid_range(&a1, tabs)
    };
    Ok(match op {
        FormatOp::Bold { range, on } => json!({ "repeatCell": {
            "range": resolve(range)?,
            "cell": { "userEnteredFormat": { "textFormat": { "bold": on } } },
            "fields": "userEnteredFormat.textFormat.bold",
        }}),
        FormatOp::NumberFormat { range, pattern } => json!({ "repeatCell": {
            "range": resolve(range)?,
            "cell": { "userEnteredFormat": { "numberFormat": { "type": "NUMBER", "pattern": pattern } } },
            "fields": "userEnteredFormat.numberFormat",
        }}),
        FormatOp::Freeze { tab, rows, columns } => json!({ "updateSheetProperties": {
            "properties": {
                "sheetId": tab_named(tabs, tab.as_deref())?.id,
                "gridProperties": { "frozenRowCount": rows, "frozenColumnCount": columns },
            },
            "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        }}),
        FormatOp::AutoSize { tab } => {
            let tab = tab_named(tabs, tab.as_deref())?;
            json!({ "autoResizeDimensions": { "dimensions": {
                "sheetId": tab.id,
                "dimension": "COLUMNS",
                "startIndex": 0,
                "endIndex": tab.columns.max(1),
            }}})
        }
    })
}

pub async fn format(google: &Google, id: &str, ops: &[FormatOp]) -> Result<String, String> {
    let (_, tabs) = tabs(google, id).await?;
    let requests = ops
        .iter()
        .map(|op| format_request(op, &tabs))
        .collect::<Result<Vec<_>, _>>()?;
    google
        .post_json(
            &format!("{API}/{}:batchUpdate", encode(id)),
            &json!({ "requests": requests }),
        )
        .await?;
    Ok(format!(
        "Applied {} formatting op(s). {}",
        ops.len(),
        edit_url(id)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a1_ranges_resolve_to_zero_based_bounds() {
        assert_eq!(
            parse_a1("Sheet1!B2:D10"),
            Some(A1 {
                tab: Some("Sheet1".into()),
                start_row: Some(1),
                end_row: Some(10),
                start_col: Some(1),
                end_col: Some(4),
            })
        );
        let column = parse_a1("'Q1 ''24'!C:C").expect("column");
        assert_eq!(column.tab.as_deref(), Some("Q1 '24"));
        assert_eq!((column.start_col, column.end_col), (Some(2), Some(3)));
        assert_eq!((column.start_row, column.end_row), (None, None));
        let row = parse_a1("1:1").expect("row");
        assert_eq!(
            (row.start_row, row.end_row, row.start_col),
            (Some(0), Some(1), None)
        );
        assert_eq!(parse_a1("AA1").expect("cell").start_col, Some(26));
        assert!(parse_a1("Sheet1!").is_none());
        assert!(parse_a1("B0").is_none());
        assert!(parse_a1("1A").is_none());
    }

    #[test]
    fn titles_are_quoted_only_when_needed() {
        assert_eq!(quote_title("Sheet1"), "Sheet1");
        assert_eq!(quote_title("Q1 '24"), "'Q1 ''24'");
    }

    #[test]
    fn tabs_and_values_parse_from_api_shapes() {
        let (title, tabs) = parse_tabs(&json!({
            "properties": { "title": "Budget" },
            "sheets": [{ "properties": { "sheetId": 7, "title": "Data",
                "gridProperties": { "rowCount": 100, "columnCount": 5 } } }]
        }));
        assert_eq!(title, "Budget");
        assert_eq!(
            tabs,
            vec![Tab {
                id: 7,
                title: "Data".into(),
                rows: 100,
                columns: 5
            }]
        );
        let rows = grid(&json!({ "values": [["a", 1], [true]] }));
        assert_eq!(
            rows,
            vec![
                vec!["a".to_string(), "1".to_string()],
                vec!["true".to_string()]
            ]
        );
    }

    #[test]
    fn format_ops_build_requests_against_the_right_tab() {
        let tabs = vec![
            Tab {
                id: 0,
                title: "Sheet1".into(),
                rows: 10,
                columns: 3,
            },
            Tab {
                id: 9,
                title: "Totals".into(),
                rows: 10,
                columns: 6,
            },
        ];
        let bold = format_request(
            &FormatOp::Bold {
                range: "Totals!A1:F1".into(),
                on: true,
            },
            &tabs,
        )
        .unwrap();
        assert_eq!(bold["repeatCell"]["range"]["sheetId"], 9);
        assert_eq!(bold["repeatCell"]["range"]["endColumnIndex"], 6);
        let freeze = format_request(
            &FormatOp::Freeze {
                tab: None,
                rows: 1,
                columns: 0,
            },
            &tabs,
        )
        .unwrap();
        assert_eq!(freeze["updateSheetProperties"]["properties"]["sheetId"], 0);
        let size = format_request(
            &FormatOp::AutoSize {
                tab: Some("Totals".into()),
            },
            &tabs,
        )
        .unwrap();
        assert_eq!(size["autoResizeDimensions"]["dimensions"]["endIndex"], 6);
        assert!(format_request(
            &FormatOp::AutoSize {
                tab: Some("Nope".into())
            },
            &tabs
        )
        .is_err());
        assert!(FormatOp::parse(&json!({"op": "number_format", "range": "A:A"})).is_err());
    }
}
