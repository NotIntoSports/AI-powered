use std::{collections::HashMap, sync::Mutex};

use zeroize::{Zeroize, Zeroizing};

use super::{SecretError, SecretStore};

#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, Zeroizing<String>>>,
}

impl SecretStore for MemorySecretStore {
    fn set(&self, reference: &str, value: &str) -> Result<(), SecretError> {
        let mut values = self.values.lock().map_err(|_| SecretError::Backend)?;
        if let Some(mut previous) =
            values.insert(reference.to_owned(), Zeroizing::new(value.to_owned()))
        {
            previous.zeroize();
        }
        Ok(())
    }

    fn get(&self, reference: &str) -> Result<Option<Zeroizing<String>>, SecretError> {
        let values = self.values.lock().map_err(|_| SecretError::Backend)?;
        Ok(values
            .get(reference)
            .map(|value| Zeroizing::new(value.to_string())))
    }

    fn delete(&self, reference: &str) -> Result<bool, SecretError> {
        let mut values = self.values.lock().map_err(|_| SecretError::Backend)?;
        Ok(values.remove(reference).is_some())
    }

    fn contains(&self, reference: &str) -> Result<bool, SecretError> {
        let values = self.values.lock().map_err(|_| SecretError::Backend)?;
        Ok(values.contains_key(reference))
    }
}
