pub mod builds;
pub mod containers;
pub mod engines;
pub mod exec;
pub mod images;
pub mod networks;
pub mod system;
pub mod volumes;

use std::collections::HashMap;

pub fn filters(pairs: &[(&str, &str)]) -> HashMap<String, Vec<String>> {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    for (k, v) in pairs {
        m.entry(k.to_string()).or_default().push(v.to_string());
    }
    m
}
