//! Model price book and USD→RUB rate for usage accounting.
//!
//! DeepSeek publishes per-million token prices with a peak/off-peak schedule in
//! its API docs; no separate JSON price endpoint is known. We therefore try the
//! docs page first and fall back to an embedded snapshot verified by hand, and
//! the frontend always shows where the numbers came from and when they were
//! checked. Closed ledger days are never repriced, so a stale book only affects
//! the unsettled present, not history.

use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn get(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("Arvela usage pricing")
        .build()
        .map_err(|_| "Не удалось создать HTTPS-клиент".to_string())?;
    let response = client
        .get(url)
        .send()
        .map_err(|_| "Сеть недоступна: данные цены не получены".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Ответ сервера цен: HTTP {}", status.as_u16()));
    }
    // Read at most one byte past the limit: an oversized answer is refused
    // without first being buffered whole.
    const LIMIT: u64 = 4 * 1024 * 1024;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(response, LIMIT + 1), &mut bytes)
        .map_err(|_| "Тело ответа цен не читается".to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("Ответ сервера цен слишком большой".into());
    }
    String::from_utf8(bytes).map_err(|_| "Тело ответа цен не читается".to_string())
}

/// USD prices per 1M tokens, verified against the official docs page on
/// 2026-10-21. Off-peak is half of peak; peak hours (UTC, Mon–Fri, excluding
/// Chinese public holidays — not modelled) are 01:00–04:00 and 06:00–10:00.
pub fn embedded_price_book() -> Value {
    json!({
        "schema": 1,
        "source": "embedded",
        "checkedAt": 0u64,
        "offPeakFactor": 0.5,
        "peakDays": [1, 2, 3, 4, 5],
        "peakWindows": [{ "startHour": 1, "endHour": 4 }, { "startHour": 6, "endHour": 10 }],
        "models": {
            "flash": {
                "inputCacheHit": { "peak": 0.006, "offPeak": 0.003 },
                "input": { "peak": 0.3, "offPeak": 0.15 },
                "output": { "peak": 1.2, "offPeak": 0.6 }
            },
            "pro": {
                "inputCacheHit": { "peak": 0.044, "offPeak": 0.022 },
                "input": { "peak": 1.32, "offPeak": 0.66 },
                "output": { "peak": 3.96, "offPeak": 1.98 }
            }
        }
    })
}

/// Parse the pricing table from the docs HTML/JS text: after tag stripping the
/// cells appear in a fixed order — cache-hit off-peak (flash, pro), cache-hit
/// peak, cache-miss off/peak, output off/peak. Any deviation aborts parsing so
/// the embedded snapshot stays in charge.
pub fn parse_price_book(text: &str) -> Option<Value> {
    let plain = strip_tags(text);
    let prices: Vec<f64> = plain
        .split('$')
        .skip(1)
        .filter_map(|part| {
            let digits: String = part
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            digits.parse::<f64>().ok()
        })
        .collect();
    // The Search & Fetch table ($0.75 twice) may follow; require the first 12
    // cell values to look like the pricing table and off-peak to be half peak.
    if prices.len() < 12 {
        return None;
    }
    let p = &prices[..12];
    let off_is_half =
        |off: f64, peak: f64| off > 0.0 && peak > 0.0 && (peak / off - 2.0).abs() < 0.01;
    if !(off_is_half(p[0], p[2])
        && off_is_half(p[1], p[3])
        && off_is_half(p[4], p[6])
        && off_is_half(p[5], p[7])
        && off_is_half(p[8], p[10])
        && off_is_half(p[9], p[11]))
    {
        return None;
    }
    let windows = parse_peak_windows(&plain)?;
    let book = embedded_price_book();
    let mut book = book;
    book["source"] = json!("docs");
    book["models"]["flash"]["inputCacheHit"] = json!({ "peak": p[2], "offPeak": p[0] });
    book["models"]["pro"]["inputCacheHit"] = json!({ "peak": p[3], "offPeak": p[1] });
    book["models"]["flash"]["input"] = json!({ "peak": p[6], "offPeak": p[4] });
    book["models"]["pro"]["input"] = json!({ "peak": p[7], "offPeak": p[5] });
    book["models"]["flash"]["output"] = json!({ "peak": p[10], "offPeak": p[8] });
    book["models"]["pro"]["output"] = json!({ "peak": p[11], "offPeak": p[9] });
    book["peakWindows"] = json!(windows);
    Some(book)
}

fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday"
fn parse_peak_windows(text: &str) -> Option<Vec<Value>> {
    let anchor = text.find("Peak hours are")?;
    let tail = &text[anchor..];
    let end = tail.find('.').unwrap_or(tail.len());
    let sentence = &tail[..end.min(400)];
    let mut windows = Vec::new();
    let bytes = sentence.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if bytes[i].is_ascii_digit()
            && bytes[i + 1].is_ascii_digit()
            && bytes[i + 2] == b':'
            && bytes[i + 3].is_ascii_digit()
        {
            let start: u32 = sentence[i..i + 2].parse().ok()?;
            // Look for " - HH:MM" right after the window start token.
            let rest = &sentence[i + 5..];
            let dash = rest.find("- ")?;
            let after = &rest[dash + 2..];
            if after.len() < 5
                || !after.as_bytes()[0].is_ascii_digit()
                || !after.as_bytes()[1].is_ascii_digit()
                || after.as_bytes()[2] != b':'
            {
                i += 1;
                continue;
            }
            let finish: u32 = after[0..2].parse().ok()?;
            if start < finish && finish <= 24 {
                windows.push(json!({ "startHour": start, "endHour": finish }));
            }
            i += 12;
        } else {
            i += 1;
        }
    }
    if windows.is_empty() {
        return None;
    }
    Some(windows)
}

/// cbr-xml-daily.ru returns `{"Valute":{"USD":{"Value":81.97,"Nominal":1}}}`;
/// older mirrors used `Val`. `Value` is per `Nominal` units, so divide.
fn parse_cbr_rate(body: &str) -> Option<f64> {
    let value: Value = serde_json::from_str(body).ok()?;
    let usd = value
        .pointer("/Valute/USD")
        .or_else(|| value.pointer("/Val/USD"))?;
    let raw = usd.get("Value").and_then(Value::as_f64)?;
    let nominal = usd
        .get("Nominal")
        .and_then(Value::as_f64)
        .filter(|n| *n > 0.0)
        .unwrap_or(1.0);
    let rate = raw / nominal;
    (0.01..1_000.0).contains(&rate).then_some(rate)
}

/// open.er-api.com/v6/latest/USD is USD-based: the ruble rate is `rates.RUB`
/// (its `rates.USD` is always 1 and must never be used as a USD→RUB rate).
fn parse_er_rate(body: &str) -> Option<f64> {
    let value: Value = serde_json::from_str(body).ok()?;
    value
        .pointer("/rates/RUB")
        .and_then(Value::as_f64)
        .filter(|r| (0.01..1_000.0).contains(r))
}

/// Tries CBR first, then er-api. A source that answers but cannot be parsed must
/// still fall through to the next one — a 200 with an unexpected shape is not a
/// working rate source.
fn select_rate(
    cbr: Result<String, String>,
    er: Result<String, String>,
) -> Result<(&'static str, f64), String> {
    let mut problems: Vec<String> = Vec::new();
    match cbr {
        Ok(body) => match parse_cbr_rate(&body) {
            Some(rate) => return Ok(("cbr", rate)),
            None => problems.push("cbr: курс в ответе не распознан".into()),
        },
        Err(error) => problems.push(format!("cbr: {error}")),
    }
    match er {
        Ok(body) => match parse_er_rate(&body) {
            Some(rate) => return Ok(("er-api", rate)),
            None => problems.push("er-api: курс в ответе не распознан".into()),
        },
        Err(error) => problems.push(format!("er-api: {error}")),
    }
    Err(problems.join("; "))
}

/// Blocking HTTP must run off the async runtime, matching the other network
/// commands (`tauri::async_runtime::spawn_blocking`).
fn load_price_book() -> Value {
    let mut book = match get("https://api-docs.deepseek.com/quick_start/pricing") {
        // The docs page is a client-rendered app, so the raw HTML usually has no
        // price table; the hand-verified embedded snapshot is the normal source.
        Ok(html) => parse_price_book(&html).unwrap_or_else(embedded_price_book),
        Err(_) => embedded_price_book(),
    };
    book["checkedAt"] = json!(now_ms());
    book
}

fn load_usd_rate() -> Result<Value, String> {
    let (source, rate) = select_rate(
        get("https://www.cbr-xml-daily.ru/daily_json.js"),
        get("https://open.er-api.com/v6/latest/USD"),
    )?;
    Ok(json!({ "schema": 1, "source": source, "checkedAt": now_ms(), "rate": rate }))
}

#[tauri::command]
pub async fn fetch_price_book() -> Value {
    tauri::async_runtime::spawn_blocking(load_price_book)
        .await
        .unwrap_or_else(|_| {
            let mut book = embedded_price_book();
            book["checkedAt"] = json!(now_ms());
            book
        })
}

#[tauri::command]
pub async fn fetch_usd_rate() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(load_usd_rate)
        .await
        .map_err(|_| "Задача получения курса не завершилась".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCS_FIXTURE: &str = r#"<html><body>
    <table><tr><td>1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
    <tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
    <tr><td>1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
    <tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
    <tr><td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
    <tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr></table>
    <p>(2) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.</p>
    </body></html>"#;

    #[test]
    fn parses_the_docs_pricing_table() {
        let book = parse_price_book(DOCS_FIXTURE).expect("fixture parses");
        assert_eq!(book["source"], "docs");
        assert_eq!(book["models"]["pro"]["input"]["peak"], 1.32);
        assert_eq!(book["models"]["flash"]["output"]["offPeak"], 0.6);
        assert_eq!(book["peakWindows"][1]["startHour"], 6);
    }

    #[test]
    fn rejects_malformed_tables() {
        assert!(parse_price_book("<p>$1 $2 $3</p>").is_none());
        assert!(parse_price_book(&DOCS_FIXTURE.replace("$0.003", "$0.004")).is_none());
        assert!(parse_price_book(&DOCS_FIXTURE.replace("Peak hours are", "No schedule")).is_none());
    }

    #[test]
    fn embedded_book_is_self_consistent() {
        let book = embedded_price_book();
        for model in ["flash", "pro"] {
            for kind in ["input", "inputCacheHit", "output"] {
                let peak = book["models"][model][kind]["peak"].as_f64().unwrap();
                let off = book["models"][model][kind]["offPeak"].as_f64().unwrap();
                assert!(
                    peak > 0.0 && (peak / off - 2.0).abs() < 0.001,
                    "{model}/{kind}"
                );
            }
        }
    }

    #[test]
    fn parses_real_cbr_and_er_api_shapes() {
        // Shapes observed from the live endpoints on 2026-10-21.
        assert_eq!(
            parse_cbr_rate(r#"{"Valute":{"USD":{"Value":81.9739,"Nominal":1}}}"#).unwrap(),
            81.9739
        );
        // CBR quotes per Nominal units, so a Nominal of 2 must be divided out.
        assert_eq!(
            parse_cbr_rate(r#"{"Valute":{"USD":{"Value":163.9478,"Nominal":2}}}"#).unwrap(),
            81.9739
        );
        // The older `Val` key is still accepted for compatibility.
        assert_eq!(
            parse_cbr_rate(r#"{"Val":{"USD":{"Value":80.5}}}"#).unwrap(),
            80.5
        );
        assert!(parse_cbr_rate(r#"{"Valute":{"USD":{"Value":0}}}"#).is_none());
        assert!(parse_cbr_rate("not json").is_none());

        // er-api is USD-based: rates.USD is always 1 and rates.RUB is the rate.
        assert_eq!(
            parse_er_rate(r#"{"base_code":"USD","rates":{"USD":1,"RUB":82.571905}}"#).unwrap(),
            82.571905
        );
        assert!(parse_er_rate(r#"{"rates":{"USD":1}}"#).is_none());
        assert!(parse_er_rate("not json").is_none());
    }

    #[test]
    fn falls_back_when_a_source_answers_with_an_unexpected_shape() {
        let cbr = r#"{"Valute":{"USD":{"Value":81.9739,"Nominal":1}}}"#.to_string();
        let er = r#"{"base_code":"USD","rates":{"USD":1,"RUB":82.571905}}"#.to_string();
        assert_eq!(
            select_rate(Ok(cbr), Ok(er.clone())).unwrap(),
            ("cbr", 81.9739)
        );
        // A 200 with an unparseable body must not block the next source.
        assert_eq!(
            select_rate(Ok("{}".into()), Ok(er.clone())).unwrap(),
            ("er-api", 82.571905)
        );
        assert_eq!(
            select_rate(Err("HTTP 503".into()), Ok(er)).unwrap(),
            ("er-api", 82.571905)
        );
        let error = select_rate(Ok("{}".into()), Ok("{}".into())).unwrap_err();
        assert!(error.contains("cbr") && error.contains("er-api"), "{error}");
    }
}
