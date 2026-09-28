//! OS-backed credential operations used by the desktop companion.
//! Callers pass opaque account IDs; secret values and backend errors are never logged.

const SERVICE: &str = "com.locallab.provider-secrets";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretError {
    InvalidAccount,
    StoreUnavailable,
}

pub fn get(account: &str) -> Result<Option<String>, SecretError> {
    let entry = entry(account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(SecretError::StoreUnavailable),
    }
}

pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
    entry(account)?
        .set_password(secret)
        .map_err(|_| SecretError::StoreUnavailable)
}

pub fn delete(account: &str) -> Result<(), SecretError> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(SecretError::StoreUnavailable),
    }
}

fn entry(account: &str) -> Result<keyring::Entry, SecretError> {
    if account.is_empty()
        || account.len() > 160
        || !account
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
    {
        return Err(SecretError::InvalidAccount);
    }
    keyring::Entry::new(SERVICE, account).map_err(|_| SecretError::StoreUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_ids_reject_header_values_and_paths() {
        assert!(matches!(
            entry("Bearer secret"),
            Err(SecretError::InvalidAccount)
        ));
        assert!(matches!(
            entry("../../credential"),
            Err(SecretError::InvalidAccount)
        ));
        assert!(matches!(entry("opaque-ref-0001"), Ok(_)));
    }
}
