//! An unacknowledged token replacement remains the SAME operation in memory.
//! Never serialize or log this authority, or replace it with a fresh rotation.
pub(super) struct PendingRotation {
    id: String,
    token: String,
}

impl PendingRotation {
    pub(super) fn new(id: String, token: String) -> Self {
        Self { id, token }
    }

    pub(super) fn resolve(
        self,
        send: impl FnOnce(&str, &str) -> Result<(), String>,
    ) -> Result<String, (Self, String)> {
        match send(&self.id, &self.token) {
            Ok(()) => Ok(self.token),
            Err(error) => Err((self, error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lost_ack_recovers_same_authority_after_old_token_expires() {
        let mut installed = String::from("old");
        let mut installs = 0;
        let mut receipt = None;
        let pending = PendingRotation::new("request-1".into(), "new".into());
        let Err((pending, _)) = pending.resolve(|id, token| {
            installed = token.into();
            installs += 1;
            receipt = Some((id.to_string(), token.to_string()));
            Err("ACK lost".into())
        }) else {
            panic!("unconfirmed token must not be published")
        };
        // Another transport failure must keep the exact receipt query, even
        // after the old bearer has stopped working. No runtime restart needed.
        let Err((pending, _)) = pending.resolve(|_, _| Err("pipe busy".into())) else {
            panic!("pending authority was discarded")
        };
        let Ok(published) = pending.resolve(|id, token| {
            assert_eq!(receipt.as_ref(), Some(&(id.into(), token.into())));
            assert_eq!(installed, token);
            Ok(())
        }) else {
            panic!("receipt should settle")
        };
        assert_eq!(published, installed);
        assert_eq!(installs, 1);
    }

    #[test]
    fn not_sent_operation_can_be_installed_once_on_reconnect() {
        let pending = PendingRotation::new("request-2".into(), "new".into());
        let Err((pending, _)) = pending.resolve(|_, _| Err("not sent".into())) else {
            panic!("unconfirmed token must remain pending")
        };
        let mut installs = 0;
        let Ok(token) = pending.resolve(|id, token| {
            assert_eq!(id, "request-2");
            assert_eq!(token, "new");
            installs += 1;
            Ok(())
        }) else {
            panic!("retry should succeed")
        };
        assert_eq!(token, "new");
        assert_eq!(installs, 1);
    }
}
