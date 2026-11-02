//! CLI transport for a paired device. Credentials stay in the OS vault.
use super::*;
const MAX: u64 = 64 * 1024 * 1024;
fn checked_input(path: &Path) -> Result<Value, String> {
    if !path.is_absolute() {
        return Err("Нужен абсолютный путь пакета".into());
    }
    let m = fs::symlink_metadata(path).map_err(|_| "Пакет недоступен")?;
    if !m.is_file() || m.file_type().is_symlink() || m.len() > MAX {
        return Err("Небезопасный или слишком большой пакет".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Пакет недоступен")?
        .take(MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Пакет не прочитан")?;
    if bytes.len() as u64 > MAX {
        return Err("Пакет слишком велик".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Некорректный пакет".into())
}
pub fn cli() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args
        .get(2)
        .map(String::as_str)
        .ok_or("Нужна операция head/artifact/publish")?;
    let value = args.get(3).ok_or("Нужен канал, хеш или файл пакета")?;
    let identity = release_identity()?;
    if args
        .get(4)
        .is_some_and(|expected| !expected.is_empty() && expected != &identity)
    {
        return Err("Подключение Hub изменилось; публикация остановлена".into());
    }
    let result: Value = match mode {
        "head" if matches!(value.as_str(), "stable" | "preview") => {
            json!({"head":release_get(value,&identity)?,"identity":identity})
        }
        "artifact"
            if value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
        {
            release_get(&format!("artifacts/{value}"), &identity)?
        }
        "publish" => {
            let data = checked_input(Path::new(value))?;
            let c = load()?;
            let key = vault(&c.endpoint)?
                .get_password()
                .map_err(|_| "Нет ключа Hub")?;
            if release_identity()? != identity {
                return Err("Подключение Hub изменилось".into());
            }
            let response=client(&c)?.post(format!("{}/api/updates/device",c.endpoint.trim_end_matches('/')))
                .timeout(Duration::from_secs(120)).bearer_auth(key).json(&data).send().map_err(|_| "Соединение прервано; публикация не подтверждена. Проверьте Hub без повторной отправки пакета.")?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!(
                    "Hub HTTP {}: релиз не подтверждён; проверьте версию канала и службу подписи",
                    status.as_u16()
                ));
            }
            let mut bytes = Vec::new();
            response
                .take(MAX + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Ответ публикации прерван")?;
            if bytes.len() as u64 > MAX {
                return Err("Ответ Hub слишком велик".into());
            }
            serde_json::from_slice(&bytes).map_err(|_| "Некорректный ответ Hub")?
        }
        "workshop" => {
            let data = checked_input(Path::new(value))?;
            let path = data["path"].as_str().ok_or("Нужен маршрут обмена")?;
            let body = data.get("body").filter(|b| !b.is_null()).cloned();
            if data.as_object().is_none_or(|o| o.len() > 2)
                || !workshop_path(path, body.is_some())
                || data.to_string().len() > 2 * 1024 * 1024
            {
                return Err("Некорректный запрос обмена".into());
            }
            let c = load()?;
            if !c.enabled {
                return Err("Hub disabled".into());
            }
            request(&c, path, body)?
        }
        _ => return Err("Неизвестная операция публикации".into()),
    };
    if release_identity()? != identity {
        return Err("Подключение Hub изменилось; результат не принят".into());
    }
    println!("{result}");
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidate_requires_regular_absolute_bounded_json() {
        assert!(checked_input(Path::new("relative.json")).is_err());
        let p =
            std::env::temp_dir().join(format!("enki-device-release-{}.json", std::process::id()));
        fs::write(&p, b"{\"channel\":\"stable\"}").unwrap();
        assert_eq!(checked_input(&p).unwrap()["channel"], "stable");
        fs::write(&p, b"not json").unwrap();
        assert!(checked_input(&p).is_err());
        fs::remove_file(p).unwrap();
    }
}
