// src/state.rs

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tera::Tera;

#[derive(Clone, Debug, Default, Serialize)]
pub struct Item {
    pub id: u64,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct AppState {
    pub templates: Tera,
    pub items: Arc<Mutex<Vec<Item>>>,
    pub next_id: Arc<Mutex<u64>>,
}

impl AppState {
    pub fn new() -> Self {
        let mut tera = Tera::default();
        tera.load_from_glob("templates/**/*.html")
            .expect("Unable to load the Tera templates.");

        Self {
            templates: tera,
            items: Arc::new(Mutex::new(Vec::new())),
            next_id: Arc::new(Mutex::new(0)),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
