use zeroize::Zeroizing;

use super::{SecretError, SecretStore};

const SERVICE_NAME: &str = "com.aivirtualassistant.desktop";

pub struct WindowsSecretStore;

impl WindowsSecretStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(reference: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(SERVICE_NAME, reference).map_err(|_| SecretError::Backend)
    }
}

impl Default for WindowsSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for WindowsSecretStore {
    fn set(&self, reference: &str, value: &str) -> Result<(), SecretError> {
        Self::entry(reference)?
            .set_password(value)
            .map_err(|_| SecretError::Backend)
    }

    fn get(&self, reference: &str) -> Result<Option<Zeroizing<String>>, SecretError> {
        match Self::entry(reference)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(SecretError::Backend),
        }
    }

    fn delete(&self, reference: &str) -> Result<bool, SecretError> {
        match Self::entry(reference)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(SecretError::Backend),
        }
    }

    fn contains(&self, reference: &str) -> Result<bool, SecretError> {
        Ok(self.get(reference)?.is_some())
    }
}
