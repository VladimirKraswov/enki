//! Reviewed skill experiments. Candidate files never become active on creation.
use super::*;
use sha2::{Digest, Sha256};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trial {
    pub phase: String,
    pub revision: String,
    pub case_id: String,
    pub engine: String,
    pub model: String,
    pub session_id: String,
    pub message_id: String,
    pub skill_read: bool,
    pub passed: bool,
    pub wall_ms: u64,
    pub tokens: u64,
    pub errors: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Experiment {
    pub id: String,
    pub scope: String,
    pub directory: Option<String>,
    pub path: String,
    pub name: String,
    pub baseline: String,
    pub candidate: String,
    pub baseline_path: String,
    pub candidate_path: String,
    pub trials: Vec<Trial>,
    pub state: String,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn tree(
    path: &Path,
    base: &Path,
    files: &mut Vec<(String, Vec<u8>)>,
    budget: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 8 {
        return Err("Слишком глубокий пакет навыка".into());
    }
    for entry in fs::read_dir(path).map_err(|_| "Навык недоступен")? {
        if *budget == 0 {
            return Err("Слишком много элементов в навыке".into());
        }
        *budget -= 1;
        let p = entry.map_err(|e| e.to_string())?.path();
        let meta = fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("Ссылки в пакете навыка не поддерживаются".into());
        }
        if files.len() > 128 {
            return Err("Слишком много файлов в навыке".into());
        }
        if meta.is_dir() {
            tree(&p, base, files, budget, depth + 1)?;
        } else if meta.is_file() {
            if meta.len() > 2_000_000 {
                return Err("Файл навыка слишком большой".into());
            }
            files.push((
                p.strip_prefix(base)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .into(),
                fs::read(&p).map_err(|e| e.to_string())?,
            ));
        }
    }
    if files.iter().map(|f| f.1.len()).sum::<usize>() > 20_000_000 {
        return Err("Пакет навыка превышает 20 МБ".into());
    }
    Ok(())
}
fn bundle(path: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut files = vec![];
    if path.is_symlink() {
        return Err("Ссылка вместо пакета".into());
    }
    tree(path, path, &mut files, &mut 256, 0)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}
fn revision(path: &Path) -> Result<String, String> {
    let files = bundle(path)?;
    let mut hash = Sha256::new();
    for (name, bytes) in files {
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(digest(&bytes));
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn snapshot(from: &Path, to: &Path) -> Result<(), String> {
    for (name, bytes) in bundle(from)? {
        let p = to.join(name);
        fs::create_dir_all(p.parent().ok_or("Invalid path")?).map_err(|e| e.to_string())?;
        fs::write(p, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn source(scope: &str, directory: Option<&str>, path: &str) -> Result<Skill, String> {
    let skill = document(scope, directory)?
        .skills
        .into_iter()
        .find(|s| s.path == path && s.engines.iter().any(|e| e == "pi"))
        .ok_or("Выберите общий навык из каталога")?;
    let p = Path::new(path);
    if p.canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root()?.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err(
            "Пакет библиотеки неизменяемый. Создайте свою копию в .agents/skills и подключите эту папку как источник навыков, иначе Enki её не загрузит."
                .into(),
        );
    }
    if p.file_name().and_then(|x| x.to_str()) != Some("SKILL.md") || p.is_symlink() {
        return Err("Некорректный файл навыка".into());
    }
    for ancestor in p.ancestors().take_while(|p| p.parent().is_some()) {
        if ancestor.is_symlink() {
            return Err("Навык в символической ссылке нельзя изменять".into());
        }
    }
    Ok(skill)
}
fn pairs(e: &Experiment) -> Result<(), String> {
    let mut count = 0;
    for candidate in e.trials.iter().filter(|t| t.phase == "candidate") {
        let baseline = e
            .trials
            .iter()
            .find(|t| {
                t.phase == "baseline"
                    && t.case_id == candidate.case_id
                    && t.engine == candidate.engine
                    && t.model == candidate.model
            })
            .ok_or("Нет парного базового испытания")?;
        if !candidate.passed
            || candidate.errors > baseline.errors
            || candidate.wall_ms > baseline.wall_ms.saturating_mul(12) / 10
            || candidate.tokens > baseline.tokens.saturating_mul(12) / 10
        {
            return Err(
                "Кандидат ухудшает результат, ошибки, время или токены более чем на 20%".into(),
            );
        }
        count += 1;
    }
    // One agent runtime executes every chat; paired cases replace the former
    // two-engine coverage requirement.
    if count < 3 {
        return Err("Нужны минимум три парных сценария".into());
    }
    Ok(())
}
fn load(dir: &Path) -> Result<Experiment, String> {
    serde_json::from_slice(&fs::read(dir.join("experiment.json")).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn save(dir: &Path, e: &Experiment) -> Result<(), String> {
    let path = dir.join("experiment.json");
    let old = fs::read_to_string(&path).unwrap_or_default();
    crate::config::write_at(
        &path,
        &old,
        &serde_json::to_string_pretty(e).map_err(|e| e.to_string())?,
    )
}
fn promote(e: &mut Experiment, dir: &Path, rollback: bool) -> Result<(), String> {
    let source = Path::new(&e.path);
    let parent = source.parent().ok_or("Invalid path")?;
    let (expected, target, next) = if rollback {
        (&e.candidate, dir.join("baseline/SKILL.md"), "rolledBack")
    } else {
        pairs(e)?;
        (&e.baseline, dir.join("candidate/SKILL.md"), "promoted")
    };
    let actual = revision(parent)?;
    let target_revision = if rollback { &e.baseline } else { &e.candidate };
    let pending = if rollback { "rollingBack" } else { "promoting" };
    let valid = if rollback {
        matches!(e.state.as_str(), "promoted" | "promoting" | "rollingBack")
    } else {
        matches!(e.state.as_str(), "candidate" | "promoting")
    };
    if !valid {
        return Err("Состояние испытания изменилось".into());
    }
    if revision(&dir.join("baseline"))? != e.baseline
        || revision(&dir.join("candidate"))? != e.candidate
    {
        return Err("Файлы испытаний изменились; перечитайте навык".into());
    }
    // Recovery after the file was committed but the final receipt was not.
    if e.state == pending && actual == *target_revision {
        e.state = next.into();
        return save(dir, e);
    }
    if actual != *expected {
        return Err("Исходный навык изменился после испытаний".into());
    }
    e.state = pending.into();
    save(dir, e)?;

    let content = fs::read(&target).map_err(|e| e.to_string())?;
    replace_skill(source, &content, expected)?;
    e.state = next.into();
    save(dir, e)
}
fn replace_skill(source: &Path, content: &[u8], expected: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = source.parent().ok_or("Invalid source")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    // A sibling staging file does not alter the skill bundle revision.
    let temp = parent
        .parent()
        .ok_or("Invalid source root")?
        .join(format!(".arvela-skill-{stamp}.tmp"));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(content)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::set_permissions(
            &temp,
            fs::metadata(source)
                .map_err(|e| e.to_string())?
                .permissions(),
        )
        .map_err(|e| e.to_string())?;
        if source.is_symlink() || revision(parent)? != expected {
            return Err("Навык изменился во время сохранения".into());
        }
        fs::rename(&temp, source).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityRequest {
    action: String,
    scope: String,
    directory: Option<String>,
    path: Option<String>,
    body: Option<String>,
    experiment_id: Option<String>,
    trial: Option<Trial>,
}
#[tauri::command]
pub async fn skill_quality(
    window: tauri::WebviewWindow,
    request: QualityRequest,
) -> Result<Value, String> {
    let QualityRequest {
        action,
        scope,
        directory,
        path,
        body,
        experiment_id,
        trial,
    } = request;
    if !matches!(action.as_str(), "read" | "list") {
        crate::updates::ensure_writable()?;
    }
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root()?.join("quality");
        private(&root)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("quality.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock_exclusive()
            .map_err(|_| "Испытания заняты другой операцией")?;
        if action == "list" {
            let mut out = vec![];
            for entry in fs::read_dir(&root)
                .map_err(|e| e.to_string())?
                .flatten()
                .take(500)
            {
                if entry.path().is_dir() && !entry.path().is_symlink() {
                    if let Ok(e) = load(&entry.path()) {
                        if e.scope == scope && e.directory == directory {
                            out.push(e);
                        }
                    }
                }
            }
            out.sort_by(|a, b| b.id.cmp(&a.id));
            return serde_json::to_value(out).map_err(|e| e.to_string());
        }
        if action == "read" {
            let path = path.ok_or("Нет навыка")?;
            source(&scope, directory.as_deref(), &path)?;
            let body = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if body.len() > 65536 {
                return Err("SKILL.md слишком большой".into());
            }
            return Ok(json!({"body":body}));
        }
        if action == "create" {
            let path = path.ok_or("Нет навыка")?;
            let skill = source(&scope, directory.as_deref(), &path)?;
            let body = body.ok_or("Нет кандидата")?;
            let normalized = body.replace("\r\n", "\n");
            let front = normalized
                .strip_prefix("---\n")
                .and_then(|s| s.split_once("\n---").map(|p| p.0))
                .ok_or("Нужна YAML-шапка SKILL.md")?;
            let description = super::skills::field(front, "description");
            if body.len() > 65536
                || super::skills::field(front, "name") != skill.name
                || description.is_empty()
                || description.chars().count() > 1024
            {
                return Err("Сохраните имя навыка и корректное description в YAML-шапке".into());
            }
            let id = format!(
                "trial-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos()
            );
            let dir = root.join(&id);
            private(&dir)?;
            let parent = Path::new(&path).parent().ok_or("Invalid path")?;
            let baseline = revision(parent)?;
            snapshot(parent, &dir.join("baseline"))?;
            snapshot(parent, &dir.join("candidate"))?;
            fs::write(dir.join("candidate/SKILL.md"), body).map_err(|e| e.to_string())?;
            if revision(parent)? != baseline {
                return Err("Исходный навык изменился во время копирования".into());
            }
            let e = Experiment {
                id,
                scope,
                directory,
                path,
                name: skill.name,
                baseline,
                candidate: revision(&dir.join("candidate"))?,
                baseline_path: dir.join("baseline/SKILL.md").display().to_string(),
                candidate_path: dir.join("candidate/SKILL.md").display().to_string(),
                trials: vec![],
                state: "candidate".into(),
            };
            save(&dir, &e)?;
            return serde_json::to_value(e).map_err(|e| e.to_string());
        }
        let id = experiment_id.ok_or("Нет испытания")?;
        if !id.starts_with("trial-")
            || id.len() > 64
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("Invalid trial".into());
        }
        let dir = root.join(id);
        if dir.is_symlink() {
            return Err("Invalid trial path".into());
        }
        let mut e = load(&dir)?;
        if e.scope != scope || e.directory != directory {
            return Err("Область испытания изменилась".into());
        }
        match action.as_str() {
            "record" => {
                let t = trial.ok_or("Нет результата")?;
                if !matches!(t.phase.as_str(), "baseline" | "candidate")
                    || t.engine != "pi"
                    || !t.skill_read
                    || t.case_id.is_empty()
                    || t.case_id.len() > 160
                    || t.wall_ms == 0
                    || t.tokens == 0
                    || t.model.len() > 256
                    || t.session_id.len() > 200
                    || t.message_id.len() > 200
                    || e.trials.len() >= 100
                {
                    return Err("Недостаточно измеренных данных испытания".into());
                }
                let expected = if t.phase == "baseline" {
                    &e.baseline
                } else {
                    &e.candidate
                };
                if &t.revision != expected || revision(&dir.join(&t.phase))? != *expected {
                    return Err("Ревизия навыка изменилась".into());
                }
                if e.trials.iter().any(|x| {
                    x.session_id == t.session_id && x.message_id == t.message_id
                        || x.phase == t.phase
                            && x.case_id == t.case_id
                            && x.model == t.model
                            && x.engine == t.engine
                }) {
                    return Err("Это испытание уже записано".into());
                }
                e.trials.push(t);
                save(&dir, &e)?;
            }
            "promote" | "rollback" => {
                source(&e.scope, e.directory.as_deref(), &e.path)?;
                promote(&mut e, &dir, action == "rollback")?;
            }
            _ => return Err("Unknown quality action".into()),
        }
        serde_json::to_value(e).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
use serde_json::json;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paired_trials_reject_missing_evidence_and_regressions() {
        let mut e = Experiment {
            id: "x".into(),
            scope: "global".into(),
            directory: None,
            path: "".into(),
            name: "".into(),
            baseline: "a".into(),
            candidate: "b".into(),
            baseline_path: "".into(),
            candidate_path: "".into(),
            trials: vec![],
            state: "candidate".into(),
        };
        assert!(pairs(&e).is_err());
        for n in 0..3 {
            for phase in ["baseline", "candidate"] {
                e.trials.push(Trial {
                    phase: phase.into(),
                    revision: if phase == "baseline" { "a" } else { "b" }.into(),
                    case_id: n.to_string(),
                    engine: "pi".into(),
                    model: "m".into(),
                    session_id: "s".into(),
                    message_id: format!("{n}-{phase}"),
                    skill_read: true,
                    passed: true,
                    wall_ms: 100,
                    tokens: 100,
                    errors: 0,
                });
            }
        }
        assert!(pairs(&e).is_ok());
        let root = std::env::temp_dir().join(format!(
            "arvela-skill-quality-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let live = root.join("live");
        let dir = root.join("trial");
        fs::create_dir_all(&live).unwrap();
        fs::write(live.join("SKILL.md"), "baseline").unwrap();
        fs::write(live.join("helper.py"), "preserve helper").unwrap();
        snapshot(&live, &dir.join("baseline")).unwrap();
        snapshot(&live, &dir.join("candidate")).unwrap();
        fs::write(dir.join("candidate/SKILL.md"), "candidate").unwrap();
        e.path = live.join("SKILL.md").display().to_string();
        e.baseline = revision(&live).unwrap();
        e.candidate = revision(&dir.join("candidate")).unwrap();
        save(&dir, &e).unwrap();
        promote(&mut e, &dir, false).unwrap();
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "candidate");
        // Simulated crash after the file commit, before the final receipt.
        e.state = "promoting".into();
        save(&dir, &e).unwrap();
        promote(&mut e, &dir, false).unwrap();
        assert_eq!(e.state, "promoted");
        promote(&mut e, &dir, true).unwrap();
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "baseline");
        assert_eq!(
            fs::read_to_string(live.join("helper.py")).unwrap(),
            "preserve helper"
        );
        e.state = "candidate".into();
        fs::write(live.join("helper.py"), "user edit").unwrap();
        assert!(promote(&mut e, &dir, false).is_err());
        assert_eq!(
            fs::read_to_string(live.join("helper.py")).unwrap(),
            "user edit"
        );
        fs::remove_dir_all(root).unwrap();

        e.trials.last_mut().unwrap().errors = 1;
        assert!(pairs(&e).is_err());
    }
}
