//! Explicit-profile secret isolation: pure service/account descriptors from
//! the real constructors over an injected in-memory store. No OS vault, no
//! process environment, no owner path; profiles are disposable temp fixtures.
use super::*;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;

const PROVIDER: SecretNamespace = SecretNamespace {
    legacy: "dev.local.opencodedesktop.pi-credentials",
    suffix: "pi-credentials",
};
const HUB: &str = "https://hub.example.test";
const MODEL: &str = "http://127.0.0.1:18008";

/// In-memory vault keyed by (service, account) that records every service used.
#[derive(Default)]
struct Store {
    items: RefCell<BTreeMap<(String, String), String>>,
    touched: RefCell<Vec<String>>,
}
impl Store {
    fn key(&self, service: &str, account: &str) -> (String, String) {
        self.touched.borrow_mut().push(service.to_string());
        (service.to_string(), account.to_string())
    }
    fn get(&self, service: &str, account: &str) -> Option<String> {
        let key = self.key(service, account);
        self.items.borrow().get(&key).cloned()
    }
    fn set(&self, service: &str, account: &str, value: &str) {
        let key = self.key(service, account);
        self.items.borrow_mut().insert(key, value.to_string());
    }
    fn delete(&self, service: &str, account: &str) {
        let key = self.key(service, account);
        self.items.borrow_mut().remove(&key);
    }
}

/// Every non-provider site with identical endpoint / scope / id across profiles.
fn sites() -> Vec<(&'static str, SecretNamespace, String)> {
    let mcp = crate::capabilities::credential_account;
    vec![
        ("hub-device", HUB_SECRETS, crate::hub::device_account(HUB)),
        ("hub-admin", HUB_SECRETS, crate::hub::admin_account(HUB)),
        (
            "mcp-global",
            SHARED_MCP_SECRETS,
            mcp("global", "demo").unwrap(),
        ),
        (
            "mcp-project",
            SHARED_MCP_SECRETS,
            mcp("project-0123456789abcdef", "demo").unwrap(),
        ),
        (
            "image",
            SHARED_MCP_SECRETS,
            mcp(crate::images::MCP_SCOPE, crate::images::MCP_ID).unwrap(),
        ),
        (
            "model-control",
            MODEL_CONTROL_SECRETS,
            crate::model_credentials::account(MODEL).unwrap(),
        ),
    ]
}

/// Canonical temp base (macOS /var is itself a symlink) with a fixture home.
fn fixture(tag: &str) -> (PathBuf, PathBuf) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = std::env::temp_dir();
    #[cfg(not(windows))]
    let temp = fs::canonicalize(temp).unwrap();
    let base = temp.join(format!(
        "enki-profile-isolation-{tag}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(base.join("home")).unwrap();
    (base.clone(), base.join("home"))
}

#[test]
fn shipped_service_and_account_bytes_are_preserved() {
    assert_eq!(
        PROVIDER.service_for(None),
        "dev.local.opencodedesktop.pi-credentials"
    );
    assert_eq!(
        HUB_SECRETS.service_for(None),
        "dev.local.opencodedesktop.hub"
    );
    assert_eq!(
        SHARED_MCP_SECRETS.service_for(None),
        "dev.local.opencodedesktop.shared-mcp"
    );
    assert_eq!(
        MODEL_CONTROL_SECRETS.service_for(None),
        "dev.local.opencodedesktop.model-control"
    );
    // Known SHA-256("abc") vector: one full lowercase hash of the root bytes.
    let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert_eq!(
        PROVIDER.service_for(Some(Path::new("abc"))),
        format!("dev.enki.profile.{abc}.pi-credentials")
    );
    assert_eq!(
        HUB_SECRETS.service_for(Some(Path::new("abc"))),
        format!("dev.enki.profile.{abc}.hub")
    );
    let accounts: Vec<String> = sites().into_iter().map(|(_, _, account)| account).collect();
    assert_eq!(
        accounts,
        [
            "https://hub.example.test",
            "https://hub.example.test#model-admin",
            "global/demo",
            "project-0123456789abcdef/demo",
            "global/enki-images",
            "http://127.0.0.1:18008",
        ]
    );
    assert!(crate::capabilities::credential_account("global", "Bad/Id").is_err());
    assert!(crate::model_credentials::account("http://remote:1").is_err());
}

#[test]
fn profile_a_never_reads_or_changes_owner_or_profile_b_secrets() {
    let (base, home) = fixture("roundtrip");
    let a = validate_profile_root(base.join("profile-a"), &home).unwrap();
    let b = validate_profile_root(base.join("profile-b"), &home).unwrap();
    assert_eq!(
        validate_profile_root(base.join("profile-a/"), &home).unwrap(),
        a
    );
    let store = Store::default();
    let mut namespaces = vec![PROVIDER.service_for(Some(a.as_path()))];
    for (site, ns, account) in sites() {
        let owner = ns.service_for(None);
        let sa = ns
            .service_from(validate_profile_root(base.join("profile-a"), &home).map(Some))
            .unwrap();
        let sb = ns.service_for(Some(b.as_path()));
        assert_eq!(
            sa,
            ns.service_for(Some(a.as_path())),
            "{site}: canonical A must be stable"
        );
        assert!(sa != owner && sb != owner && sa != sb, "{site}");
        if !namespaces.contains(&sa) {
            namespaces.push(sa.clone());
        }
        store.set(&owner, &account, "owner-sentinel");
        store.touched.borrow_mut().clear();
        assert_eq!(store.get(&sa, &account), None, "{site}: no owner fallback");
        store.set(&sa, &account, "profile-a");
        assert_eq!(store.get(&sa, &account).as_deref(), Some("profile-a"));
        assert_eq!(
            store.get(&sb, &account),
            None,
            "{site}: profile B stays absent"
        );
        store.delete(&sa, &account);
        assert_eq!(store.get(&sa, &account), None);
        assert!(
            !store.touched.borrow().contains(&owner),
            "{site}: owner service accessed"
        );
        assert_eq!(
            store.get(&owner, &account).as_deref(),
            Some("owner-sentinel"),
            "{site}"
        );
    }
    // Provider, Hub, shared-MCP and model-control remain four namespaces.
    assert_eq!(namespaces.len(), 4);
    fs::remove_dir_all(&base).unwrap();
}

#[test]
fn hub_accounts_share_one_service_and_images_alias_mcp_only_within_one_profile() {
    let (base, home) = fixture("alias");
    let a = validate_profile_root(base.join("profile-a"), &home).unwrap();
    let b = validate_profile_root(base.join("profile-b"), &home).unwrap();
    let store = Store::default();
    let hub = HUB_SECRETS.service_for(Some(a.as_path()));
    store.set(&hub, &crate::hub::device_account(HUB), "device");
    store.set(&hub, &crate::hub::admin_account(HUB), "admin");
    assert_eq!(store.get(&hub, HUB).as_deref(), Some("device"));
    assert_eq!(
        store.get(&hub, &format!("{HUB}#model-admin")).as_deref(),
        Some("admin")
    );
    let mcp = crate::capabilities::credential_account("global", "enki-images").unwrap();
    let image =
        crate::capabilities::credential_account(crate::images::MCP_SCOPE, crate::images::MCP_ID)
            .unwrap();
    store.set(
        &SHARED_MCP_SECRETS.service_for(Some(a.as_path())),
        &mcp,
        "image-key-a",
    );
    assert_eq!(
        store
            .get(&SHARED_MCP_SECRETS.service_for(Some(a.as_path())), &image)
            .as_deref(),
        Some("image-key-a")
    );
    assert_eq!(
        store.get(&SHARED_MCP_SECRETS.service_for(Some(b.as_path())), &image),
        None
    );
    assert_eq!(
        store.get(&SHARED_MCP_SECRETS.service_for(None), &image),
        None
    );
    fs::remove_dir_all(&base).unwrap();
}

#[test]
fn invalid_profiles_fail_closed_instead_of_using_the_default_service() {
    let (base, home) = fixture("invalid");
    fs::write(base.join("file"), "x").unwrap();
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut invalid = vec![
        PathBuf::from("relative/profile"),
        base.join("profile/../escape"),
        home.clone(),
        base.join("file/profile"),
    ];
    #[cfg(unix)]
    {
        fs::create_dir_all(base.join("real")).unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).unwrap();
        invalid.push(base.join("link/profile"));
    }
    for raw in invalid {
        let resolved = validate_profile_root(raw.clone(), &home);
        assert!(resolved.is_err(), "{raw:?}");
        for ns in [
            PROVIDER,
            HUB_SECRETS,
            SHARED_MCP_SECRETS,
            MODEL_CONTROL_SECRETS,
        ] {
            assert!(
                ns.service_from(resolved.clone().map(Some)).is_err(),
                "{raw:?}"
            );
        }
    }
    assert!(!base.join("real/profile").exists() && !base.join("escape").exists());
    fs::remove_dir_all(&base).unwrap();
}
